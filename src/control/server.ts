// src/control/server.ts
// -------------------------------------------------------------
// Dashboard + LM Studio bridge with:
// - SSE streaming (patched to support long responses without disconnect)
// - Heartbeats
// - Buffered trimming
// - repo_browser.print_tree
// - repo_browser.read_file
// - repo_browser.apply_patch  -> routed to local /mcp/apply_patch
// - repo_browser.create_directory
// - repo_browser.create_file
// - repo_browser.rewrite_file -> routed to local /mcp/rewrite_file
// - Proper OpenAI-style tool calling (tool_calls -> tool results -> second run)
// -------------------------------------------------------------

import "dotenv/config";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { initRuntime, getRuntime } from "../runtime/index.js";
import { TextDecoder } from "node:util";
import { attachMCPToServer } from "../mcp/server.js";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------------------------------------------
// CONSTANTS
// -------------------------------------------------------------
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const MAX_TREE_DEPTH = 4;
const HEARTBEAT_MS = 15000;
const MAX_MODEL_CHARS = 32000;
const MAX_ENTRIES_PER_DIR = 200;
const MAX_TOOL_DEPTH = 30; // limită de recursie pentru tool-calls

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

// LM Studio base & chat URL
const LM_BASE = (
  process.env.LMSTUDIO_API_BASE || "http://localhost:1234/v1"
).replace(/\/+$/, "");

const LM_URL = `${LM_BASE}/chat/completions`;
const LM_MAX_RETRIES = 5;

// Dashboard base (for calling our own MCP HTTP endpoints)
const DASHBOARD_BASE =
  process.env.DASHBOARD_BASE?.replace(/\/+$/, "") || `http://localhost:${PORT}`;

