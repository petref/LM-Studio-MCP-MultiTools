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
import {
  appendChatMessage,
  createChat,
  createProject,
  deleteChat,
  deleteProject,
  getActiveProject,
  getChat,
  getUIState,
  initUIState,
  listChats,
  listProjects,
  setActiveChat,
  setActiveProject,
  updateChat,
  updateProject,
  type ProjectSettings,
} from "./stateStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- Constants ----------------
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const MAX_TREE_DEPTH = 4;
const MAX_ENTRIES_PER_DIR = 200;
const HEARTBEAT_MS = 15000;
const MAX_MODEL_CHARS = 32000;
const MAX_TOOL_DEPTH = 30;
const MODELS_CACHE_TTL_MS = 10_000;
const MAX_TREE_CONCURRENCY = Math.max(1, Number(process.env.TREE_CONCURRENCY || 8));
const PERF_LOGS_ENABLED = (process.env.PERF_LOGS || "false").toLowerCase() === "true";
const MAX_PERF_EVENTS = Math.max(50, Number(process.env.PERF_EVENTS_MAX || 400));

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

function elapsedMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

function perfLog(event: string, details: Record<string, unknown>) {
  const elapsedRaw = details.elapsedMs;
  const elapsedMs =
    typeof elapsedRaw === "number" && Number.isFinite(elapsedRaw) ? elapsedRaw : null;
  perfEvents.push({ ts: Date.now(), event, elapsedMs, details });
  if (perfEvents.length > MAX_PERF_EVENTS) perfEvents.shift();

  if (!PERF_LOGS_ENABLED) return;
  console.log(`[perf] ${event} ${JSON.stringify(details)}`);
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    if (active >= limit) return;
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  };

  return async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      runNext();
    });

    try {
      return await fn();
    } finally {
      active--;
      runNext();
    }
  };
}

const runTreeLimited = createLimiter(MAX_TREE_CONCURRENCY);

type PerfEntry = {
  ts: number;
  event: string;
  elapsedMs: number | null;
  details: Record<string, unknown>;
};

const perfEvents: PerfEntry[] = [];

