// src/control/server.ts
import "dotenv/config";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { initRuntime, getRuntime, saveRuntime } from "../runtime/index.js";
import { TextDecoder } from "node:util";
import { attachMCPToServer } from "../mcp/server.js";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- Constants ----------------
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const MAX_TREE_DEPTH = 4;
const MAX_ENTRIES_PER_DIR = 200;
const HEARTBEAT_MS = 15000;
const MAX_MODEL_CHARS = 32000;
const MAX_TOOL_DEPTH = 30;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".next",
  "Lib",
  ".cache",
  "Scripts",
]);

const LM_BASE = (process.env.LMSTUDIO_API_BASE || "http://localhost:1234/v1").replace(/\/+$/, "");
const LM_CHAT_URL = `${LM_BASE}/chat/completions`;
const LM_MAX_RETRIES = 5;

const DASHBOARD_BASE =
  process.env.DASHBOARD_BASE?.replace(/\/+$/, "") || `http://localhost:${PORT}`;

const longLMAgent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 0,
});

// ---------------- Helpers ----------------
function json(res: any, obj: any, code = 200) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req: any): Promise<any> {
  return await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c: any) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Normalize what user types in UI:
// - if they type "http://host:1234/v1" => use ".../v1/chat/completions"
// - if they already type ".../chat/completions" => keep it
function normalizeApiBase(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return LM_CHAT_URL;

  const noTrail = raw.replace(/\/+$/, "");
  if (noTrail.endsWith("/chat/completions")) return noTrail;
  if (noTrail.endsWith("/v1")) return `${noTrail}/chat/completions`;

  // if they typed ".../v1/" or ".../v1/chat" etc, just fall back
  return noTrail;
}

// ---------------- Single source of truth: dashboardState ----------------
type DashboardState = {
  apiBase: string;       // normalized to chat/completions URL
  model?: string;
  rootDir: string;       // workspace root
  mcpEnabled: boolean;
};

let dashboardState: DashboardState = {
  apiBase: normalizeApiBase(getRuntime().apiBase || LM_BASE), // normalize later anyway
  model: getRuntime().model,
  rootDir: getRuntime().rootDir || ".",
  mcpEnabled: getRuntime().mcpEnabled !== false,
};

// Tracks currently running LM request so /abort can cancel it
let activeLmAbortController: AbortController | null = null;

function getWorkspaceRoot(): string {
  // Single source of truth for filesystem root:
  // dashboardState.rootDir (UI) -> runtime.json -> env -> cwd
  const st = dashboardState?.rootDir;
  const rt = getRuntime().rootDir;
  return path.resolve(st || rt || process.env.MCP_ROOT_DIR || process.cwd());
}

async function withinRoot(relPath: string): Promise<string> {
  const ROOT = getWorkspaceRoot();
  const rel = relPath && relPath.trim() ? relPath : ".";
  const abs = path.resolve(ROOT, rel);

  const rootNorm = path.normalize(ROOT).toLowerCase();
  const absNorm = path.normalize(abs).toLowerCase();

  if (!absNorm.startsWith(rootNorm)) {
    throw new Error(`Path escapes project root: rel="${relPath}", root="${ROOT}"`);
  }
  return abs;
}

async function readFileSafe(rel: string) {
  const abs = await withinRoot(rel);
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

async function writeFileSafe(rel: string, content: string) {
  const abs = await withinRoot(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content ?? "", "utf8");
}

async function listTree(rel: string, depth = 0): Promise<any> {
  if (depth > MAX_TREE_DEPTH) return { name: rel, type: "max-depth" };

  const abs = await withinRoot(rel);
  const st = await fs.stat(abs);

  if (!st.isDirectory()) return { name: rel, type: "file" };

  let entries = await fs.readdir(abs, { withFileTypes: true });
  entries = entries.filter((e) => !IGNORED_DIRS.has(e.name));
  if (entries.length > MAX_ENTRIES_PER_DIR) entries = entries.slice(0, MAX_ENTRIES_PER_DIR);

  const children: any[] = [];
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) children.push(await listTree(childRel, depth + 1));
    else children.push({ name: childRel, type: "file" });
  }

  return { name: rel, type: "dir", children };
}

function trimMessages(msgs: any[]): any[] {
  let out = [...msgs];
  let totalChars = out.reduce((acc, m) => acc + JSON.stringify(m).length, 0);
  while (totalChars > MAX_MODEL_CHARS && out.length > 1) {
    out.shift();
    totalChars = out.reduce((acc, m) => acc + JSON.stringify(m).length, 0);
  }
  return out;
}