// -------------------------------------------------------------
// SYSTEM PROMPT
// -------------------------------------------------------------
const SYSTEM_PROMPT = (() => {
  const rootDir = getRuntime().rootDir || ".";
  return `
You are a coding agent running inside an MCP environment.

You DO have access to tools that can read and modify files in the current repo.
Typical tools (names may vary) are:
- repo_browser.print_tree(path)
- repo_browser.read_file(path)
- repo_browser.create_file(path, content)
- repo_browser.create_directory(path)
- repo_browser.apply_patch(path, patch)  // unified diff
- repo_browser.rewrite_file(path, content)

You are a local code assistant running inside an MCP environment.

TOOLS:
- repo_browser.print_tree(path: string)
- repo_browser.read_file(path: string)
- repo_browser.apply_patch(patch: string)
- repo_browser.create_directory(path: string)
- repo_browser.create_file(path: string, content: string)
- repo_browser.rewrite_file(path: string, content: string)
- heartbeat(keepalive: boolean, note?: string)

LM STUDIO API:

GET
- /v1/models

POST
- /v1/responses
- /v1/chat/completions
- /v1/completions
- /v1/embeddings


GENERAL BEHAVIOR
----------------
- Always treat this as a real project, not a toy.
- Never invent files, folders, or technologies that are not already in the repo or explicitly requested by the user.
- Respect the existing architecture, style, and conventions.
- Prefer minimal, focused changes over big rewrites.

TOOL USAGE RULES
----------------
When the user asks for ANY change to the codebase:

1. Inspect first
   - If you don't know the file contents, call repo_browser.print_tree and repo_browser.read_file to see them.
   - Do NOT guess what a file contains.

2. Summarize + Plan
   - Briefly summarize what the relevant files do.
   - Outline a short plan (1–3 steps) for the change.

3. Edit via tools
   - Use repo_browser.apply_patch or repo_browser.rewrite_file to modify files.
   - Patches must be valid unified diffs against the CURRENT content you just read.
   - Only say “I updated X” AFTER you have actually called the tool.

4. No fake changes
   - Do NOT say “I added this button/file/logic” unless you just executed a tool call that really does that.
   - If for some reason you cannot call the tools, say clearly: “Here is the patch you should apply manually” and do NOT pretend it is applied.

PATCH STYLE
-----------
- Keep changes minimal and localized.
- Preserve existing formatting, imports, and structure where possible.
- Add comments only when they improve clarity or explain non-obvious logic.

CRITICAL RULES
--------------
1. Use repo_browser.read_file when the user asks for:
   - "content of file"
   - "open file X"
   - "show file X"
   - "what is inside X"
   For example:
   - User: "show me the content of index.html"
     -> CALL repo_browser.read_file with { "path": "index.html" }

2. Use repo_browser.print_tree ONLY when the user explicitly asks to:
   - "list files"
   - "show folder structure"
   - "print directory tree"
   Do NOT spam print_tree for the same path repeatedly.

3. For EDITS you have two options:

   a) repo_browser.apply_patch (PATCH-BASED)
      - Use when you can express the change as a patch and want to touch only
        a small part of a file.
      - The patch MUST use the simplified MCP patch format:

        *** Begin Patch
        *** Update File: src/example.ts
        @@ -1,3 +1,4 @@
        -old line
        +new line
        +another new line
        *** End Patch

        Add file:
        *** Begin Patch
        *** Add File: src/newFeature.ts
        +export function hello() {
        +  console.log("Hello");
        +}
        *** End Patch

        Delete file:
        *** Begin Patch
        *** Delete File: src/oldStuff.ts
        *** End Patch

      - Always include *** Begin Patch and *** End Patch markers.
      - Use *** Add File / *** Update File / *** Delete File headers.
      - For updates, include one or more @@ -oldStart,oldCount +newStart,newCount @@ hunks.

   b) repo_browser.rewrite_file (FULL-REWRITE)
      - Use when the file is being heavily refactored or almost completely changed,
        and writing a patch would be more complex than providing the new file.
      - This tool simply overwrites the entire file with the content you provide.

4. Do NOT call repo_browser.apply_patch or repo_browser.rewrite_file
   until the user explicitly confirms they want you to apply the changes
   you proposed. First:
   - Explain what you plan to change.
   - Optionally show the patch or new file content.
   - Wait for user confirmation like "OK, apply this".

5. When the user asks to create folders or files:
   - Use repo_browser.create_directory for creating a folder/directory.
   - Use repo_browser.create_file for creating a file with specific content.
   - Do NOT use repo_browser.apply_patch just to "fake" a folder by adding
     placeholder files (e.g. __init__.py, .gitkeep, README) unless the user
     explicitly asks for those files.

6. The heartbeat tool is a NO-OP that you can call sparingly in very long,
   multi-step tool workflows to keep the LM Studio tool pipeline active and
   to log progress with a short note.

FLOW FOR THIS PROJECT
---------------------
For this repository in particular:

- The main UI lives under ./src/control/index.html.
- The backend proxy / bridge for the LLM lives under ./src/control/server.ts.
- When the user asks for behavior that touches UI + server, you MUST:
  1) Read ./context.md
  2) Read ./src/control/index.html
  3) Read ./src/control/server.ts
  before proposing any patch.

- When the user says “ok, proceed” or “apply this”, that means:
  - Implement the plan using repo_browser.apply_patch or repo_browser.rewrite_file,
  - Then show the final code snippets for the touched areas.

HONESTY & SAFETY
----------------
- If you are unsure about the repo layout or tool names, ask or re-inspect with print_tree.
- Never claim a patch is applied if you didn't call a tool.
- If something fails or is ambiguous, explain the situation instead of improvising.

The workspace root directory is the MCP rootDir (currently: "${rootDir}").
Always treat paths as relative to this root.
`.trim();
})();

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

function json(res: any, obj: any, code = 200) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

type DashboardState = {
  apiBase: string;
  model?: string;
  rootDir: string;
  mcpEnabled: boolean;
};

let dashboardState: DashboardState = {
  apiBase: LM_URL,
  rootDir: getRuntime().rootDir || ".",
  mcpEnabled: true,
};

