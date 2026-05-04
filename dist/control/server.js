// src/control/server.ts
import "dotenv/config";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { initRuntime, getRuntime, saveRuntime } from "../runtime/index.js";
import { TextDecoder, promisify } from "node:util";
import { attachMCPToServer } from "../mcp/server.js";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { Agent } from "undici";
import { appendChatMessage, archiveChat, backupUIState, bulkDeleteChats, createChat, createProject, deleteChat, deleteProject, duplicateProject, exportProjectConfig, getActiveProject, getChat, getUIState, importProjectConfig, initUIState, listChats, listProjects, restoreUIState, setActiveChat, setActiveProject, updateChat, updateProject, } from "./stateStore.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// ---------------- Constants ----------------
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const MAX_TREE_DEPTH = 4;
const MAX_ENTRIES_PER_DIR = 200;
const HEARTBEAT_MS = 15000;
const MAX_MODEL_CHARS = 32000;
const MAX_TOOL_DEPTH = 30;
const TOOL_CALL_TIMEOUT_MS = Math.max(1000, Number(process.env.TOOL_CALL_TIMEOUT_MS || 20000));
const MODELS_CACHE_TTL_MS = 10_000;
const MAX_TREE_CONCURRENCY = Math.max(1, Number(process.env.TREE_CONCURRENCY || 8));
const PERF_LOGS_ENABLED = (process.env.PERF_LOGS || "false").toLowerCase() === "true";
const MAX_PERF_EVENTS = Math.max(50, Number(process.env.PERF_EVENTS_MAX || 400));
const MAX_JSON_BODY_BYTES = Math.max(1024, Number(process.env.MAX_JSON_BODY_BYTES || 1024 * 1024));
const MAX_READ_FILE_BYTES = Math.max(1024, Number(process.env.MAX_READ_FILE_BYTES || 256 * 1024));
const MAX_CHUNK_LINE_SPAN = Math.max(10, Number(process.env.MAX_CHUNK_LINE_SPAN || 400));
const MAX_SEARCH_RESULTS = Math.max(10, Number(process.env.MAX_SEARCH_RESULTS || 200));
const MAX_SEARCH_RESULTS_PER_FILE = Math.max(1, Number(process.env.MAX_SEARCH_RESULTS_PER_FILE || 30));
const DASHBOARD_AUTH_TOKEN = (process.env.DASHBOARD_AUTH_TOKEN || "").trim();
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
const DASHBOARD_BASE = process.env.DASHBOARD_BASE?.replace(/\/+$/, "") || `http://localhost:${PORT}`;
const longLMAgent = new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connectTimeout: 0,
});
const execFileAsync = promisify(execFile);
function elapsedMs(startedAt) {
    return Number((process.hrtime.bigint() - startedAt) / 1000000n);
}
function perfLog(event, details) {
    const elapsedRaw = details.elapsedMs;
    const elapsedMs = typeof elapsedRaw === "number" && Number.isFinite(elapsedRaw) ? elapsedRaw : null;
    perfEvents.push({ ts: Date.now(), event, elapsedMs, details });
    if (perfEvents.length > MAX_PERF_EVENTS)
        perfEvents.shift();
    if (!PERF_LOGS_ENABLED)
        return;
    console.log(`[perf] ${event} ${JSON.stringify(details)}`);
}
function createLimiter(limit) {
    let active = 0;
    const queue = [];
    const runNext = () => {
        if (active >= limit)
            return;
        const next = queue.shift();
        if (!next)
            return;
        active++;
        next();
    };
    return async function withLimit(fn) {
        await new Promise((resolve) => {
            queue.push(resolve);
            runNext();
        });
        try {
            return await fn();
        }
        finally {
            active--;
            runNext();
        }
    };
}
const runTreeLimited = createLimiter(MAX_TREE_CONCURRENCY);
const perfEvents = [];
function summarizePerf(entries) {
    const summarize = (eventName) => {
        const rows = entries
            .filter((e) => e.event === eventName && typeof e.elapsedMs === "number")
            .map((e) => e.elapsedMs);
        if (!rows.length)
            return { count: 0, avgMs: 0, p95Ms: 0, maxMs: 0, lastMs: 0 };
        const sorted = [...rows].sort((a, b) => a - b);
        const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
        const sum = rows.reduce((acc, n) => acc + n, 0);
        return {
            count: rows.length,
            avgMs: Number((sum / rows.length).toFixed(2)),
            p95Ms: Number(sorted[p95Index].toFixed(2)),
            maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
            lastMs: Number(rows[rows.length - 1].toFixed(2)),
        };
    };
    const toolRows = entries.filter((e) => e.event === "tool.call");
    const byTool = {};
    for (const row of toolRows) {
        const tool = String(row.details.tool || "unknown");
        byTool[tool] = (byTool[tool] || 0) + 1;
    }
    return {
        chatRequest: summarize("chat.request"),
        chatRound: summarize("chat.round"),
        toolCall: summarize("tool.call"),
        treeList: summarize("tree.list"),
        toolCounts: byTool,
    };
}
// ---------------- Helpers ----------------
function json(res, obj, code = 200) {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
}
function isAuthorized(req) {
    if (!DASHBOARD_AUTH_TOKEN)
        return true;
    const candidate = String(req.headers?.["x-dashboard-token"] || "") ||
        String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
    return candidate === DASHBOARD_AUTH_TOKEN;
}
async function readJsonBody(req) {
    return await new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (c) => {
            body += c;
            if (Buffer.byteLength(body, "utf8") > MAX_JSON_BODY_BYTES) {
                const err = new Error(`Payload too large (max ${MAX_JSON_BODY_BYTES} bytes)`);
                err.statusCode = 413;
                reject(err);
            }
        });
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            }
            catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}
