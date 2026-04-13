// src/mcp/server.ts
// --------------------------------------------------------------------
// MCP Patch Engine (HTTP endpoints)
//   POST /mcp/apply_patch
//   POST /mcp/rewrite_file
//
// IMPORTANT CHANGE:
// - Root is no longer a module-level constant.
// - Root is resolved dynamically per request using getRoot() so it stays
//   in sync with dashboard runtime/rootDir changes.
// --------------------------------------------------------------------
import { promises as fs } from "node:fs";
import path from "node:path";
// ===============================================================
// Root-safe path resolution (dynamic-root)
// ===============================================================
function defaultGetRoot() {
    return path.resolve(process.env.MCP_ROOT_DIR || process.cwd());
}
async function withinRoot(getRoot, relPath) {
    const ROOT = path.resolve(getRoot());
    const rel = relPath && relPath.trim() ? relPath : ".";
    const abs = path.resolve(ROOT, rel);
    const rootNorm = path.normalize(ROOT);
    const absNorm = path.normalize(abs);
    const rootCmp = process.platform === "win32" ? rootNorm.toLowerCase() : rootNorm;
    const absCmp = process.platform === "win32" ? absNorm.toLowerCase() : absNorm;
    const relFromRoot = path.relative(rootCmp, absCmp);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
        throw new Error(`Refusing to write outside root. rel="${relPath}", root="${ROOT}"`);
    }
    return abs;
}
// ===============================================================
// Parse patch
// ===============================================================
export function parseSimplifiedPatch(raw) {
    const normalized = raw.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    if (!lines[0]?.includes("*** Begin Patch")) {
        throw new Error("Patch missing *** Begin Patch");
    }
    let op = null;
    let filePath = "";
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
    if (op === "delete") {
        return { op: "delete", path: filePath, hunks: [] };
    }
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
    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
    const hunks = [];
    let current = null;
    for (const line of lines) {
        const m = line.match(hunkHeader);
        if (m) {
            if (current)
                hunks.push(current);
            current = {
                oldRange: { start: Number(m[1]), count: Number(m[2] || "1") },
                newRange: { start: Number(m[3]), count: Number(m[4] || "1") },
                lines: [],
            };
            continue;
        }
        if (current) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
                current.lines.push({ type: "add", text: line.slice(1) });
            }
            else if (line.startsWith("-") && !line.startsWith("---")) {
                current.lines.push({ type: "remove", text: line.slice(1) });
            }
            else if (!line.startsWith("***") && !line.startsWith("@@")) {
                current.lines.push({ type: "context", text: line });
            }
        }
    }
    if (current)
        hunks.push(current);
    if (hunks.length === 0) {
        throw new Error("Update patch contains no valid hunks");
    }
    return { op: "update", path: filePath, hunks };
}
// ===============================================================
// Apply patch
// ===============================================================
async function applyParsedPatch(getRoot, parsed) {
    const abs = await withinRoot(getRoot, parsed.path);
    if (parsed.op === "delete") {
        await fs.unlink(abs).catch(() => { });
        return;
    }
    if (parsed.op === "add") {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, parsed.newContent || "", "utf8");
        return;
    }
    let original = "";
    try {
        original = await fs.readFile(abs, "utf8");
    }
    catch {
        throw new Error(`File not found for update: ${parsed.path}`);
    }
    let lines = original.replace(/\r\n/g, "\n").split("\n");
    for (const h of parsed.hunks) {
        const start = h.oldRange.start - 1;
        if (start < 0 || start > lines.length) {
            throw new Error(`Invalid hunk start ${h.oldRange.start} for file "${parsed.path}"`);
        }
        const expectedOld = [];
        const replace = [];
        for (const ln of h.lines) {
            if (ln.type === "context" || ln.type === "remove")
                expectedOld.push(ln.text);
            if (ln.type === "context" || ln.type === "add")
                replace.push(ln.text);
        }
        const actualOld = lines.slice(start, start + h.oldRange.count);
        if (expectedOld.length !== h.oldRange.count ||
            expectedOld.length !== actualOld.length ||
            expectedOld.some((v, i) => v !== actualOld[i])) {
            throw new Error(`Patch hunk context mismatch for "${parsed.path}" at line ${h.oldRange.start}`);
        }
        lines.splice(start, h.oldRange.count, ...replace);
    }
    const finalText = lines.join("\n") + "\n";
    await fs.writeFile(abs, finalText, "utf8");
}
async function rewriteFile(getRoot, pathRel, content) {
    const abs = await withinRoot(getRoot, pathRel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content ?? "", "utf8");
}
// ===============================================================
// HTTP API
// ===============================================================
export function attachMCPToServer(server, opts = {}) {
    const getRoot = opts.getRoot || defaultGetRoot;
    server.on("request", async (req, res) => {
        if (req.method !== "POST")
            return;
        if (req.url === "/mcp/apply_patch") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", async () => {
                try {
                    const { patch } = JSON.parse(body || "{}");
                    const parsed = parseSimplifiedPatch(String(patch || ""));
                    await applyParsedPatch(getRoot, parsed);
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ ok: true, path: parsed.path, op: parsed.op }));
                }
                catch (e) {
                    res.statusCode = 400;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ error: e.message || String(e) }));
                }
            });
            return;
        }
        if (req.url === "/mcp/rewrite_file") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", async () => {
                try {
                    const { path: relPath, content } = JSON.parse(body || "{}");
                    if (typeof relPath !== "string" || !relPath.trim()) {
                        throw new Error("Missing or invalid 'path' for rewrite_file");
                    }
                    await rewriteFile(getRoot, relPath, typeof content === "string" ? content : "");
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ ok: true, path: relPath, op: "rewrite" }));
                }
                catch (e) {
                    res.statusCode = 400;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ error: e.message || String(e) }));
                }
            });
            return;
        }
    });
}