// Tracks the currently running LM Studio chat request so /abort can cancel it.
let activeLmAbortController: AbortController | null = null;

async function withinRoot(rel: string) {
  const root = path.resolve(
    (typeof dashboardState !== "undefined" && dashboardState.rootDir) ||
      getRuntime().rootDir ||
      "."
  );

  const abs = path.resolve(root, rel || ".");
  if (!abs.startsWith(root)) throw new Error("Path escapes project root");
  return abs;
}

// Recursively list files/directories
async function listTree(rel: string, depth = 0): Promise<any> {
  if (depth > MAX_TREE_DEPTH) {
    return {
      name: rel,
      type: "max-depth",
    };
  }

  const abs = await withinRoot(rel);
  const st = await fs.stat(abs);

  if (!st.isDirectory()) {
    return {
      name: rel,
      type: "file",
    };
  }

  let entries = await fs.readdir(abs, { withFileTypes: true });

  // Ignore heavy/system dirs
  entries = entries.filter((entry) => !IGNORED_DIRS.has(entry.name));

  // Hard cap to avoid huge payloads
  if (entries.length > MAX_ENTRIES_PER_DIR) {
    entries = entries.slice(0, MAX_ENTRIES_PER_DIR);
  }

  const children: any[] = [];

  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;

    if (entry.isDirectory()) {
      children.push(await listTree(childRel, depth + 1));
    } else {
      children.push({
        name: childRel,
        type: "file",
      });
    }
  }

  return {
    name: rel,
    type: "dir",
    children,
  };
}

// Safely read file
async function readFileSafe(rel: string) {
  const abs = await withinRoot(rel);
  try {
    const data = await fs.readFile(abs, "utf8");
    return data;
  } catch {
    return null;
  }
}