function summarizePerf(entries: PerfEntry[]) {
  const summarize = (eventName: string) => {
    const rows = entries
      .filter((e) => e.event === eventName && typeof e.elapsedMs === "number")
      .map((e) => e.elapsedMs as number);
    if (!rows.length) return { count: 0, avgMs: 0, p95Ms: 0, maxMs: 0, lastMs: 0 };

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
  const byTool: Record<string, number> = {};
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
let modelsCache: { url: string; expiresAt: number; data: any } | null = null;

function projectSettingsFallback(): ProjectSettings {
  return {
    rootDir: dashboardState.rootDir || ".",
    apiBase: dashboardState.apiBase || LM_CHAT_URL,
    model: dashboardState.model,
    mcpEnabled: dashboardState.mcpEnabled !== false,
  };
}

function applyProjectToDashboard(project: ProjectSettings) {
  dashboardState = {
    ...dashboardState,
    rootDir: project.rootDir || ".",
    apiBase: normalizeApiBase(project.apiBase || dashboardState.apiBase),
    model: project.model || dashboardState.model,
    mcpEnabled: project.mcpEnabled !== false,
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

  const rootNorm = path.normalize(ROOT);
  const absNorm = path.normalize(abs);
  const rootCmp = process.platform === "win32" ? rootNorm.toLowerCase() : rootNorm;
  const absCmp = process.platform === "win32" ? absNorm.toLowerCase() : absNorm;
  const relFromRoot = path.relative(rootCmp, absCmp);

  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    throw new Error(`Path escapes project root: rel="${relPath}", root="${ROOT}"`);
  }
  return abs;
}

function toModelsUrl(apiBase: string): string {
  const chatUrl = normalizeApiBase(apiBase);
  const noTrail = chatUrl.replace(/\/+$/, "");
  const base = noTrail.endsWith("/chat/completions")
    ? noTrail.slice(0, -"/chat/completions".length)
    : noTrail;
  return `${base}/models`;
}

function normalizeToolRelPath(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return "";
  if (!path.isAbsolute(raw)) return raw;

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
  if (driveRoot && absNoTrail === driveRoot) return "";

  return raw;
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
  const startedAt = depth === 0 ? process.hrtime.bigint() : 0n;
  if (depth > MAX_TREE_DEPTH) return { name: rel, type: "max-depth" };

  const abs = await withinRoot(rel);
  const st = await fs.stat(abs);

  if (!st.isDirectory()) return { name: rel, type: "file" };

  let entries = await fs.readdir(abs, { withFileTypes: true });
  entries = entries.filter((e) => !IGNORED_DIRS.has(e.name));
  if (entries.length > MAX_ENTRIES_PER_DIR) entries = entries.slice(0, MAX_ENTRIES_PER_DIR);

  const children = await Promise.all(
    entries.map(async (entry) => {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) return runTreeLimited(() => listTree(childRel, depth + 1));
      return { name: childRel, type: "file" };
    })
  );

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

function trimMessages(msgs: any[]): any[] {
  if (msgs.length <= 1) return [...msgs];
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
      if (toolName === "repo_browser.print_tree") {
        const toolPath = normalizeToolRelPath(args.path);
        const tree = await listTree(toolPath);
        res.write("event: tool_result\n");
        res.write(`data: ${JSON.stringify({ tool: toolName, result: tree })}\n\n`);
        return tree;
      }

      if (toolName === "repo_browser.read_file") {
        const toolPath = normalizeToolRelPath(args.path);
        const data = await readFileSafe(toolPath);
        res.write("event: tool_result\n");
        res.write(`data: ${JSON.stringify({ tool: toolName, result: data })}\n\n`);
        return data;
      }

      if (toolName === "repo_browser.create_directory") {
        const relPath = normalizeToolRelPath(args.path);
        const abs = await withinRoot(relPath);
        await fs.mkdir(abs, { recursive: true });
        const result = { ok: true, created: relPath };
        res.write("event: tool_result\n");
        res.write(`data: ${JSON.stringify({ tool: toolName, result })}\n\n`);
        return result;
      }

      if (toolName === "repo_browser.create_file") {
        const relPath = normalizeToolRelPath(args.path);
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

          res.write("event: tool_result\n");
          res.write(`data: ${JSON.stringify({ tool: toolName, result: r })}\n\n`);
          return r;
        } catch (e: any) {
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
    } finally {
      perfLog("tool.call", {
        tool: toolName,
        status,
        elapsedMs: elapsedMs(startedAt),
      });
    }
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
  const roundStartedAt = process.hrtime.bigint();
  const { res, lmAbort, effectiveModel, payload, toolsPayload, executeTool } = ctx;

  if (depth > MAX_TOOL_DEPTH) {
    res.write("event: error\n");
    res.write(`data: ${JSON.stringify({ message: "Too many tool-call rounds, aborting." })}\n\n`);
    return;
  }

  const lmUrl = dashboardState.apiBase || LM_CHAT_URL;

  let resp: any;
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
          temperature: payload.temperature ?? 0.2,
          ...toolsPayload,
        }),
        // @ts-ignore
        dispatcher: longLMAgent,
        signal: lmAbort.signal,
      });

      if (resp.ok && resp.body) break;
      lastFetchError = `HTTP ${resp.status}`;
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      lastFetchError = String(e?.message || e);
    }

    if (attempt < LM_MAX_RETRIES) {
      res.write("event: retry\n");
      res.write(
        `data: ${JSON.stringify({ attempt: attempt + 1, max: LM_MAX_RETRIES, reason: lastFetchError })}\n\n`
      );
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * attempt, 1000)));
    }
  }

  if (!resp || !resp.ok || !resp.body) {
    res.write("event: error\n");
    res.write(`data: ${JSON.stringify({ message: lastFetchError || "Upstream LM fetch failed" })}\n\n`);
    perfLog("chat.round", {
      depth,
      status: "upstream_error",
      attempts: attemptsUsed,
      elapsedMs: elapsedMs(roundStartedAt),
    });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  const toolBuffers: any[] = [];
  let sawToolCalls = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });
    let sep = sseBuffer.indexOf("\n\n");
    while (sep !== -1) {
      const rawEvent = sseBuffer.slice(0, sep);
      sseBuffer = sseBuffer.slice(sep + 2);
      sep = sseBuffer.indexOf("\n\n");

      const lines = rawEvent.split("\n");
      const dataLines: string[] = [];
      for (const raw of lines) {
        const ln = raw.replace(/\r$/, "");
        if (ln.startsWith("data:")) dataLines.push(ln.slice(5).trimStart());
      }

      const jsonPart = dataLines.join("\n").trim();
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
      perfLog("chat.round", {
        depth,
        status: "tool_calls",
        toolCalls: toolCallsForMsg.length,
        attempts: attemptsUsed,
        elapsedMs: elapsedMs(roundStartedAt),
      });
      await runChatWithTools(ctx, nextMessages, depth + 1);
      return;
    }
  }

  perfLog("chat.round", {
    depth,
    status: "done",
    attempts: attemptsUsed,
    elapsedMs: elapsedMs(roundStartedAt),
  });
}