// Normalize what user types in UI:
// - if they type "http://host:1234/v1" => use ".../v1/chat/completions"
// - if they already type ".../chat/completions" => keep it
function normalizeApiBase(input) {
    const raw = (input || "").trim();
    if (!raw)
        return LM_CHAT_URL;
    const noTrail = raw.replace(/\/+$/, "");
    if (noTrail.endsWith("/chat/completions"))
        return noTrail;
    if (noTrail.endsWith("/v1"))
        return `${noTrail}/chat/completions`;
    // if they typed ".../v1/" or ".../v1/chat" etc, just fall back
    return noTrail;
}
let dashboardState = {
    apiBase: normalizeApiBase(getRuntime().apiBase || LM_BASE), // normalize later anyway
    model: getRuntime().model,
    rootDir: getRuntime().rootDir || ".",
    mcpEnabled: getRuntime().mcpEnabled !== false,
    temperature: 0.2,
    maxTokens: 4096,
};
let modelsCache = null;
function projectSettingsFallback() {
    return {
        rootDir: dashboardState.rootDir || ".",
        apiBase: dashboardState.apiBase || LM_CHAT_URL,
        model: dashboardState.model,
        mcpEnabled: dashboardState.mcpEnabled !== false,
        temperature: 0.2,
        maxTokens: 4096,
        trustedRoots: [dashboardState.rootDir || "."],
    };
}
function applyProjectToDashboard(project) {
    dashboardState = {
        ...dashboardState,
        rootDir: project.rootDir || ".",
        apiBase: normalizeApiBase(project.apiBase || dashboardState.apiBase),
        model: project.model || dashboardState.model,
        mcpEnabled: project.mcpEnabled !== false,
        temperature: project.temperature ?? dashboardState.temperature ?? 0.2,
        maxTokens: project.maxTokens ?? dashboardState.maxTokens ?? 4096,
    };
}
async function syncActiveProjectIntoRuntime() {
    const active = getActiveProject();
    applyProjectToDashboard(active);
    await saveRuntime({
        rootDir: dashboardState.rootDir,
        apiBase: dashboardState.apiBase,
        model: dashboardState.model,
        mcpEnabled: dashboardState.mcpEnabled,
    });
}
async function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function getToolArgValidationError(toolName, args) {
    const isObject = !!args && typeof args === "object" && !Array.isArray(args);
    if (!isObject)
        return "arguments must be a JSON object";
    const needsPath = new Set([
        "repo_browser.read_file",
        "repo_browser.read_file_chunk",
        "repo_browser.create_directory",
        "repo_browser.create_file",
        "repo_browser.rewrite_file",
        "repo_browser.print_tree",
    ]);
    if (needsPath.has(toolName) && typeof args.path !== "string") {
        return "missing required string field: path";
    }
    if (toolName === "repo_browser.create_file" && typeof args.content !== "string") {
        return "missing required string field: content";
    }
    if (toolName === "repo_browser.rewrite_file" && typeof args.content !== "string") {
        return "missing required string field: content";
    }
    if (toolName === "repo_browser.apply_patch" && typeof args.patch !== "string") {
        return "missing required string field: patch";
    }
    if (toolName === "repo_browser.read_file_chunk") {
        if (!Number.isInteger(args.startLine) || Number(args.startLine) < 1) {
            return "startLine must be an integer >= 1";
        }
        if (!Number.isInteger(args.endLine) || Number(args.endLine) < Number(args.startLine)) {
            return "endLine must be an integer >= startLine";
        }
        const span = Number(args.endLine) - Number(args.startLine) + 1;
        if (span > MAX_CHUNK_LINE_SPAN) {
            return `line span too large (max ${MAX_CHUNK_LINE_SPAN})`;
        }
    }
    if (toolName === "repo_browser.search_code") {
        if (typeof args.query !== "string" || !args.query.trim()) {
            return "missing required string field: query";
        }
        if (args.globs !== undefined && !Array.isArray(args.globs)) {
            return "globs must be an array of strings";
        }
        if (Array.isArray(args.globs) && args.globs.some((g) => typeof g !== "string")) {
            return "globs must be an array of strings";
        }
    }
    return null;
}
// Tracks currently running LM request so /abort can cancel it
let activeLmAbortController = null;
function getWorkspaceRoot() {
    // Single source of truth for filesystem root:
    // dashboardState.rootDir (UI) -> runtime.json -> env -> cwd
    const st = dashboardState?.rootDir;
    const rt = getRuntime().rootDir;
    return path.resolve(st || rt || process.env.MCP_ROOT_DIR || process.cwd());
}
function normalizeForCompare(inputPath) {
    const normalized = path.normalize(path.resolve(inputPath));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function isWithinBase(basePath, absPath) {
    const baseCmp = normalizeForCompare(basePath);
    const absCmp = normalizeForCompare(absPath);
    const rel = path.relative(baseCmp, absCmp);
    return !(rel.startsWith("..") || path.isAbsolute(rel));
}
function getTrustedRootsResolved() {
    let roots = [];
    try {
        const active = getActiveProject();
        roots = Array.isArray(active.trustedRoots) ? active.trustedRoots : [];
    }
    catch {
        roots = [];
    }
    const root = getWorkspaceRoot();
    if (!roots.some((x) => normalizeForCompare(x) === normalizeForCompare(root))) {
        roots.unshift(root);
    }
    const seen = new Set();
    const deduped = [];
    for (const raw of roots) {
        const trimmed = String(raw || "").trim();
        if (!trimmed)
            continue;
        const resolved = path.resolve(trimmed);
        const key = normalizeForCompare(resolved);
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(resolved);
    }
    return deduped;
}
function isTrustedAbsPath(absPath) {
    const candidates = getTrustedRootsResolved();
    return candidates.some((root) => isWithinBase(root, absPath));
}
function assertTrustedAbsPath(absPath) {
    if (!isTrustedAbsPath(absPath)) {
        throw new Error(`Path is outside trusted roots: "${absPath}"`);
    }
}
async function withinRoot(relPath) {
    const ROOT = getWorkspaceRoot();
    const rel = relPath && relPath.trim() ? relPath : ".";
    const abs = path.resolve(ROOT, rel);
    if (!isWithinBase(ROOT, abs)) {
        throw new Error(`Path escapes project root: rel="${relPath}", root="${ROOT}"`);
    }
    assertTrustedAbsPath(abs);
    return abs;
}
function toModelsUrl(apiBase) {
    const chatUrl = normalizeApiBase(apiBase);
    const noTrail = chatUrl.replace(/\/+$/, "");
    const base = noTrail.endsWith("/chat/completions")
        ? noTrail.slice(0, -"/chat/completions".length)
        : noTrail;
    return `${base}/models`;
}
function normalizeToolRelPath(input) {
    const raw = typeof input === "string" ? input.trim() : "";
    if (!raw)
        return "";
    if (!path.isAbsolute(raw))
        return raw;
    const root = getWorkspaceRoot();
    const rootNorm = path.normalize(root);
    const absNorm = path.normalize(path.resolve(raw));
    const rootCmp = process.platform === "win32" ? rootNorm.toLowerCase() : rootNorm;
    const absCmp = process.platform === "win32" ? absNorm.toLowerCase() : absNorm;
    const relFromRoot = path.relative(rootCmp, absCmp);
    if (!(relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot))) {
        return relFromRoot || ".";
    }
    // Models occasionally send just the drive root (e.g. "E:\\").
    // Treat that as workspace root rather than hard-failing the request.
    const driveRoot = path.parse(rootCmp).root.replace(/[\\\/]+$/, "");
    const absNoTrail = absCmp.replace(/[\\\/]+$/, "");
    if (driveRoot && absNoTrail === driveRoot)
        return "";
    return raw;
}
function looksBinaryBuffer(buf) {
    if (buf.length === 0)
        return false;
    const sample = buf.subarray(0, Math.min(buf.length, 8000));
    let suspicious = 0;
    for (let i = 0; i < sample.length; i++) {
        const b = sample[i];
        if (b === 0)
            return true;
        const isTabOrLfOrCr = b === 9 || b === 10 || b === 13;
        const isPrintable = b >= 32 && b <= 126;
        if (!isTabOrLfOrCr && !isPrintable)
            suspicious++;
    }
    return suspicious / sample.length > 0.25;
}
async function readTextFileWithGuards(rel) {
    const abs = await withinRoot(rel);
    try {
        const raw = await fs.readFile(abs);
        if (raw.length > MAX_READ_FILE_BYTES) {
            return {
                ok: false,
                path: rel,
                error: `File too large (${raw.length} bytes > ${MAX_READ_FILE_BYTES} bytes)`,
                reason: "too_large",
                bytes: raw.length,
            };
        }
        if (looksBinaryBuffer(raw)) {
            return {
                ok: false,
                path: rel,
                error: "Binary file content is blocked by guardrails",
                reason: "binary",
                bytes: raw.length,
            };
        }
        return { ok: true, path: rel, content: raw.toString("utf8"), bytes: raw.length };
    }
    catch (e) {
        if (e?.code === "ENOENT") {
            return { ok: false, path: rel, error: "File not found", reason: "not_found" };
        }
        return {
            ok: false,
            path: rel,
            error: String(e?.message || e),
            reason: "read_failed",
        };
    }
}
async function readFileChunkWithGuards(rel, startLine, endLine) {
    const full = await readTextFileWithGuards(rel);
    if (!full.ok)
        return full;
    const lines = full.content.replace(/\r\n/g, "\n").split("\n");
    const totalLines = lines.length;
    const boundedStart = Math.max(1, startLine);
    const boundedEnd = Math.max(boundedStart, Math.min(endLine, totalLines));
    const slice = lines.slice(boundedStart - 1, boundedEnd);
    return {
        ok: true,
        path: rel,
        startLine: boundedStart,
        endLine: boundedEnd,
        totalLines,
        content: slice.join("\n"),
    };
}
async function searchCodeSafe(query, globsRaw) {
    const q = String(query || "").trim();
    if (!q)
        return { ok: false, error: "Missing query", results: [] };
    const globs = Array.isArray(globsRaw)
        ? globsRaw.map((g) => String(g || "").trim()).filter(Boolean).slice(0, 20)
        : [];
    const root = getWorkspaceRoot();
    assertTrustedAbsPath(path.resolve(root));
    const args = [
        "--line-number",
        "--column",
        "--no-heading",
        "--color",
        "never",
        "--smart-case",
        "--max-count",
        String(MAX_SEARCH_RESULTS_PER_FILE),
        "--max-filesize",
        `${Math.max(1, Math.floor(MAX_READ_FILE_BYTES / 1024))}K`,
    ];
    for (const glob of globs) {
        args.push("--glob", glob);
    }
    args.push(q, ".");
    const isCaseSensitive = /[A-Z]/.test(q);
    const needle = isCaseSensitive ? q : q.toLowerCase();
    const globToRegex = (glob) => {
        const escaped = glob
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".");
        return new RegExp(`^${escaped}$`, "i");
    };
    const globMatchers = globs.map(globToRegex);
    const matchesGlob = (relPath) => {
        if (!globMatchers.length)
            return true;
        const unix = relPath.replace(/\\/g, "/");
        return globMatchers.some((rx) => rx.test(unix) || rx.test(path.basename(unix)));
    };
    const searchFallback = async () => {
        const results = [];
        const stack = [root];
        while (stack.length && results.length < MAX_SEARCH_RESULTS) {
            const dir = stack.pop();
            let entries = [];
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                const abs = path.join(dir, entry.name);
                const rel = path.relative(root, abs);
                if (entry.isDirectory()) {
                    if (!IGNORED_DIRS.has(entry.name))
                        stack.push(abs);
                    continue;
                }
                if (!matchesGlob(rel))
                    continue;
                let raw;
                try {
                    raw = await fs.readFile(abs);
                }
                catch {
                    continue;
                }
                if (raw.length > MAX_READ_FILE_BYTES || looksBinaryBuffer(raw))
                    continue;
                const lines = raw.toString("utf8").replace(/\r\n/g, "\n").split("\n");
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const hay = isCaseSensitive ? line : line.toLowerCase();
                    const col = hay.indexOf(needle);
                    if (col === -1)
                        continue;
                    results.push({ path: rel, line: i + 1, column: col + 1, text: line });
                    if (results.length >= MAX_SEARCH_RESULTS)
                        break;
                }
                if (results.length >= MAX_SEARCH_RESULTS)
                    break;
            }
        }
        return { ok: true, query: q, globs, results, fallback: "node" };
    };
    try {
        const { stdout } = await execFileAsync("rg", args, {
            cwd: root,
            timeout: TOOL_CALL_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
        });
        const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
        const results = [];
        for (const row of lines) {
            const m = row.match(/^(.+?):(\d+):(\d+):(.*)$/);
            if (!m)
                continue;
            results.push({
                path: m[1],
                line: Number(m[2]),
                column: Number(m[3]),
                text: m[4],
            });
            if (results.length >= MAX_SEARCH_RESULTS)
                break;
        }
        return { ok: true, query: q, globs, results };
    }
    catch (e) {
        const code = Number(e?.code);
        if (code === 1)
            return { ok: true, query: q, globs, results: [] };
        if (e?.code === "ENOENT" || e?.code === "EPERM" || String(e?.message || "").includes("spawn EPERM")) {
            return searchFallback();
        }
        return { ok: false, error: String(e?.message || e), query: q, globs, results: [] };
    }
}
async function writeFileSafe(rel, content) {
    const abs = await withinRoot(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content ?? "", "utf8");
}
async function pickDirectoryNative() {
    if (process.platform !== "win32") {
        throw new Error("Native folder picker currently supports Windows only");
    }
    const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$dlg.Description = 'Select project root folder'",
        "$dlg.ShowNewFolderButton = $true",
        "$result = $dlg.ShowDialog()",
        "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
        "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "  Write-Output $dlg.SelectedPath",
        "}",
    ].join("; ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const picked = String(stdout || "").trim();
    return picked || null;
}
async function checkDirectoryHealth(rawPath) {
    const resolvedPath = path.resolve(rawPath);
    let exists = false;
    let isDirectory = false;
    let readable = false;
    let writable = false;
    try {
        const st = await fs.stat(resolvedPath);
        exists = true;
        isDirectory = st.isDirectory();
    }
    catch {
        return { resolvedPath, exists, isDirectory, readable, writable };
    }
    if (!isDirectory)
        return { resolvedPath, exists, isDirectory, readable, writable };
    try {
        await fs.access(resolvedPath, fs.constants.R_OK);
        readable = true;
    }
    catch { }
    try {
        await fs.access(resolvedPath, fs.constants.W_OK);
        writable = true;
    }
    catch { }
    return { resolvedPath, exists, isDirectory, readable, writable };
}
async function listTree(rel, depth = 0) {
    const startedAt = depth === 0 ? process.hrtime.bigint() : 0n;
    if (depth > MAX_TREE_DEPTH)
        return { name: rel, type: "max-depth" };
    const abs = await withinRoot(rel);
    const st = await fs.stat(abs);
    if (!st.isDirectory())
        return { name: rel, type: "file" };
    let entries = await fs.readdir(abs, { withFileTypes: true });
    entries = entries.filter((e) => !IGNORED_DIRS.has(e.name));
    if (entries.length > MAX_ENTRIES_PER_DIR)
        entries = entries.slice(0, MAX_ENTRIES_PER_DIR);
    const children = await Promise.all(entries.map(async (entry) => {
        const childRel = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isDirectory())
            return runTreeLimited(() => listTree(childRel, depth + 1));
        return { name: childRel, type: "file" };
    }));
    const result = { name: rel, type: "dir", children };
    if (depth === 0) {
        perfLog("tree.list", {
            path: rel || ".",
            elapsedMs: elapsedMs(startedAt),
            maxDepth: MAX_TREE_DEPTH,
            maxEntriesPerDir: MAX_ENTRIES_PER_DIR,
            concurrency: MAX_TREE_CONCURRENCY,
        });
    }
    return result;
}
function trimMessages(msgs) {
    if (msgs.length <= 1)
        return [...msgs];
    const sizes = msgs.map((m) => JSON.stringify(m).length);
    let totalChars = sizes.reduce((acc, n) => acc + n, 0);
    let start = 0;
    while (totalChars > MAX_MODEL_CHARS && start < msgs.length - 1) {
        totalChars -= sizes[start];
        start++;
    }
    return msgs.slice(start);
}
// ---------------- System prompt (kept minimal here) ----------------
function buildSystemPrompt(currentRoot) {
    return `
You are a coding agent running inside an MCP environment.

Workspace root is: "${currentRoot}"

TOOLS:
- repo_browser.print_tree(path: string)
- repo_browser.read_file(path: string)
- repo_browser.read_file_chunk(path: string, startLine: number, endLine: number)
- repo_browser.search_code(query: string, globs?: string[])
- repo_browser.apply_patch(patch: string)
- repo_browser.create_directory(path: string)
- repo_browser.create_file(path: string, content: string)
- repo_browser.rewrite_file(path: string, content: string)
`.trim();
}
function startHeartbeat(res) {
    return setInterval(() => {
        try {
            res.write("event: heartbeat\n");
            res.write('data: { "keepalive": true }\n\n');
        }
        catch {
            // ignore
        }
    }, HEARTBEAT_MS);
}
function stopHeartbeat(timer) {
    if (!timer)
        return;
    clearInterval(timer);
}
function stableStringify(value) {
    if (value === null || value === undefined)
        return String(value);
    if (typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((v) => stableStringify(v)).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
function isCacheableRetrievalTool(toolName) {
    return (toolName === "repo_browser.print_tree" ||
        toolName === "repo_browser.read_file" ||
        toolName === "repo_browser.read_file_chunk" ||
        toolName === "repo_browser.search_code");
}
function createExecuteTool(res, retrievalCache) {
    return async (toolName, args) => {
        const startedAt = process.hrtime.bigint();
        let status = "ok";
        if (!toolName) {
            const err = { error: "Missing tool name" };
            res.write("event: tool_result\n");
            res.write(`data: ${JSON.stringify({ tool: toolName || "unknown", result: err })}\n\n`);
            status = "error";
            return err;
        }
        try {
            res.write("event: tool_call\n");
            res.write(`data: ${JSON.stringify({ tool: toolName, args })}\n\n`);
        }
        catch { }
        try {
            const cacheKey = isCacheableRetrievalTool(toolName) ? `${toolName}:${stableStringify(args || {})}` : null;
            if (cacheKey && retrievalCache.has(cacheKey)) {
                const cached = retrievalCache.get(cacheKey);
                res.write("event: tool_result\n");
                res.write(`data: ${JSON.stringify({ tool: toolName, result: cached, cached: true })}\n\n`);
                return cached;
            }
            if (toolName === "repo_browser.print_tree") {
                const toolPath = normalizeToolRelPath(args.path);
                const tree = await listTree(toolPath);
                if (cacheKey)
                    retrievalCache.set(cacheKey, tree);
                res.write("event: tool_result\n");
                res.write(`data: ${JSON.stringify({ tool: toolName, result: tree })}\n\n`);
                return tree;
            }
            if (toolName === "repo_browser.read_file") {
                const toolPath = normalizeToolRelPath(args.path);
                const data = await readTextFileWithGuards(toolPath);
                if (cacheKey)
                    retrievalCache.set(cacheKey, data);
                res.write("event: tool_result\n");
                res.write(`data: ${JSON.stringify({ tool: toolName, result: data })}\n\n`);
                return data;
            }
            if (toolName === "repo_browser.read_file_chunk") {
                const toolPath = normalizeToolRelPath(args.path);
                const data = await readFileChunkWithGuards(toolPath, Number(args.startLine), Number(args.endLine));
                if (cacheKey)
                    retrievalCache.set(cacheKey, data);
                res.write("event: tool_result\n");
                res.write(`data: ${JSON.stringify({ tool: toolName, result: data })}\n\n`);
                return data;
            }
            if (toolName === "repo_browser.search_code") {
                const data = await searchCodeSafe(args.query, args.globs);
                if (cacheKey)
                    retrievalCache.set(cacheKey, data);
                res.write("event: tool_result\n");
                res.write(`data: ${JSON.stringify({ tool: toolName, result: data })}\n\n`);
                return data;
            }
            if (toolName === "repo_browser.create_directory") {
                const relPath = normalizeToolRelPath(args.path);
                const abs = await withinRoot(relPath);
                await fs.mkdir(abs, { recursive: true });
                retrievalCache.clear();
                const result = { ok: true, created: relPath };
                res.write("event: tool_result\n");
                res.write(`data: ${JSON.stringify({ tool: toolName, result })}\n\n`);
                return result;
            }
            if (toolName === "repo_browser.create_file") {
                const relPath = normalizeToolRelPath(args.path);
                const content = typeof args.content === "string" ? args.content : "";
                await writeFileSafe(relPath, content);
                retrievalCache.clear();
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
                    retrievalCache.clear();
                    res.write("event: tool_result\n");
                    res.write(`data: ${JSON.stringify({ tool: toolName, result: r })}\n\n`);
                    return r;
                }
                catch (e) {
                    const err = { error: "Failed to call /mcp/apply_patch", detail: String(e?.message || e) };
                    res.write("event: tool_result\n");
                    res.write(`data: ${JSON.stringify({ tool: toolName, result: err })}\n\n`);
                    status = "error";
                    return err;
                }
            }
            if (toolName === "repo_browser.rewrite_file") {
                try {
                    const url = `${DASHBOARD_BASE}/mcp/rewrite_file`;
                    const relPath = normalizeToolRelPath(args.path);
                    const r = await fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ path: relPath, content: args.content }),
                        // @ts-ignore
                        dispatcher: longLMAgent,
                    }).then((x) => x.json());
                    retrievalCache.clear();
                    res.write("event: tool_result\n");
                    res.write(`data: ${JSON.stringify({ tool: toolName, result: r })}\n\n`);
                    return r;
                }
                catch (e) {
                    const err = { error: "Failed to call /mcp/rewrite_file", detail: String(e?.message || e) };
                    res.write("event: tool_result\n");
                    res.write(`data: ${JSON.stringify({ tool: toolName, result: err })}\n\n`);
                    status = "error";
                    return err;
                }
            }
            const errUnknown = { error: "Unknown tool" };
            res.write("event: tool_result\n");
            res.write(`data: ${JSON.stringify({ tool: toolName, result: errUnknown })}\n\n`);
            status = "error";
            return errUnknown;
        }
        finally {
            const elapsed = elapsedMs(startedAt);
            perfLog("tool.call", {
                tool: toolName,
                status,
                elapsedMs: elapsed,
            });
            try {
                res.write("event: tool_done\n");
                res.write(`data: ${JSON.stringify({ tool: toolName, status, elapsedMs: elapsed })}\n\n`);
            }
            catch { }
        }
    };
}
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
            name: "repo_browser.read_file_chunk",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    startLine: { type: "integer", minimum: 1 },
                    endLine: { type: "integer", minimum: 1 },
                },
                required: ["path", "startLine", "endLine"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "repo_browser.search_code",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string" },
                    globs: { type: "array", items: { type: "string" } },
                },
                required: ["query"],
            },
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
async function runChatWithTools(ctx, messages, depth = 0) {
    const roundStartedAt = process.hrtime.bigint();
    const { res, lmAbort, effectiveModel, payload, toolsPayload, executeTool } = ctx;
    if (depth > MAX_TOOL_DEPTH) {
        res.write("event: error\n");
        const message = "Too many tool-call rounds, aborting.";
        res.write(`data: ${JSON.stringify({ message })}\n\n`);
        return { status: "error", message };
    }
    const lmUrl = dashboardState.apiBase || LM_CHAT_URL;
    let resp;
    let lastFetchError = "Upstream LM fetch failed";
    let attemptsUsed = 0;
    for (let attempt = 1; attempt <= LM_MAX_RETRIES; attempt++) {
        attemptsUsed = attempt;
        try {
            resp = await fetch(lmUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: effectiveModel,
                    stream: true,
                    messages,
                    temperature: payload.temperature ?? getActiveProject().temperature ?? 0.2,
                    max_tokens: payload.max_tokens ?? getActiveProject().maxTokens ?? 4096,
                    ...toolsPayload,
                }),
                // @ts-ignore
                dispatcher: longLMAgent,
                signal: lmAbort.signal,
            });
            if (resp.ok && resp.body)
                break;
            lastFetchError = `HTTP ${resp.status}`;
        }
        catch (e) {
            if (e?.name === "AbortError")
                throw e;
            lastFetchError = String(e?.message || e);
        }
        if (attempt < LM_MAX_RETRIES) {
            res.write("event: retry\n");
            res.write(`data: ${JSON.stringify({ attempt: attempt + 1, max: LM_MAX_RETRIES, reason: lastFetchError })}\n\n`);
            await new Promise((resolve) => setTimeout(resolve, Math.min(250 * attempt, 1000)));
        }
    }
    if (!resp || !resp.ok || !resp.body) {
        res.write("event: error\n");
        const message = lastFetchError || "Upstream LM fetch failed";
        res.write(`data: ${JSON.stringify({ message })}\n\n`);
        perfLog("chat.round", {
            depth,
            status: "upstream_error",
            attempts: attemptsUsed,
            elapsedMs: elapsedMs(roundStartedAt),
        });
        return { status: "upstream_error", message };
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    const toolBuffers = [];
    let sawToolCalls = false;
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        sseBuffer += decoder.decode(value, { stream: true });
        let sep = sseBuffer.search(/\r?\n\r?\n/);
        while (sep !== -1) {
            const rawEvent = sseBuffer.slice(0, sep);
            const delimMatch = sseBuffer.slice(sep).match(/^\r?\n\r?\n/);
            const delimLen = delimMatch ? delimMatch[0].length : 2;
            sseBuffer = sseBuffer.slice(sep + delimLen);
            sep = sseBuffer.search(/\r?\n\r?\n/);
            const lines = rawEvent.split("\n");
            const dataLines = [];
            for (const raw of lines) {
                const ln = raw.replace(/\r$/, "");
                if (ln.startsWith("data:"))
                    dataLines.push(ln.slice(5).trimStart());
            }
            const jsonPart = dataLines.join("\n").trim();
            if (!jsonPart || jsonPart === "[DONE]")
                continue;
            let deltaObj;
            try {
                deltaObj = JSON.parse(jsonPart);
            }
            catch {
                continue;
            }
            const choice = deltaObj.choices?.[0];
            const delta = choice?.delta || {};
            const finishReason = choice?.finish_reason;
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                sawToolCalls = true;
                for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolBuffers[idx]) {
                        toolBuffers[idx] = { id: tc.id || undefined, type: "function", function: { name: "", arguments: "" } };
                    }
                    const buf = toolBuffers[idx];
                    if (tc.id)
                        buf.id = tc.id;
                    if (tc.function?.name)
                        buf.function.name = tc.function.name;
                    if (typeof tc.function?.arguments === "string")
                        buf.function.arguments += tc.function.arguments;
                }
                if (finishReason === "tool_calls") {
                    // handled after stream ends
                }
                continue;
            }
            if (delta.content) {
                const content = Array.isArray(delta.content)
                    ? delta.content.map((c) => (typeof c === "string" ? c : c.text || "")).join("")
                    : delta.content;
                if (content) {
                    res.write("event: message\n");
                    res.write(`data: ${JSON.stringify({ role: "assistant", text: content })}\n\n`);
                }
            }
        }
    }
    if (sawToolCalls && toolBuffers.length > 0) {
        const toolCallsForMsg = [];
        const toolResultMessages = [];
        for (let i = 0; i < toolBuffers.length; i++) {
            const buf = toolBuffers[i];
            const name = buf?.function?.name;
            if (!name)
                continue;
            const rawArgs = typeof buf.function.arguments === "string" ? buf.function.arguments : "{}";
            let parsedArgs = {};
            try {
                parsedArgs = JSON.parse(rawArgs || "{}");
            }
            catch {
                parsedArgs = { __parse_error: "invalid_json", __raw: rawArgs };
            }
            const id = buf.id || `tool_call_${i}`;
            let result;
            const validationError = getToolArgValidationError(name, parsedArgs);
            if (validationError) {
                result = {
                    error: "Invalid tool call arguments",
                    tool: name,
                    detail: validationError,
                    raw: rawArgs.slice(0, 400),
                };
                res.write("event: tool_result\n");
                res.write(`data: ${JSON.stringify({ tool: name, result })}\n\n`);
            }
            else {
                try {
                    result = await withTimeout(executeTool(name, parsedArgs), TOOL_CALL_TIMEOUT_MS, `tool ${name}`);
                }
                catch (e) {
                    result = {
                        error: "Tool execution failed",
                        tool: name,
                        detail: String(e?.message || e),
                    };
                    res.write("event: tool_result\n");
                    res.write(`data: ${JSON.stringify({ tool: name, result })}\n\n`);
                }
            }
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
            perfLog("chat.round", {
                depth,
                status: "tool_calls",
                toolCalls: toolCallsForMsg.length,
                attempts: attemptsUsed,
                elapsedMs: elapsedMs(roundStartedAt),
            });
            return await runChatWithTools(ctx, nextMessages, depth + 1);
        }
        res.write("event: error\n");
        const message = "Model emitted tool_calls without a valid function name.";
        res.write(`data: ${JSON.stringify({ message })}\n\n`);
        return { status: "error", message };
    }
    perfLog("chat.round", {
        depth,
        status: "done",
        attempts: attemptsUsed,
        elapsedMs: elapsedMs(roundStartedAt),
    });
    return { status: "done" };
}
function buildBaseMessages(userMessages, currentRoot) {
    return trimMessages([{ role: "system", content: buildSystemPrompt(currentRoot) }, ...userMessages]);
}
async function handleChat(req, res) {
    const chatStartedAt = process.hrtime.bigint();
    let chatStatus = "ok";
    let userMsgCount = 0;
    const lmAbort = new AbortController();
    activeLmAbortController = lmAbort;
    res.on("close", () => {
        try {
            lmAbort.abort();
        }
        catch { }
    });
    let heartbeat = null;
    try {
        await syncActiveProjectIntoRuntime();
        const payload = await readJsonBody(req);
        const userMessages = payload.messages || [];
        userMsgCount = userMessages.length;
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
        const toolsPayload = mcpEnabled ? { tools: TOOLS, tool_choice: "auto" } : {};
        const retrievalCache = new Map();
        const executeTool = createExecuteTool(res, retrievalCache);
        const ctx = {
            res,
            lmAbort,
            effectiveModel,
            payload,
            toolsPayload,
            executeTool,
        };
        const round = await runChatWithTools(ctx, baseMessages);
        if (round.status !== "done") {
            chatStatus = "error";
            res.write("event: done\n");
            res.write(`data: ${JSON.stringify({ ok: false, status: round.status, message: round.message })}\n\n`);
            res.end();
            return;
        }
        stopHeartbeat(heartbeat);
        activeLmAbortController = null;
        res.write("event: done\n");
        res.write(`data: ${JSON.stringify({ ok: true, status: "done" })}\n\n`);
        res.end();
    }
    catch (e) {
        activeLmAbortController = null;
        stopHeartbeat(heartbeat);
        if (e?.name === "AbortError") {
            chatStatus = "aborted";
            try {
                res.write("event: done\n");
                res.write(`data: ${JSON.stringify({ ok: true, status: "aborted" })}\n\n`);
                res.end();
            }
            catch { }
            return;
        }
        chatStatus = "error";
        try {
            res.write("event: error\n");
            res.write(`data: ${JSON.stringify({ message: e?.message || "Internal error" })}\n\n`);
            res.write("event: done\n");
            res.write(`data: ${JSON.stringify({ ok: false, status: "error" })}\n\n`);
            res.end();
        }
        catch {
            // ignore
        }
    }
    finally {
        perfLog("chat.request", {
            status: chatStatus,
            userMessages: userMsgCount,
            elapsedMs: elapsedMs(chatStartedAt),
        });
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
await initUIState(projectSettingsFallback());
await syncActiveProjectIntoRuntime();
const server = createServer(async (req, res) => {
    const reqUrl = req.url || "/";
    const urlObj = new URL(reqUrl, `http://localhost:${PORT}`);
    const pathname = urlObj.pathname;
    const contentLen = Number(req.headers?.["content-length"] || 0);
    if (contentLen > MAX_JSON_BODY_BYTES) {
        return json(res, { ok: false, error: `Payload too large (max ${MAX_JSON_BODY_BYTES} bytes)` }, 413);
    }
    // Let MCP handler own these endpoints
    if (pathname === "/mcp/apply_patch" || pathname === "/mcp/rewrite_file")
        return;
    const publicPaths = new Set(["/", "/index.html", "/healthz"]);
    if (!publicPaths.has(pathname) && !isAuthorized(req)) {
        return json(res, { ok: false, error: "Unauthorized" }, 401);
    }
    // ---- STATE API ----
    if (pathname === "/state" && req.method === "GET") {
        await syncActiveProjectIntoRuntime();
        return json(res, dashboardState);
    }
    if (pathname === "/state" && req.method === "POST") {
        try {
            const patch = await readJsonBody(req);
            const st = getUIState();
            const activeId = st.activeProjectId;
            if (!activeId)
                throw new Error("No active project");
            await updateProject(activeId, {
                rootDir: patch.rootDir,
                apiBase: patch.apiBase ? normalizeApiBase(String(patch.apiBase)) : undefined,
                model: patch.model,
                pinned: patch.pinned,
                mcpEnabled: patch.mcpEnabled,
                temperature: patch.temperature,
                maxTokens: patch.maxTokens,
                trustedRoots: patch.trustedRoots,
            }, projectSettingsFallback());
            await syncActiveProjectIntoRuntime();
            return json(res, dashboardState);
        }
        catch (e) {
            return json(res, { error: e?.message || String(e) }, 400);
        }
    }
    // ---- Projects ----
    if (pathname === "/projects" && req.method === "GET") {
        return json(res, await listProjects());
    }
    if (pathname === "/projects" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            const created = await createProject({
                name: body?.name,
                rootDir: body?.rootDir,
                apiBase: body?.apiBase ? normalizeApiBase(String(body.apiBase)) : undefined,
                model: body?.model,
                pinned: body?.pinned,
                mcpEnabled: body?.mcpEnabled,
                temperature: body?.temperature,
                maxTokens: body?.maxTokens,
                trustedRoots: body?.trustedRoots,
            }, projectSettingsFallback());
            await syncActiveProjectIntoRuntime();
            return json(res, { ok: true, state: created });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 400);
        }
    }
    if (pathname === "/projects/active" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            const projectId = String(body?.projectId || "");
            if (!projectId)
                throw new Error("Missing projectId");
            const next = await setActiveProject(projectId);
            await syncActiveProjectIntoRuntime();
            return json(res, { ok: true, state: next });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 400);
        }
    }
    const projectByIdMatch = pathname.match(/^\/projects\/([^/]+)$/);
    if (projectByIdMatch) {
        const projectId = decodeURIComponent(projectByIdMatch[1]);
        if (req.method === "PATCH") {
            try {
                const body = await readJsonBody(req);
                const next = await updateProject(projectId, {
                    name: body?.name,
                    rootDir: body?.rootDir,
                    apiBase: body?.apiBase ? normalizeApiBase(String(body.apiBase)) : undefined,
                    model: body?.model,
                    pinned: body?.pinned,
                    mcpEnabled: body?.mcpEnabled,
                    temperature: body?.temperature,
                    maxTokens: body?.maxTokens,
                    trustedRoots: body?.trustedRoots,
                }, projectSettingsFallback());
                if (getUIState().activeProjectId === projectId)
                    await syncActiveProjectIntoRuntime();
                return json(res, { ok: true, state: next });
            }
            catch (e) {
                return json(res, { ok: false, error: e?.message || String(e) }, 400);
            }
        }
        if (req.method === "DELETE") {
            try {
                const next = await deleteProject(projectId);
                await syncActiveProjectIntoRuntime();
                return json(res, { ok: true, state: next });
            }
            catch (e) {
                return json(res, { ok: false, error: e?.message || String(e) }, 400);
            }
        }
    }
    const projectChatsMatch = pathname.match(/^\/projects\/([^/]+)\/chats$/);
    if (projectChatsMatch) {
        const projectId = decodeURIComponent(projectChatsMatch[1]);
        if (req.method === "GET") {
            try {
                const includeArchived = urlObj.searchParams.get("includeArchived") === "true";
                return json(res, await listChats(projectId, { includeArchived }));
            }
            catch (e) {
                return json(res, { ok: false, error: e?.message || String(e) }, 400);
            }
        }
        if (req.method === "POST") {
            try {
                const body = await readJsonBody(req);
                const next = await createChat(projectId, typeof body?.title === "string" ? body.title : undefined);
                return json(res, { ok: true, state: next });
            }
            catch (e) {
                return json(res, { ok: false, error: e?.message || String(e) }, 400);
            }
        }
    }
    const projectDuplicateMatch = pathname.match(/^\/projects\/([^/]+)\/duplicate$/);
    if (projectDuplicateMatch && req.method === "POST") {
        try {
            const projectId = decodeURIComponent(projectDuplicateMatch[1]);
            const next = await duplicateProject(projectId, projectSettingsFallback());
            await syncActiveProjectIntoRuntime();
            return json(res, { ok: true, state: next });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 400);
        }
    }
    const projectExportMatch = pathname.match(/^\/projects\/([^/]+)\/export$/);
    if (projectExportMatch && req.method === "GET") {
        try {
            const projectId = decodeURIComponent(projectExportMatch[1]);
            return json(res, { ok: true, config: exportProjectConfig(projectId) });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 400);
        }
    }
    if (pathname === "/projects/import" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            const next = await importProjectConfig(body?.config || body, projectSettingsFallback());
            await syncActiveProjectIntoRuntime();
            return json(res, { ok: true, state: next });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 400);
        }
    }
    const projectBulkDeleteChatsMatch = pathname.match(/^\/projects\/([^/]+)\/chats\/bulk-delete$/);
    if (projectBulkDeleteChatsMatch && req.method === "POST") {
        try {
            const projectId = decodeURIComponent(projectBulkDeleteChatsMatch[1]);
            const body = await readJsonBody(req);
            const next = await bulkDeleteChats(projectId, {
                includePinned: body?.includePinned === true,
                includeArchived: body?.includeArchived === true,
            });
            return json(res, { ok: true, state: next });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 400);
        }
    }
    // ---- Chats ----
    if (pathname === "/chats/active" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            const chatId = String(body?.chatId || "");
            if (!chatId)
                throw new Error("Missing chatId");
            const next = await setActiveChat(chatId);
            await syncActiveProjectIntoRuntime();
            return json(res, { ok: true, state: next });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 400);
        }
    }
    const chatByIdMatch = pathname.match(/^\/chats\/([^/]+)$/);
    if (chatByIdMatch) {
        const chatId = decodeURIComponent(chatByIdMatch[1]);
        if (req.method === "GET") {
            try {
                return json(res, { ok: true, chat: getChat(chatId) });
            }
            catch (e) {
                return json(res, { ok: false, error: e?.message || String(e) }, 404);
            }
        }
        if (req.method === "PATCH") {
            try {
                const body = await readJsonBody(req);
                const next = await updateChat(chatId, {
                    title: body?.title,
                    pinned: body?.pinned,
                    archived: body?.archived,
                    messages: body?.messages,
                });
                return json(res, { ok: true, state: next });
            }
            catch (e) {
                return json(res, { ok: false, error: e?.message || String(e) }, 400);
            }
        }
        if (req.method === "DELETE") {
            try {
                const next = await deleteChat(chatId);
                return json(res, { ok: true, state: next });
            }
            catch (e) {
                return json(res, { ok: false, error: e?.message || String(e) }, 400);
            }
        }
    }
    const chatMessagesMatch = pathname.match(/^\/chats\/([^/]+)\/messages$/);
    if (chatMessagesMatch && req.method === "POST") {
        try {
            const chatId = decodeURIComponent(chatMessagesMatch[1]);
            const body = await readJsonBody(req);
            const message = body?.message;
            if (!message || typeof message !== "object")
                throw new Error("Missing message object");
            const role = typeof message.role === "string" ? message.role : "user";
            const next = await appendChatMessage(chatId, {
                ...message,
                role,
            });
            return json(res, { ok: true, state: next });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 400);
        }
    }
    const chatArchiveMatch = pathname.match(/^\/chats\/([^/]+)\/archive$/);
    if (chatArchiveMatch && req.method === "POST") {
        try {
            const chatId = decodeURIComponent(chatArchiveMatch[1]);
            const next = await archiveChat(chatId);
            return json(res, { ok: true, state: next });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 400);
        }
    }
    // ---- MODELS ----
    if (pathname === "/models" && req.method === "GET") {
        try {
            const modelsUrl = toModelsUrl(dashboardState.apiBase || LM_CHAT_URL);
            const now = Date.now();
            if (modelsCache && modelsCache.url === modelsUrl && modelsCache.expiresAt > now) {
                return json(res, modelsCache.data);
            }
            const r = await fetch(modelsUrl);
            if (!r.ok) {
                return json(res, { data: [], error: `HTTP ${r.status} from ${modelsUrl}` }, 502);
            }
            const data = await r.json();
            modelsCache = { url: modelsUrl, expiresAt: now + MODELS_CACHE_TTL_MS, data };
            return json(res, data);
        }
        catch (e) {
            return json(res, { data: [], error: String(e) }, 500);
        }
    }
    // ---- FS (editor) ----
    if (pathname === "/fs/read" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            const p = String(body?.path || "");
            const out = await readTextFileWithGuards(p);
            if (!out.ok) {
                return json(res, { ok: false, error: out.error, reason: out.reason }, 400);
            }
            return json(res, { ok: true, content: out.content, bytes: out.bytes });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 400);
        }
    }
    if (pathname === "/fs/write" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            const p = String(body?.path || "");
            const c = typeof body?.content === "string" ? body.content : "";
            await writeFileSafe(p, c);
            return json(res, { ok: true });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 400);
        }
    }
    if (pathname === "/fs/pick-directory" && req.method === "POST") {
        try {
            const picked = await pickDirectoryNative();
            if (!picked)
                return json(res, { ok: false, canceled: true });
            return json(res, { ok: true, path: picked });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 500);
        }
    }
    if (pathname === "/fs/validate-directory" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            const raw = String(body?.path || "").trim();
            if (!raw)
                return json(res, { ok: false, error: "Missing path" }, 400);
            const health = await checkDirectoryHealth(raw);
            return json(res, {
                ok: true,
                input: raw,
                resolvedPath: health.resolvedPath,
                exists: health.exists,
                isDirectory: health.isDirectory,
                readable: health.readable,
                writable: health.writable,
            });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 500);
        }
    }
    if (pathname === "/fs/recent-roots" && req.method === "GET") {
        try {
            const projects = (await listProjects()).projects || [];
            const candidates = Array.from(new Set([getWorkspaceRoot(), process.cwd(), ...projects.map((p) => p.rootDir || "")]
                .map((p) => String(p || "").trim())
                .filter(Boolean))).slice(0, 30);
            const checked = await Promise.all(candidates.map(async (root) => ({ root, ...(await checkDirectoryHealth(root)) })));
            return json(res, { ok: true, roots: checked });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 500);
        }
    }
    if (pathname === "/fs/dry-run-root" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            const raw = String(body?.path || "").trim();
            if (!raw)
                return json(res, { ok: false, error: "Missing path" }, 400);
            const health = await checkDirectoryHealth(raw);
            if (!(health.exists && health.isDirectory && health.readable)) {
                return json(res, { ok: false, health, error: "Path is not a readable directory" }, 400);
            }
            const sample = await fs.readdir(health.resolvedPath, { withFileTypes: true });
            const preview = sample.slice(0, 30).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
            return json(res, { ok: true, health, preview });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 500);
        }
    }
    if (pathname === "/state/backup" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            const backup = await backupUIState(typeof body?.path === "string" ? body.path : undefined);
            return json(res, { ok: true, backup });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 500);
        }
    }
    if (pathname === "/state/restore" && req.method === "POST") {
        try {
            const body = await readJsonBody(req);
            let payload = body?.state || body?.payload;
            if (!payload && typeof body?.path === "string" && body.path.trim()) {
                const raw = await fs.readFile(path.resolve(body.path.trim()), "utf8");
                payload = JSON.parse(raw);
            }
            if (!payload)
                throw new Error("Missing restore payload");
            const next = await restoreUIState(payload, projectSettingsFallback());
            await syncActiveProjectIntoRuntime();
            return json(res, { ok: true, state: next });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 500);
        }
    }
    if (pathname === "/state/ui" && req.method === "GET") {
        try {
            const full = getUIState();
            return json(res, { ok: true, state: full });
        }
        catch (e) {
            return json(res, { ok: false, error: e?.message || String(e) }, 500);
        }
    }
    // ---- Serve dashboard HTML ----
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        try {
            const indexPath = path.join(__dirname, "index.html");
            const html = await fs.readFile(indexPath, "utf8");
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            return res.end(html);
        }
        catch (e) {
            res.statusCode = 500;
            return res.end("Failed to load dashboard index.html: " + e.message);
        }
    }
    // ---- Abort LM stream ----
    if (req.method === "POST" && pathname === "/abort") {
        if (activeLmAbortController) {
            activeLmAbortController.abort();
            activeLmAbortController = null;
            return json(res, { ok: true, aborted: true });
        }
        return json(res, { ok: true, aborted: false });
    }
    // ---- Chat ----
    if (req.method === "POST" && pathname === "/chat") {
        return handleChat(req, res);
    }
    // ---- Health ----
    if (req.method === "GET" && pathname === "/healthz") {
        return json(res, { ok: true });
    }
    // ---- Perf ----
    if (req.method === "GET" && pathname.startsWith("/perf")) {
        const limitRaw = Number(urlObj.searchParams.get("limit") || "100");
        const limit = Math.max(1, Math.min(MAX_PERF_EVENTS, Number.isFinite(limitRaw) ? limitRaw : 100));
        const recent = perfEvents.slice(-limit);
        return json(res, {
            ok: true,
            enabledConsoleLogs: PERF_LOGS_ENABLED,
            maxEvents: MAX_PERF_EVENTS,
            totalEvents: perfEvents.length,
            recent,
            summary: summarizePerf(recent),
        });
    }
    // ---- Better 404: JSON for API-ish paths ----
    const url = pathname || reqUrl;
    const wantsJson = url.startsWith("/state") ||
        url.startsWith("/models") ||
        url.startsWith("/perf") ||
        url.startsWith("/projects") ||
        url.startsWith("/chats") ||
        url.startsWith("/chat") ||
        url.startsWith("/abort") ||
        url.startsWith("/fs/") ||
        url.startsWith("/mcp/");
    if (wantsJson)
        return json(res, { error: "Not Found", path: url }, 404);
    res.statusCode = 404;
    res.end("Not Found");
});
server.requestTimeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
// Attach MCP tools to same server instance WITH DYNAMIC ROOT
attachMCPToServer(server, { getRoot: getWorkspaceRoot, isTrustedAbsPath });
server.listen(PORT, () => {
    console.log(`[dashboard] running at http://localhost:${PORT}`);
    console.log(`LM Studio base: ${LM_BASE}`);
    console.log(`Workspace root: ${getWorkspaceRoot()}`);
});
export { server };