// Trim a too-large conversation
function trimMessages(msgs: any[]): any[] {
  let out = [...msgs];
  let totalChars = out.reduce((acc, m) => acc + JSON.stringify(m).length, 0);

  while (totalChars > MAX_MODEL_CHARS && out.length > 1) {
    out.shift(); // drop oldest
    totalChars = out.reduce((acc, m) => acc + JSON.stringify(m).length, 0);
  }

  return out;
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

// -------------------------------------------------------------
// Types for chat engine
// -------------------------------------------------------------
type ToolExecutor = (toolName: string, args: any) => Promise<any>;

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

// -------------------------------------------------------------
// Chat helpers (functional-ish / composable)
// -------------------------------------------------------------

function buildBaseMessages(userMessages: any[], currentRoot: string) {
  return trimMessages([
    {
      role: "system",
      content: SYSTEM_PROMPT.replace(
        "workspace root directory is the MCP rootDir",
        `workspace root directory is the MCP rootDir (currently: "${currentRoot}")`
      ),
    },
    ...userMessages,
  ]);
}

function startHeartbeat(res: any): NodeJS.Timeout {
  return setInterval(() => {
    try {
      res.write("event: heartbeat\n");
      res.write('data: { "keepalive": true }\n\n');
    } catch (err) {
      console.error("[chat] heartbeat write failed:", err);
      // If writing fails, SSE is probably closing; we just stop heartbeats.
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat(timer: NodeJS.Timeout | null) {
  if (!timer) return;
  clearInterval(timer);
}

// Create a ToolExecutor bound to this response stream
function createExecuteTool(res: any): ToolExecutor {
  return async (toolName: string, args: any): Promise<any> => {
    console.log("[mcp] executeTool hit:", toolName, "args:", args);

    if (!toolName) {
      const err = { error: "Missing tool name" };
      res.write("event: tool_result\n");
      res.write(
        `data: ${JSON.stringify({
          tool: toolName || "unknown",
          result: err,
        })}\n\n`
      );
      return err;
    }

    if (toolName === "repo_browser.print_tree") {
      const tree = await listTree(args.path || "");
      res.write("event: tool_result\n");
      res.write(
        `data: ${JSON.stringify({ tool: toolName, result: tree })}\n\n`
      );
      return tree;
    }

    if (toolName === "repo_browser.read_file") {
      const data = await readFileSafe(args.path || "");
      res.write("event: tool_result\n");
      res.write(
        `data: ${JSON.stringify({ tool: toolName, result: data })}\n\n`
      );
      return data;
    }

    if (toolName === "repo_browser.create_directory") {
      const relPath = args.path || "";
      const abs = await withinRoot(relPath);

      await fs.mkdir(abs, { recursive: true });

      const result = {
        ok: true,
        created: relPath,
      };

      res.write("event: tool_result\n");
      res.write(`data: ${JSON.stringify({ tool: toolName, result })}\n\n`);
      return result;
    }

    if (toolName === "repo_browser.create_file") {
      const relPath = args.path || "";
      const content = typeof args.content === "string" ? args.content : "";

      const abs = await withinRoot(relPath);
      const dir = path.dirname(abs);

      // Ensure parent directory exists
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(abs, content, "utf8");

      const result = {
        ok: true,
        path: relPath,
        bytes: Buffer.byteLength(content, "utf8"),
      };

      res.write("event: tool_result\n");
      res.write(`data: ${JSON.stringify({ tool: toolName, result })}\n\n`);
      return result;
    }

    if (toolName === "repo_browser.apply_patch") {
      try {
        const url = `${DASHBOARD_BASE}/mcp/apply_patch`;
        console.log("[apply_patch] calling", url);

        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: args.patch }),
          //@ts-ignore
          dispatcher: longLMAgent,
        }).then((x) => x.json());

        res.write("event: tool_result\n");
        res.write(
          `data: ${JSON.stringify({ tool: toolName, result: r })}\n\n`
        );
        return r;
      } catch (e: any) {
        const err = {
          error: "Failed to call /mcp/apply_patch",
          detail: String(e?.message || e),
        };
        console.error("[apply_patch] error:", err);
        res.write("event: tool_result\n");
        res.write(
          `data: ${JSON.stringify({ tool: toolName, result: err })}\n\n`
        );
        return err;
      }
    }

    if (toolName === "repo_browser.rewrite_file") {
      try {
        const url = `${DASHBOARD_BASE}/mcp/rewrite_file`;
        console.log("[rewrite_file] calling", url);

        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: args.path,
            content: args.content,
          }),
          //@ts-ignore
          dispatcher: longLMAgent,
        }).then((x) => x.json());

        res.write("event: tool_result\n");
        res.write(
          `data: ${JSON.stringify({ tool: toolName, result: r })}\n\n`
        );
        return r;
      } catch (e: any) {
        const err = {
          error: "Failed to call /mcp/rewrite_file",
          detail: String(e?.message || e),
        };
        console.error("[rewrite_file] error:", err);
        res.write("event: tool_result\n");
        res.write(
          `data: ${JSON.stringify({ tool: toolName, result: err })}\n\n`
        );
        return err;
      }
    }

    const errUnknown = { error: "Unknown tool" };
    res.write("event: tool_result\n");
    res.write(
      `data: ${JSON.stringify({
        tool: toolName,
        result: errUnknown,
      })}\n\n`
    );
    return errUnknown;
  };
}

