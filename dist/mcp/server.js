// src/mcp/server.ts
// --------------------------------------------------------------------
// MCP Patch Engine
// Supports:
//   - Add File
//   - Update File (diff hunks)
//   - Delete File
//   - Multi-hunk, multi-range patching
//   - Context lines
//   - Safe root enforcement
//   - JSON HTTP API POST /mcp/apply_patch
// --------------------------------------------------------------------
import { promises as fs } from "node:fs";
import path from "node:path";
import { getRuntime } from "../runtime/index.js";
// ===============================================================
// Root-safe path resolution
// ===============================================================
export async function withinRoot(relPath) {
    const root = path.resolve(getRuntime().rootDir || ".");
    const abs = path.resolve(root, relPath || ".");
    if (!abs.startsWith(root)) {
        throw new Error(`Refusing to write outside root: ${relPath}`);
    }
    return abs;
}
// ===============================================================
// Parse patch
// ===============================================================
export function parseSimplifiedPatch(raw) {
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    if (!lines[0]?.includes("*** Begin Patch")) {
        throw new Error("Patch missing *** Begin Patch");
    }
    let op = null;
    let filePath = "";
    // detect op
    for (const line of lines) {
        if (line.startsWith("*** Add File:")) {
            op = "add";
            filePath = line.replace("*** Add File:", "").trim();
            break;
        }
        if (line.startsWith("*** Update File:")) {
            op = "update";
            filePath = line.replace("*** Update File:", "").trim();
            break;
        }
        if (line.startsWith("*** Delete File:")) {
            op = "delete";
            filePath = line.replace("*** Delete File:", "").trim();
            break;
        }
    }
    if (!op || !filePath) {
        throw new Error("Patch must contain one of Add/Update/Delete headers");
    }
    // delete = trivial
    if (op === "delete") {
        return { op: "delete", path: filePath, hunks: [] };
    }
    // add-file = collect all +lines
    if (op === "add") {
        const contentLines = [];
        for (const l of lines) {
            if (l.startsWith("+") && !l.startsWith("+++")) {
                contentLines.push(l.slice(1));
            }
        }
        const final = contentLines.join("\n") + (contentLines.length ? "\n" : "");
        return { op: "add", path: filePath, hunks: [], newContent: final };
    }
    // update-file
    const hunkHeader = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/;
    const hunks = [];
    let current = null;
    for (const line of lines) {
        const m = line.match(hunkHeader);
        if (m) {
            // push previous
            if (current)
                hunks.push(current);
            current = {
                oldRange: { start: Number(m[1]), count: Number(m[2]) },
                newRange: { start: Number(m[3]), count: Number(m[4]) },
                lines: []
            };
            continue;
        }
        if (current) {
            // classify
            if (line.startsWith("+") && !line.startsWith("+++")) {
                current.lines.push({ type: "add", text: line.slice(1) });
            }
            else if (line.startsWith("-") && !line.startsWith("---")) {
                current.lines.push({ type: "remove", text: line.slice(1) });
            }
            else if (!line.startsWith("***") && !line.startsWith("@@")) {
                // treat everything else as context
                current.lines.push({ type: "context", text: line });
            }
        }
    }
    if (current)
        hunks.push(current);
    return { op: "update", path: filePath, hunks };
}
// ===============================================================
// Apply patch
// ===============================================================
export async function applyParsedPatch(parsed) {
    const abs = await withinRoot(parsed.path);
    // DELETE
    if (parsed.op === "delete") {
        await fs.unlink(abs).catch(() => { });
        return;
    }
    // ADD
    if (parsed.op === "add") {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, parsed.newContent || "", "utf8");
        return;
    }
    // UPDATE
    let original = "";
    try {
        original = await fs.readFile(abs, "utf8");
    }
    catch {
        throw new Error(`File not found for update: ${parsed.path}`);
    }
    let lines = original.replace(/\r\n/g, "\n").split("\n");
    // apply hunks sequentially
    // note: ranges are 1-based
    for (const h of parsed.hunks) {
        const start = h.oldRange.start - 1;
        // build replacement block
        const replace = [];
        for (const ln of h.lines) {
            if (ln.type === "add" || ln.type === "context") {
                replace.push(ln.text);
            }
        }
        lines.splice(start, h.oldRange.count, ...replace);
    }
    const finalText = lines.join("\n") + "\n";
    await fs.writeFile(abs, finalText, "utf8");
}
// ===============================================================
// HTTP API
// ===============================================================
export function attachMCPToServer(server) {
    server.on("request", async (req, res) => {
        if (req.method !== "POST")
            return;
        if (req.url !== "/mcp/apply_patch")
            return;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
            try {
                const { patch } = JSON.parse(body);
                const parsed = parseSimplifiedPatch(patch);
                await applyParsedPatch(parsed);
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, path: parsed.path, op: parsed.op }));
            }
            catch (e) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    });
}