// ---------------- System prompt (kept minimal here) ----------------
function buildSystemPrompt(currentRoot: string) {
  return `
You are a coding agent running inside an MCP environment.

Workspace root is: "${currentRoot}"

TOOLS:
- repo_browser.print_tree(path: string)
- repo_browser.read_file(path: string)
- repo_browser.apply_patch(patch: string)
- repo_browser.create_directory(path: string)
- repo_browser.create_file(path: string, content: string)
- repo_browser.rewrite_file(path: string, content: string)
`.trim();
}

// ---------------- Tool executor ----------------
type ToolExecutor = (toolName: string, args: any) => Promise<any>;

function startHeartbeat(res: any): NodeJS.Timeout {
  return setInterval(() => {
    try {
      res.write("event: heartbeat\n");
      res.write('data: { "keepalive": true }\n\n');
    } catch {
      // ignore
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat(timer: NodeJS.Timeout | null) {
  if (!timer) return;
  clearInterval(timer);
}

function createExecuteTool(res: any): ToolExecutor {
  return async (toolName: string, args: any) => {
    if (!toolName) {
      const err = { error: "Missing tool name" };
      res.write("event: tool_result\n");
      res.write(`data: ${JSON.stringify({ tool: toolName || "unknown", result: err })}\n\n`);
      return err;
    }

    if (toolName === "repo_browser.print_tree") {
      const tree = await listTree(args.path || "");
      res.write("event: tool_result\n");
      res.write(`data: ${JSON.stringify({ tool: toolName, result: tree })}\n\n`);
      return tree;
    }

    if (toolName === "repo_browser.read_file") {
      const data = await readFileSafe(args.path || "");
      res.write("event: tool_result\n");
      res.write(`data: ${JSON.stringify({ tool: toolName, result: data })}\n\n`);
      return data;
    }

    if (toolName === "repo_browser.create_directory") {
      const relPath = args.path || "";
      const abs = await withinRoot(relPath);
      await fs.mkdir(abs, { recursive: true });
      const result = { ok: true, created: relPath };
      res.write("event: tool_result\n");
      res.write(`data: ${JSON.stringify({ tool: toolName, result })}\n\n`);
      return result;
    }

    if (toolName === "repo_browser.create_file") {
      const relPath = args.path || "";
      const content = typeof args.content === "string" ? args.content : "";
      await writeFileSafe(relPath, content);
      const result = { ok: true, path: relPath, bytes: Buffer.byteLength(content, "utf8") };
      res.write("event: tool_result\n");
      res.write(`data: ${JSON.stringify({ tool: toolName, result })}\n\n`);
      return result;
    }

    if (toolName === "repo_browser.apply_patch") {
      try {
        const url = `${DASHBOARD_BASE}/mcp/apply_patch`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: args.patch }),
          // @ts-ignore
          dispatcher: longLMAgent,
        }).then((x) => x.json());

        res.write("event: tool_result\n");
        res.write(`data: ${JSON.stringify({ tool: toolName, result: r })}\n\n`);
        return r;
      } catch (e: any) {
        const err = { error: "Failed to call /mcp/apply_patch", detail: String(e?.message || e) };
        res.write("event: tool_result\n");
        res.write(`data: ${JSON.stringify({ tool: toolName, result: err })}\n\n`);
        return err;
      }
    }

    if (toolName === "repo_browser.rewrite_file") {
      try {
        const url = `${DASHBOARD_BASE}/mcp/rewrite_file`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: args.path, content: args.content }),
          // @ts-ignore
          dispatcher: longLMAgent,
        }).then((x) => x.json());

        res.write("event: tool_result\n");
        res.write(`data: ${JSON.stringify({ tool: toolName, result: r })}\n\n`);
        return r;
      } catch (e: any) {
        const err = { error: "Failed to call /mcp/rewrite_file", detail: String(e?.message || e) };
        res.write("event: tool_result\n");
        res.write(`data: ${JSON.stringify({ tool: toolName, result: err })}\n\n`);
        return err;
      }
    }

    const errUnknown = { error: "Unknown tool" };
    res.write("event: tool_result\n");
    res.write(`data: ${JSON.stringify({ tool: toolName, result: errUnknown })}\n\n`);
    return errUnknown;
  };
}

// ---------------- Chat loop (same architecture you had) ----------------
type ChatPayload = {
  model?: string;
  messages: any[];
  temperature?: number;
  stream?: boolean;
};