// Core LM + tools loop, now parameterized by ChatContext
async function runChatWithTools(
  ctx: ChatContext,
  messages: any[],
  depth = 0
): Promise<void> {
  const {
    res,
    lmAbort,
    effectiveModel,
    payload,
    toolsPayload,
    executeTool,
  } = ctx;

  if (depth > MAX_TOOL_DEPTH) {
    console.warn(
      `[bridge] Exceeded MAX_TOOL_DEPTH=${MAX_TOOL_DEPTH}, aborting tool loop`
    );
    res.write("event: error\n");
    res.write(
      `data: ${JSON.stringify({
        message: "Too many tool-call rounds, aborting.",
      })}\n\n`
    );
    return;
  }

  let resp;
  const lmUrlFromState = dashboardState.apiBase || LM_URL;

  for (let attempt = 1; attempt <= LM_MAX_RETRIES; attempt++) {
    try {
      console.log(
        `[bridge] LM chat attempt ${attempt}/${LM_MAX_RETRIES} → ${lmUrlFromState}`
      );
      resp = await fetch(lmUrlFromState, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: effectiveModel,
          stream: true,
          messages,
          temperature: payload.temperature ?? 0.2,
          ...toolsPayload,
        }),
        //@ts-ignore
        dispatcher: longLMAgent,
        signal: lmAbort.signal, // /abort will trigger this
      });
      if (resp.ok && resp.body) {
        break;
      } else {
        console.error(
          "[bridge] LM chat attempt failed:",
          resp.status,
          resp.statusText
        );
      }
    } catch (err: any) {
      // If /abort triggered this, don't retry.
      if (err && err.name === "AbortError") {
        console.log(
          "[bridge] LM chat aborted via /abort; not retrying further attempts"
        );
        throw err;
      }

      console.error(
        "[bridge] LM chat network error on attempt",
        attempt,
        err
      );
    }
  }

  if (!resp || !resp.ok || !resp.body) {
    res.write("event: error\n");
    res.write(
      `data: ${JSON.stringify({
        message: "Upstream LM fetch failed after retries",
      })}\n\n`
    );
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();

  // collect streamed tool_calls (per index)
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
        // garbage / keep-alive lines from LM Studio, ignore
        continue;
      }

      if (deltaObj.error) {
        console.error("[LM ERROR]", deltaObj.error);
        res.write("event: error\n");
        res.write(
          `data: ${JSON.stringify({
            message: deltaObj.error.message || "LM Studio error",
            raw: deltaObj.error,
          })}\n\n`
        );
        continue;
      }

      const choice = deltaObj.choices?.[0];
      const delta = choice?.delta || {};
      const finishReason = choice?.finish_reason;

      // --- TOOL CALL HANDLING -----------------------------
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        sawToolCalls = true;

        for (const tc of delta.tool_calls) {
          const idx = (tc as any).index ?? 0;
          if (!toolBuffers[idx]) {
            toolBuffers[idx] = {
              id: tc.id || undefined,
              type: "function",
              function: { name: "", arguments: "" },
            };
          }

          const buf = toolBuffers[idx];
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.function.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") {
            buf.function.arguments += tc.function.arguments;
          }
        }

        // When finish_reason === "tool_calls", we know first phase is done.
        if (finishReason === "tool_calls") {
          // Let the outer loop finish, we'll handle tools after.
        }

        // Do NOT emit normal text during the tool_call phase.
        continue;
      }
      // ---------------------------------------------------

      // Normal assistant text (no tool calls in this phase)
      if (delta.content) {
        const content = Array.isArray(delta.content)
          ? delta.content
              .map((c: any) => (typeof c === "string" ? c : c.text || ""))
              .join("")
          : delta.content;

        if (content) {
          res.write("event: message\n");
          res.write(
            `data: ${JSON.stringify({
              role: "assistant",
              text: content,
            })}\n\n`
          );
        }
      }
    }
  }

  // If we saw tool_calls, execute tools, send tool messages,
  // and then recursively call the model again to get final text.
  if (sawToolCalls && toolBuffers.length > 0) {
    const toolCallsForMsg: any[] = [];
    const toolResultMessages: any[] = [];

    for (let i = 0; i < toolBuffers.length; i++) {
      const buf = toolBuffers[i];
      if (!buf || !buf.function?.name) continue;

      let parsedArgs: any;
      try {
        parsedArgs = JSON.parse(buf.function.arguments || "{}");
      } catch {
        parsedArgs = {};
      }

      const id = buf.id || `tool_call_${i}`;
      const name = buf.function.name;

      console.log("[tool-call complete]", {
        name,
        id,
        args: parsedArgs,
      });

      const result = await executeTool(name, parsedArgs);

      toolCallsForMsg.push({
        id,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(parsedArgs),
        },
      });

      toolResultMessages.push({
        role: "tool",
        tool_call_id: id,
        name,
        content: JSON.stringify(result),
      });
    }

    if (toolCallsForMsg.length > 0) {
      const assistantToolMessage = {
        role: "assistant",
        tool_calls: toolCallsForMsg,
      };

      const nextMessages = [
        ...messages,
        assistantToolMessage,
        ...toolResultMessages,
      ];

      // Second phase: call the model again, now with tool results in context.
      await runChatWithTools(ctx, nextMessages, depth + 1);
    }
  }
}