function buildBaseMessages(userMessages: any[], currentRoot: string) {
  return trimMessages([{ role: "system", content: buildSystemPrompt(currentRoot) }, ...userMessages]);
}

async function handleChat(req: any, res: any) {
  const chatStartedAt = process.hrtime.bigint();
  let chatStatus = "ok";
  let userMsgCount = 0;
  const lmAbort = new AbortController();
  activeLmAbortController = lmAbort;

  res.on("close", () => {
    try {
      lmAbort.abort();
    } catch { }
  });

  let heartbeat: NodeJS.Timeout | null = null;

  try {
    await syncActiveProjectIntoRuntime();
    const payload: ChatPayload = await readJsonBody(req);
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
      chatStatus = "aborted";
      try { res.end(); } catch { }
      return;
    }

    chatStatus = "error";
    try {
      res.write("event: error\n");
      res.write(`data: ${JSON.stringify({ message: e?.message || "Internal error" })}\n\n`);
      res.end();
    } catch {
      // ignore
    }
  } finally {
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

  // Let MCP handler own these endpoints
  if (pathname === "/mcp/apply_patch" || pathname === "/mcp/rewrite_file") return;

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
      if (!activeId) throw new Error("No active project");

      await updateProject(
        activeId,
        {
          rootDir: patch.rootDir,
          apiBase: patch.apiBase ? normalizeApiBase(String(patch.apiBase)) : undefined,
          model: patch.model,
          mcpEnabled: patch.mcpEnabled,
        } as any,
        projectSettingsFallback()
      );
      await syncActiveProjectIntoRuntime();
      return json(res, dashboardState);
    } catch (e: any) {
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
      const created = await createProject(
        {
          name: body?.name,
          rootDir: body?.rootDir,
          apiBase: body?.apiBase ? normalizeApiBase(String(body.apiBase)) : undefined,
          model: body?.model,
          mcpEnabled: body?.mcpEnabled,
        } as any,
        projectSettingsFallback()
      );
      await syncActiveProjectIntoRuntime();
      return json(res, { ok: true, state: created });
    } catch (e: any) {
      return json(res, { ok: false, error: e?.message || String(e) }, 400);
    }
  }

  if (pathname === "/projects/active" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const projectId = String(body?.projectId || "");
      if (!projectId) throw new Error("Missing projectId");
      const next = await setActiveProject(projectId);
      await syncActiveProjectIntoRuntime();
      return json(res, { ok: true, state: next });
    } catch (e: any) {
      return json(res, { ok: false, error: e?.message || String(e) }, 400);
    }
  }

  const projectByIdMatch = pathname.match(/^\/projects\/([^/]+)$/);
  if (projectByIdMatch) {
    const projectId = decodeURIComponent(projectByIdMatch[1]);
    if (req.method === "PATCH") {
      try {
        const body = await readJsonBody(req);
        const next = await updateProject(
          projectId,
          {
            name: body?.name,
            rootDir: body?.rootDir,
            apiBase: body?.apiBase ? normalizeApiBase(String(body.apiBase)) : undefined,
            model: body?.model,
            mcpEnabled: body?.mcpEnabled,
          } as any,
          projectSettingsFallback()
        );
        if (getUIState().activeProjectId === projectId) await syncActiveProjectIntoRuntime();
        return json(res, { ok: true, state: next });
      } catch (e: any) {
        return json(res, { ok: false, error: e?.message || String(e) }, 400);
      }
    }
    if (req.method === "DELETE") {
      try {
        const next = await deleteProject(projectId);
        await syncActiveProjectIntoRuntime();
        return json(res, { ok: true, state: next });
      } catch (e: any) {
        return json(res, { ok: false, error: e?.message || String(e) }, 400);
      }
    }
  }

  const projectChatsMatch = pathname.match(/^\/projects\/([^/]+)\/chats$/);
  if (projectChatsMatch) {
    const projectId = decodeURIComponent(projectChatsMatch[1]);
    if (req.method === "GET") {
      try {
        return json(res, await listChats(projectId));
      } catch (e: any) {
        return json(res, { ok: false, error: e?.message || String(e) }, 400);
      }
    }
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const next = await createChat(projectId, typeof body?.title === "string" ? body.title : undefined);
        return json(res, { ok: true, state: next });
      } catch (e: any) {
        return json(res, { ok: false, error: e?.message || String(e) }, 400);
      }
    }
  }

  // ---- Chats ----
  if (pathname === "/chats/active" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const chatId = String(body?.chatId || "");
      if (!chatId) throw new Error("Missing chatId");
      const next = await setActiveChat(chatId);
      await syncActiveProjectIntoRuntime();
      return json(res, { ok: true, state: next });
    } catch (e: any) {
      return json(res, { ok: false, error: e?.message || String(e) }, 400);
    }
  }

  const chatByIdMatch = pathname.match(/^\/chats\/([^/]+)$/);
  if (chatByIdMatch) {
    const chatId = decodeURIComponent(chatByIdMatch[1]);
    if (req.method === "GET") {
      try {
        return json(res, { ok: true, chat: getChat(chatId) });
      } catch (e: any) {
        return json(res, { ok: false, error: e?.message || String(e) }, 404);
      }
    }
    if (req.method === "PATCH") {
      try {
        const body = await readJsonBody(req);
        const next = await updateChat(chatId, {
          title: body?.title,
          pinned: body?.pinned,
          messages: body?.messages,
        } as any);
        return json(res, { ok: true, state: next });
      } catch (e: any) {
        return json(res, { ok: false, error: e?.message || String(e) }, 400);
      }
    }
    if (req.method === "DELETE") {
      try {
        const next = await deleteChat(chatId);
        return json(res, { ok: true, state: next });
      } catch (e: any) {
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
      if (!message || typeof message !== "object") throw new Error("Missing message object");
      const role = typeof message.role === "string" ? message.role : "user";
      const next = await appendChatMessage(chatId, {
        ...message,
        role,
      });
      return json(res, { ok: true, state: next });
    } catch (e: any) {
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
    } catch (e: any) {
      return json(res, { data: [], error: String(e) }, 500);
    }
  }

  // ---- FS (editor) ----
  if (pathname === "/fs/read" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const p = String(body?.path || "");
      const content = await readFileSafe(p);
      return json(res, { ok: content !== null, content });
    } catch (e: any) {
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
    } catch (e: any) {
      return json(res, { ok: false, error: e?.message || String(e) }, 400);
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
    } catch (e: any) {
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
  const wantsJson =
    url.startsWith("/state") ||
    url.startsWith("/models") ||
    url.startsWith("/perf") ||
    url.startsWith("/projects") ||
    url.startsWith("/chats") ||
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