type ChatContext = {
  res: any;
  lmAbort: AbortController;
  effectiveModel: string;
  payload: ChatPayload;
  toolsPayload: any;
  executeTool: ToolExecutor;
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "repo_browser.read_file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_browser.create_directory",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_browser.create_file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_browser.apply_patch",
      parameters: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_browser.rewrite_file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_browser.print_tree",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

async function runChatWithTools(ctx: ChatContext, messages: any[], depth = 0): Promise<void> {
  const { res, lmAbort, effectiveModel, payload, toolsPayload, executeTool } = ctx;

  if (depth > MAX_TOOL_DEPTH) {
    res.write("event: error\n");
    res.write(`data: ${JSON.stringify({ message: "Too many tool-call rounds, aborting." })}\n\n`);
    return;
  }

  const lmUrl = dashboardState.apiBase || LM_CHAT_URL;

  let resp: any;
  for (let attempt = 1; attempt <= LM_MAX_RETRIES; attempt++) {
    try {
      resp = await fetch(lmUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: effectiveModel,
          stream: true,
          messages,
          temperature: payload.temperature ?? 0.2,
          ...toolsPayload,
        }),
        // @ts-ignore
        dispatcher: longLMAgent,
        signal: lmAbort.signal,
      });

      if (resp.ok && resp.body) break;
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
    }
  }

  if (!resp || !resp.ok || !resp.body) {
    res.write("event: error\n");
    res.write(`data: ${JSON.stringify({ message: "Upstream LM fetch failed" })}\n\n`);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();

  const toolBuffers: any[] = [];
  let sawToolCalls = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");

    for (const raw of lines) {
      const ln = raw.trim();
      if (!ln.startsWith("data:")) continue;

      const jsonPart = ln.slice(5).trim();
      if (!jsonPart || jsonPart === "[DONE]") continue;

      let deltaObj: any;
      try {
        deltaObj = JSON.parse(jsonPart);
      } catch {
        continue;
      }

      const choice = deltaObj.choices?.[0];
      const delta = choice?.delta || {};
      const finishReason = choice?.finish_reason;

      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        sawToolCalls = true;

        for (const tc of delta.tool_calls) {
          const idx = (tc as any).index ?? 0;
          if (!toolBuffers[idx]) {
            toolBuffers[idx] = { id: tc.id || undefined, type: "function", function: { name: "", arguments: "" } };
          }
          const buf = toolBuffers[idx];
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.function.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") buf.function.arguments += tc.function.arguments;
        }

        if (finishReason === "tool_calls") {
          // handled after stream ends
        }
        continue;
      }

      if (delta.content) {
        const content = Array.isArray(delta.content)
          ? delta.content.map((c: any) => (typeof c === "string" ? c : c.text || "")).join("")
          : delta.content;

        if (content) {
          res.write("event: message\n");
          res.write(`data: ${JSON.stringify({ role: "assistant", text: content })}\n\n`);
        }
      }
    }
  }

  if (sawToolCalls && toolBuffers.length > 0) {
    const toolCallsForMsg: any[] = [];
    const toolResultMessages: any[] = [];

    for (let i = 0; i < toolBuffers.length; i++) {
      const buf = toolBuffers[i];
      if (!buf?.function?.name) continue;

      let parsedArgs: any;
      try {
        parsedArgs = JSON.parse(buf.function.arguments || "{}");
      } catch {
        parsedArgs = {};
      }

      const id = buf.id || `tool_call_${i}`;
      const name = buf.function.name;
      const result = await executeTool(name, parsedArgs);

      toolCallsForMsg.push({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(parsedArgs) },
      });

      toolResultMessages.push({
        role: "tool",
        tool_call_id: id,
        name,
        content: JSON.stringify(result),
      });
    }

    if (toolCallsForMsg.length > 0) {
      const assistantToolMessage = { role: "assistant", tool_calls: toolCallsForMsg };
      const nextMessages = [...messages, assistantToolMessage, ...toolResultMessages];
      await runChatWithTools(ctx, nextMessages, depth + 1);
    }
  }
}

function buildBaseMessages(userMessages: any[], currentRoot: string) {
  return trimMessages([{ role: "system", content: buildSystemPrompt(currentRoot) }, ...userMessages]);
}

async function handleChat(req: any, res: any) {
  const lmAbort = new AbortController();
  activeLmAbortController = lmAbort;

  res.on("close", () => {
    try {
      lmAbort.abort();
    } catch { }
  });

  let heartbeat: NodeJS.Timeout | null = null;

  try {
    const payload: ChatPayload = await readJsonBody(req);
    const userMessages = payload.messages || [];

    const currentRoot = getWorkspaceRoot();
    const baseMessages = buildBaseMessages(userMessages, currentRoot);

    const effectiveModel = payload.model || dashboardState.model || "default";

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.setTimeout(0);

    heartbeat = startHeartbeat(res);

    const mcpEnabled = dashboardState.mcpEnabled !== false;
    const toolsPayload = mcpEnabled ? { tools: TOOLS, tool_choice: "auto" as const } : {};

    const executeTool = createExecuteTool(res);

    const ctx: ChatContext = {
      res,
      lmAbort,
      effectiveModel,
      payload,
      toolsPayload,
      executeTool,
    };

    await runChatWithTools(ctx, baseMessages);

    stopHeartbeat(heartbeat);
    activeLmAbortController = null;
    res.end();
  } catch (e: any) {
    activeLmAbortController = null;
    stopHeartbeat(heartbeat);

    if (e?.name === "AbortError") {
      try { res.end(); } catch { }
      return;
    }

    try {
      res.write("event: error\n");
      res.write(`data: ${JSON.stringify({ message: e?.message || "Internal error" })}\n\n`);
      res.end();
    } catch {
      // ignore
    }
  }
}