// -------------------------------------------------------------
// TOOLS (OpenAI-style declaration)
// -------------------------------------------------------------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "repo_browser.read_file",
      description: `
Read the TEXT CONTENT of a single file from the project.

USE THIS TOOL WHEN:
- The user asks for the content of a file:
  - "show me the content of index.html"
  - "open src/control/server.ts"
  - "give me the code in this file"
- You need to inspect a file before suggesting changes or explaining what it does.

DO NOT USE THIS TOOL WHEN:
- The user wants a list of files or folder structure → use repo_browser.print_tree.
- You want to CHANGE or EDIT a file → use repo_browser.apply_patch or repo_browser.rewrite_file.

Pass the relative file path from the project root (e.g. "index.html", "src/control/server.ts").
If the file does not exist or cannot be read, explain that to the user.
`.trim(),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Relative path to the file from the project root (e.g. "index.html", "src/app.ts").',
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_browser.create_directory",
      description: `
Create a new directory at the given relative path from the project root.

USE THIS TOOL WHEN:
- The user asks you to "create a folder", "add a directory", or "make a new folder".

BEHAVIOR:
- Creates the directory (and any missing parent directories) using a path relative
  to the project root.
- Does NOT create any files inside it. If the user wants files too, call
  repo_browser.create_file or repo_browser.apply_patch separately.
`.trim(),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Relative directory path from the project root (e.g. "test", "src/test", "src/features/auth").',
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_browser.create_file",
      description: `
Create or overwrite a single TEXT file at the given relative path from the project root.

USE THIS TOOL WHEN:
- The user asks you to "create a file", "add file X", or "create file X with this content".

BEHAVIOR:
- Ensures parent directories exist (creates them if needed).
- Writes the provided content (UTF-8). Overwrites the file if it already exists.

DO NOT USE THIS TOOL WHEN:
- You need to perform a complex refactor across multiple files → use repo_browser.apply_patch
  or repo_browser.rewrite_file.
`.trim(),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Relative file path from the project root (e.g. "test/README.md", "src/test/index.ts").',
          },
          content: {
            type: "string",
            description:
              "The full text content to write into the file (UTF-8). Can be empty string for an empty file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_browser.apply_patch",
      description: `
Apply a simplified MCP patch to one file in the project.

FORMAT (MANDATORY):

1) Update an existing file:

*** Begin Patch
*** Update File: relative/path/to/file.ts
@@ -oldStart,oldCount +newStart,newCount @@
-context line or old text
-old line
+new line
+another new line
*** End Patch

2) Add a NEW file:

*** Begin Patch
*** Add File: relative/path/to/newFile.ts
+first line of file
+second line of file
*** End Patch

3) Delete a file:

*** Begin Patch
*** Delete File: relative/path/to/file.ts
*** End Patch

RULES:
- Always include *** Begin Patch and *** End Patch markers on their own lines.
- Use exactly one of:
  - *** Add File: PATH
  - *** Update File: PATH
  - *** Delete File: PATH
- For "Add File", the tool collects every line starting with '+' (excluding '+++')
  as the file content.
- For "Update File", you must provide one or more hunks with headers like:
  @@ -oldStart,oldCount +newStart,newCount @@
  and lines beginning with:
    ' ' (space) or no prefix → context
    '+' → added line
    '-' → removed line
- Paths are always relative to the workspace root.

USE THIS TOOL WHEN:
- You want to make precise, local edits (small sections of a file).
- You want to preserve existing content and only change specific hunks.

If the user only wants to see code, use repo_browser.read_file.
For heavy refactors or complete rewrites of a file, prefer repo_browser.rewrite_file.
`.trim(),
      parameters: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description:
              "Simplified MCP patch text (*** Begin Patch ... *** End Patch) for a single file add/update/delete.",
          },
        },
        required: ["patch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_browser.rewrite_file",
      description: `
Overwrite an entire file with new content.

USE THIS TOOL WHEN:
- The file is heavily refactored or almost completely changed.
- Generating a diff/patch would be more complex than writing the new version.
- You have already inspected the existing file with repo_browser.read_file and
  the user has confirmed that they want to apply your proposed rewrite.

BEHAVIOR:
- Resolves the given path relative to the project root.
- Ensures the parent directory exists (creates it if needed).
- Writes the provided content (UTF-8), replacing any existing file.

This is a destructive operation. Only call it after the user explicitly approves
the rewrite.
`.trim(),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Relative file path from the project root (e.g. "src/control/server.ts").',
          },
          content: {
            type: "string",
            description:
              "The full new content for the file (UTF-8). This will completely replace the existing file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_browser.print_tree",
      description: `
List files and directories under a relative path from the project root.

USE THIS TOOL WHEN:
- The user explicitly asks for: "folder structure", "directory tree", "list of files", "what is in this folder", etc.
- You need an overview of what files or subfolders exist under a given path.

DO NOT USE THIS TOOL WHEN:
- The user asks for the *content* of a file (e.g. "show me index.html", "give me the code in server.ts",
  "what is inside this file"). In those cases, ALWAYS use repo_browser.read_file instead.
- You want to modify a file. For edits, use repo_browser.apply_patch or repo_browser.rewrite_file.

ALWAYS pass a path relative to the project root (e.g. ".", "src", "src/app").
Use "." ONLY when you really need the root folder structure.
`.trim(),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Relative path from the project root to list (e.g. ".", "src", "src/app").',
          },
        },
        required: ["path"],
      },
    },
  },
];

