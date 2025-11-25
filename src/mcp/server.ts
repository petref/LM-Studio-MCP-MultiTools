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
//   - JSON HTTP API POST /mcp/rewrite_file (full file overwrite)
//
// IMPORTANT:
// This server is *MCP-rooted* — it uses MCP_ROOT_DIR (or process.cwd())
// as the root folder, to stay in sync with repo_browser.print_tree.
// It does NOT depend on dashboard runtime.json, so tree + patch see
// the exact same filesystem.
// --------------------------------------------------------------------

import { promises as fs } from "node:fs";
import path from "node:path";

// ===============================================================
// Root-safe path resolution (MCP-rooted)
// ===============================================================

// Cache the MCP root once; this should match the root that your MCP
// repo_browser tools use (typically MCP_ROOT_DIR).
const MCP_ROOT = path.resolve(process.env.MCP_ROOT_DIR || process.cwd());

export async function withinRoot(relPath: string): Promise<string> {
  // Normalize relative path (allow empty / ".")
  const rel = relPath && relPath.trim() ? relPath : ".";
  const abs = path.resolve(MCP_ROOT, rel);

  if (!abs.startsWith(MCP_ROOT)) {
    throw new Error(
      `Refusing to write outside MCP root. rel="${relPath}", MCP_ROOT="${MCP_ROOT}"`
    );
  }

  return abs;
}

// ===============================================================
// Patch types
// ===============================================================
export interface PatchHunkLine {
  type: "context" | "add" | "remove";
  text: string;
}

export interface PatchHunk {
  oldRange: { start: number; count: number };
  newRange: { start: number; count: number };
  lines: PatchHunkLine[];
}

export interface ParsedPatch {
  op: "add" | "update" | "delete";
  path: string;
  newContent?: string; // for add file
  hunks: PatchHunk[];
}

// ===============================================================
// Parse patch
// ===============================================================
export function parseSimplifiedPatch(raw: string): ParsedPatch {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  if (!lines[0]?.includes("*** Begin Patch")) {
    throw new Error("Patch missing *** Begin Patch");
  }

  let op: "add" | "update" | "delete" | null = null;
  let filePath = "";

  // Detect op
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

  // DELETE is trivial
  if (op === "delete") {
    return { op: "delete", path: filePath, hunks: [] };
  }

  // ADD: collect all +lines (ignore +++ header)
  if (op === "add") {
    const contentLines: string[] = [];
    for (const l of lines) {
      if (l.startsWith("+") && !l.startsWith("+++")) {
        contentLines.push(l.slice(1));
      }
    }
    const final = contentLines.join("\n") + (contentLines.length ? "\n" : "");
    return { op: "add", path: filePath, hunks: [], newContent: final };
  }

  // UPDATE
  const hunkHeader = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/;
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;

  for (const line of lines) {
    const m = line.match(hunkHeader);
    if (m) {
      // push previous hunk
      if (current) hunks.push(current);

      current = {
        oldRange: { start: Number(m[1]), count: Number(m[2]) },
        newRange: { start: Number(m[3]), count: Number(m[4]) },
        lines: [],
      };
      continue;
    }

    if (current) {
      // classify hunk lines
      if (line.startsWith("+") && !line.startsWith("+++")) {
        current.lines.push({ type: "add", text: line.slice(1) });
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        current.lines.push({ type: "remove", text: line.slice(1) });
      } else if (!line.startsWith("***") && !line.startsWith("@@")) {
        // treat everything else as context
        current.lines.push({ type: "context", text: line });
      }
    }
  }

  if (current) hunks.push(current);

  return { op: "update", path: filePath, hunks };
}

// ===============================================================
// Apply patch
// ===============================================================
export async function applyParsedPatch(parsed: ParsedPatch): Promise<void> {
  const abs = await withinRoot(parsed.path);

  // DELETE
  if (parsed.op === "delete") {
    await fs.unlink(abs).catch(() => {});
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
  } catch {
    // log for debugging, but throw a clean error for the tool result
    throw new Error(`File not found for update: ${parsed.path}`);
  }

  let lines = original.replace(/\r\n/g, "\n").split("\n");

  // apply hunks sequentially (ranges are 1-based)
  for (const h of parsed.hunks) {
    const start = h.oldRange.start - 1;

    const replace: string[] = [];
    for (const ln of h.lines) {
      if (ln.type === "add" || ln.type === "context") {
        replace.push(ln.text);
      }
      // ln.type === "remove" is skipped → line is removed
    }

    lines.splice(start, h.oldRange.count, ...replace);
  }

  const finalText = lines.join("\n") + "\n";
  await fs.writeFile(abs, finalText, "utf8");
}

// ===============================================================
// Full file rewrite helper (for /mcp/rewrite_file)
// ===============================================================
async function rewriteFile(pathRel: string, content: string): Promise<void> {
  const abs = await withinRoot(pathRel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content ?? "", "utf8");
}

// ===============================================================
// HTTP API
// ===============================================================
export function attachMCPToServer(server: any) {
  server.on("request", async (req: any, res: any) => {
    if (req.method !== "POST") return;

    // PATCH endpoint: simplified patch format
    if (req.url === "/mcp/apply_patch") {
      let body = "";
      req.on("data", (c: any) => (body += c));
      req.on("end", async () => {
        try {
          const { patch } = JSON.parse(body);
          const parsed = parseSimplifiedPatch(patch);
          await applyParsedPatch(parsed);

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({ ok: true, path: parsed.path, op: parsed.op })
          );
        } catch (e: any) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // REWRITE endpoint: full file content overwrite
    if (req.url === "/mcp/rewrite_file") {
      let body = "";
      req.on("data", (c: any) => (body += c));
      req.on("end", async () => {
        try {
          const { path: relPath, content } = JSON.parse(body);

          if (typeof relPath !== "string" || !relPath.trim()) {
            throw new Error("Missing or invalid 'path' for rewrite_file");
          }

          await rewriteFile(relPath, typeof content === "string" ? content : "");

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, path: relPath, op: "rewrite" }));
        } catch (e: any) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  });
}