// ---------------- MAIN ----------------
await initRuntime();

// Ensure initial normalization after runtime loaded
dashboardState = {
  ...dashboardState,
  apiBase: normalizeApiBase(getRuntime().apiBase || dashboardState.apiBase),
  model: getRuntime().model || dashboardState.model,
  rootDir: getRuntime().rootDir || dashboardState.rootDir || ".",
  mcpEnabled: getRuntime().mcpEnabled !== false,
};

const server = createServer(async (req, res) => {
  // Let MCP handler own these endpoints
  if (req.url === "/mcp/apply_patch" || req.url === "/mcp/rewrite_file") return;

  // ---- STATE API ----
  if (req.url === "/state" && req.method === "GET") {
    return json(res, dashboardState);
  }

  if (req.url === "/state" && req.method === "POST") {
    try {
      const patch = await readJsonBody(req);

      // normalize apiBase if user typed base
      const nextApiBase = normalizeApiBase(patch.apiBase ?? dashboardState.apiBase);

      dashboardState = {
        ...dashboardState,
        ...patch,
        apiBase: nextApiBase,
      };

      await saveRuntime({
        apiBase: dashboardState.apiBase,
        model: dashboardState.model,
        rootDir: dashboardState.rootDir,
        mcpEnabled: dashboardState.mcpEnabled,
      });

      return json(res, dashboardState);
    } catch (e: any) {
      return json(res, { error: e?.message || String(e) }, 400);
    }
  }

  // ---- MODELS ----
  if (req.url === "/models" && req.method === "GET") {
    try {
      const modelsUrl = `${LM_BASE}/models`;
      const r = await fetch(modelsUrl);
      const data = await r.json();
      return json(res, data);
    } catch (e: any) {
      return json(res, { data: [], error: String(e) }, 500);
    }
  }

  // ---- FS (editor) ----
  if (req.url === "/fs/read" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const p = String(body?.path || "");
      const content = await readFileSafe(p);
      return json(res, { ok: content !== null, content });
    } catch (e: any) {
      return json(res, { ok: false, error: e?.message || String(e) }, 400);
    }
  }

  if (req.url === "/fs/write" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const p = String(body?.path || "");
      const c = typeof body?.content === "string" ? body.content : "";
      await writeFileSafe(p, c);
      return json(res, { ok: true });
    } catch (e: any) {
      return json(res, { ok: false, error: e?.message || String(e) }, 400);
    }
  }

  // ---- Serve dashboard HTML ----
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    try {
      const indexPath = path.join(__dirname, "index.html");
      const html = await fs.readFile(indexPath, "utf8");
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(html);
    } catch (e: any) {
      res.statusCode = 500;
      return res.end("Failed to load dashboard index.html: " + e.message);
    }
  }

  // ---- Abort LM stream ----
  if (req.method === "POST" && req.url === "/abort") {
    if (activeLmAbortController) {
      activeLmAbortController.abort();
      activeLmAbortController = null;
      return json(res, { ok: true, aborted: true });
    }
    return json(res, { ok: true, aborted: false });
  }

  // ---- Chat ----
  if (req.method === "POST" && req.url === "/chat") {
    return handleChat(req, res);
  }

  // ---- Health ----
  if (req.method === "GET" && req.url === "/healthz") {
    return json(res, { ok: true });
  }

  // ---- Better 404: JSON for API-ish paths ----
  const url = req.url || "";
  const wantsJson =
    url.startsWith("/state") ||
    url.startsWith("/models") ||
    url.startsWith("/chat") ||
    url.startsWith("/abort") ||
    url.startsWith("/fs/") ||
    url.startsWith("/mcp/");

  if (wantsJson) return json(res, { error: "Not Found", path: url }, 404);

  res.statusCode = 404;
  res.end("Not Found");
});

server.requestTimeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

// Attach MCP tools to same server instance WITH DYNAMIC ROOT
attachMCPToServer(server, { getRoot: getWorkspaceRoot });

server.listen(PORT, () => {
  console.log(`[dashboard] running at http://localhost:${PORT}`);
  console.log(`LM Studio base: ${LM_BASE}`);
  console.log(`Workspace root: ${getWorkspaceRoot()}`);
});