// -------------------------------------------------------------
// CHAT ROUTE  (SSE + proper tools)
// -------------------------------------------------------------
//fetch disable default
const longLMAgent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 0,
});

async function handleChat(req: any, res: any) {
  // Abort controller for this /chat → LM Studio request.
  // It will ONLY be triggered explicitly via the /abort endpoint.
  const lmAbort = new AbortController();
  activeLmAbortController = lmAbort;

  let heartbeat: NodeJS.Timeout | null = null;

  try {
    const payload: ChatPayload = await readJsonBody(req);
    const userMessages = payload.messages || [];

    const currentRoot = dashboardState.rootDir || getRuntime().rootDir || ".";
    const baseMessages = buildBaseMessages(userMessages, currentRoot);

    let effectiveModel = payload.model || dashboardState.model || "default";
    if (payload.model && payload.model !== dashboardState.model) {
      dashboardState = { ...dashboardState, model: payload.model };
    }

    // Prepare SSE response stream
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.flushHeaders();
    res.setTimeout(0);

    heartbeat = startHeartbeat(res);

    // Respect dashboardState.mcpEnabled (default true)
    const mcpEnabled = dashboardState.mcpEnabled !== false;
    const toolsPayload = mcpEnabled
      ? {
          tools: TOOLS,
          tool_choice: "auto" as const,
        }
      : {};

    const executeTool = createExecuteTool(res);

    const ctx: ChatContext = {
      res,
      lmAbort,
      effectiveModel,
      payload,
      toolsPayload,
      executeTool,
    };

    // Kick off the first phase
    await runChatWithTools(ctx, baseMessages);

    stopHeartbeat(heartbeat);
    activeLmAbortController = null;
    res.end();
  } catch (e: any) {
    activeLmAbortController = null;
    stopHeartbeat(heartbeat);

    // AbortError here means /abort was called.
    if (e && e.name === "AbortError") {
      console.log("[chat] LM request aborted via /abort");
      try {
        if (!res.headersSent) {
          res.end();
        }
      } catch {
        // ignore
      }
      return;
    }

    try {
      res.write("event: error\n");
      res.write(
        `data: ${JSON.stringify({
          message: e.message || "Internal error",
        })}\n\n`
      );
      res.end();
    } catch (err: any) {
      console.error("handleChat error in end callback:", err);
      // If we’re already in SSE mode (headers sent), only send an SSE error event
      if (res.headersSent) {
        try {
          res.write(`event: error\n`);
          res.write(
            `data: ${JSON.stringify({
              message: err?.message || "internal error",
            })}\n\n`
          );
        } catch (writeErr) {
          console.error("Failed to write SSE error event:", writeErr);
          // At this point the connection is basically dead; just stop.
        }
        return;
      }

      try {
        json(
          res,
          { error: err?.message || "Internal error (before stream)" },
          500
        );
      } catch (writeErr) {
        console.error("Failed to send JSON 500 from handleChat:", writeErr);
      }
    }
  }
}

