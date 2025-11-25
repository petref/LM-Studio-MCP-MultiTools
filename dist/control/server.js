// src/control/server.ts
// -------------------------------------------------------------
// Dashboard + LM Studio bridge with:
// - SSE streaming
// - Heartbeats
// - Buffered trimming
// - repo_browser.print_tree
// - repo_browser.read_file
// - repo_browser.apply_patch  -> routed to /mcp/apply_patch
// - Strict structured-tool parsing
// -------------------------------------------------------------
import "dotenv/config";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { initRuntime, getRuntime } from "../runtime/index.js";
import { TextDecoder } from "node:util";
import { attachMCPToServer } from "../mcp/server.js";
// -------------------------------------------------------------
// CONSTANTS
// -------------------------------------------------------------
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const MAX_TREE_DEPTH = 4;
const HEARTBEAT_MS = 1200;
const MAX_MODEL_CHARS = 32000;
// -------------------------------------------------------------
// LM Studio endpoint
// -------------------------------------------------------------
const LM_URL = process.env.LMSTUDIO_URL || "http://localhost:1234/v1/chat/completions";
// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function json(res, obj, code = 200) {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
}
async function withinRoot(rel) {
    const root = path.resolve(getRuntime().rootDir || ".");
    const abs = path.resolve(root, rel || ".");
    if (!abs.startsWith(root))
        throw new Error("Path escapes project root");
    return abs;
}
// Recursively list files/directories
async function listTree(rel, depth = 0) {
    if (depth > MAX_TREE_DEPTH)
        return { name: rel, type: "max-depth" };
    const abs = await withinRoot(rel);
    const st = await fs.stat(abs);
    if (!st.isDirectory()) {
        return {
            name: rel,
            type: "file"
        };
    }
    const entries = await fs.readdir(abs);
    const children = [];
    for (const e of entries) {
        const childRel = rel ? path.join(rel, e) : e;
        const absChild = path.join(abs, e);
        const stChild = await fs.stat(absChild);
        if (stChild.isDirectory()) {
            children.push(await listTree(childRel, depth + 1));
        }
        else {
            children.push({
                name: childRel,
                type: "file"
            });
        }
    }
    return {
        name: rel,
        type: "dir",
        children
    };
}
// Safely read file
async function readFileSafe(rel) {
    const abs = await withinRoot(rel);
    try {
        const data = await fs.readFile(abs, "utf8");
        return data;
    }
    catch {
        return null;
    }
}
// Trim a too-large conversation
function trimMessages(msgs) {
    let out = [...msgs];
    let totalChars = out.reduce((acc, m) => acc + JSON.stringify(m).length, 0);
    while (totalChars > MAX_MODEL_CHARS && out.length > 1) {
        out.shift(); // drop oldest
        totalChars = out.reduce((acc, m) => acc + JSON.stringify(m).length, 0);
    }
    return out;
}
// Extract structured tool call from model output
function extractToolCall(delta) {
    if (!delta?.tool_calls)
        return null;
    // LM Studio normally emits something like:
    //   "tool_calls": [
    //      { "id": "call_1", "type": "function", "function": { "name": "repo_browser.print_tree", "arguments": "{...}" } }
    //   ]
    const tc = delta.tool_calls[0];
    if (!tc)
        return null;
    const name = tc.function?.name;
    const argsRaw = tc.function?.arguments;
    if (!name || !argsRaw)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(argsRaw);
    }
    catch {
        return null;
    }
    return {
        name,
        args: parsed
    };
}
// -------------------------------------------------------------
// CHAT ROUTE  (SSE)
// -------------------------------------------------------------
async function handleChat(req, res) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
        try {
            const payload = JSON.parse(body);
            const messages = trimMessages(payload.messages || []);
            // Prepare SSE response stream
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            const heartbeat = setInterval(() => {
                res.write("event: heartbeat\n");
                res.write("data: {}\n\n");
            }, HEARTBEAT_MS);
            // Start LM Studio streaming
            const resp = await fetch(LM_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: payload.model || "default",
                    stream: true,
                    messages
                })
            });
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let toolCallDetected = false;
            async function handleTool(toolName, args) {
                // route to internal MCP endpoint
                if (toolName === "repo_browser.print_tree") {
                    const tree = await listTree(args.path || "");
                    res.write(`event: tool_result\n`);
                    res.write(`data: ${JSON.stringify({ tool: toolName, result: tree })}\n\n`);
                    return true;
                }
                if (toolName === "repo_browser.read_file") {
                    const data = await readFileSafe(args.path || "");
                    res.write(`event: tool_result\n`);
                    res.write(`data: ${JSON.stringify({ tool: toolName, result: data })}\n\n`);
                    return true;
                }
                if (toolName === "repo_browser.apply_patch") {
                    // forward patch to MCP engine
                    const resp = await fetch("http://localhost:" + PORT + "/mcp/apply_patch", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ patch: args.patch })
                    });
                    const r = await resp.json();
                    res.write(`event: tool_result\n`);
                    res.write(`data: ${JSON.stringify({ tool: toolName, result: r })}\n\n`);
                    return true;
                }
                // Unknown tool
                res.write(`event: tool_result\n`);
                res.write(`data: ${JSON.stringify({ tool: toolName, error: "Unknown tool" })}\n\n`);
                return true;
            }
            // Stream chunks
            while (true) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                const chunk = decoder.decode(value);
                const lines = chunk.split("\n");
                for (let raw of lines) {
                    let ln = raw.trim();
                    if (!ln.startsWith("data:"))
                        continue;
                    const jsonPart = ln.slice(5).trim();
                    if (jsonPart === "[DONE]")
                        continue;
                    let deltaObj;
                    try {
                        deltaObj = JSON.parse(jsonPart);
                    }
                    catch {
                        continue;
                    }
                    const delta = deltaObj.choices?.[0]?.delta;
                    // Check for tool call
                    const extracted = extractToolCall(delta);
                    if (extracted && !toolCallDetected) {
                        toolCallDetected = true;
                        await handleTool(extracted.name, extracted.args);
                        continue; // do not emit delta text for tool calls
                    }
                    // Normal text
                    if (delta?.content) {
                        res.write("event: message\n");
                        res.write(`data: ${JSON.stringify({ text: delta.content })}\n\n`);
                    }
                }
            }
            clearInterval(heartbeat);
            res.end();
        }
        catch (e) {
            json(res, { error: e.message }, 500);
        }
    });
}
// -------------------------------------------------------------
// MAIN HTTP SERVER
// -------------------------------------------------------------
await initRuntime();
const server = createServer((req, res) => {
    // Chat route
    if (req.method === "POST" && req.url === "/chat") {
        return handleChat(req, res);
    }
    // MCP patch endpoint - handled by attachMCPToServer
    if (req.method === "POST" && req.url === "/mcp/apply_patch") {
        // Do NOT respond here – attachMCPToServer(server) will.
        return;
    }
    // Basic health check
    if (req.method === "GET" && req.url === "/healthz") {
        return json(res, { ok: true });
    }
    // Fallback
    res.statusCode = 404;
    res.end("Not Found");
});
// Attach MCP tools to same server instance
attachMCPToServer(server);
// Start server
server.listen(PORT, () => {
    console.log(`[dashboard] running at http://localhost:${PORT}`);
});