// -------------------------------------------------------------
// MAIN HTTP SERVER
// -------------------------------------------------------------
await initRuntime();

const server = createServer(async (req, res) => {
  // Let MCP handler own these endpoints (attachMCPToServer will handle them)
  if (req.url === "/mcp/apply_patch" || req.url === "/mcp/rewrite_file") {
    return;
  }

  // --- STATE API -------------------------------------------------
  if (req.url === "/state" && req.method === "GET") {
    return json(res, dashboardState);
  }

  if (req.url === "/state" && req.method === "POST") {
    try {
      const patch = await readJsonBody(req);
      dashboardState = { ...dashboardState, ...patch };
      return json(res, dashboardState);
    } catch (e: any) {
      return json(res, { error: e.message }, 400);
    }
  }

  // --- MODELS API ------------------------------------------------
  if (req.url === "/models" && req.method === "GET") {
    console.log("asds");
    console.log(LM_BASE);
    try {
      const modelsUrl = `${LM_BASE}/models`;
      const r = await fetch(modelsUrl);
      const data = await r.json();
      console.log("data:" + data);
      return json(res, data);
    } catch (e: any) {
      console.log(e);
      return json(res, { data: [], error: String(e) }, 500);
    }
  }

  // Serve dashboard HTML on GET /
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

  // Abort the current LM Studio chat request
  if (req.method === "POST" && req.url === "/abort") {
    if (activeLmAbortController) {
      activeLmAbortController.abort();
      activeLmAbortController = null;
      return json(res, { ok: true, aborted: true });
    } else {
      // Nothing running, but still respond OK so the UI doesn’t freak out
      return json(res, { ok: true, aborted: false });
    }
  }

  // Chat route
  if (req.method === "POST" && req.url === "/chat") {
    return handleChat(req, res);
  }

  // Basic health check
  if (req.method === "GET" && req.url === "/healthz") {
    return json(res, { ok: true });
  }

  // Fallback
  res.statusCode = 404;
  res.end("Not Found");
});

server.requestTimeout = 0; // Node 18+
// optionally:
server.keepAliveTimeout = 0; // no keep-alive timeout
server.headersTimeout = 0; // no header timeout

// Attach MCP tools to same server instance
attachMCPToServer(server);

// Start server
server.listen(PORT, () => {
  console.log(`[dashboard] running at http://localhost:${PORT}`);
  console.log(`LM Studio base: ${LM_BASE}`);
  console.log(`DASHBOARD_BASE: ${DASHBOARD_BASE}`);
});
