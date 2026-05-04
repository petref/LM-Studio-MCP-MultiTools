#!/usr/bin/env node
/* eslint-disable no-console */

import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sseData(res, payload, delimiter = "\n\n") {
  res.write(`data: ${JSON.stringify(payload)}${delimiter}`);
}

function getLatestUserText(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const textPart = m.content.find((p) => p?.type === "text" && typeof p.text === "string");
      if (textPart) return textPart.text;
    }
  }
  return "";
}

async function getJson(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function parseChatEvents(baseUrl, messageText) {
  const res = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: messageText }],
      stream: true,
    }),
  });
  assert(res.ok && res.body, `chat request failed: HTTP ${res.status}`);

  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep = buffer.search(/\r?\n\r?\n/);
    while (sep !== -1) {
      const raw = buffer.slice(0, sep);
      const delim = buffer.slice(sep).match(/^\r?\n\r?\n/);
      const delimLen = delim ? delim[0].length : 2;
      buffer = buffer.slice(sep + delimLen);

      const lines = raw.split("\n").map((x) => x.replace(/\r$/, ""));
      let event = "message";
      let data = "";
      for (const ln of lines) {
        if (ln.startsWith("event:")) event = ln.slice(6).trim();
        if (ln.startsWith("data:")) data += (data ? "\n" : "") + ln.slice(5).trimStart();
      }
      if (!data) {
        sep = buffer.search(/\r?\n\r?\n/);
        continue;
      }

      let payload = {};
      try {
        payload = JSON.parse(data);
      } catch {
        payload = { raw: data };
      }
      events.push({ event, payload });
      sep = buffer.search(/\r?\n\r?\n/);
    }
  }

  return events;
}

function createMockLmServer() {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const marker = getLatestUserText(messages);
      const hasToolMessage = messages.some((m) => m?.role === "tool");

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      if (marker.includes("[TEST_CRLF]")) {
        sseData(
          res,
          { choices: [{ delta: { content: "CRLF_OK" }, finish_reason: null }] },
          "\r\n\r\n"
        );
        sseData(res, { choices: [{ delta: {}, finish_reason: "stop" }] }, "\r\n\r\n");
        res.end("data: [DONE]\r\n\r\n");
        return;
      }

      if (marker.includes("[TEST_INVALID_ARGS]")) {
        if (!hasToolMessage) {
          sseData(res, {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tc_invalid_args",
                      type: "function",
                      function: { name: "repo_browser.read_file", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          });
          res.end("data: [DONE]\n\n");
          return;
        }
        sseData(res, { choices: [{ delta: { content: "INVALID_ARGS_HANDLED" }, finish_reason: null }] });
        sseData(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
        res.end("data: [DONE]\n\n");
        return;
      }

      if (marker.includes("[TEST_DEPTH]")) {
        sseData(res, {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `tc_depth_${Date.now()}`,
                    type: "function",
                    function: { name: "repo_browser.print_tree", arguments: JSON.stringify({ path: "." }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
        res.end("data: [DONE]\n\n");
        return;
      }

      if (marker.includes("[TEST_ESCAPE]")) {
        if (!hasToolMessage) {
          sseData(res, {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tc_escape",
                      type: "function",
                      function: { name: "repo_browser.read_file", arguments: JSON.stringify({ path: "../outside.txt" }) },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          });
          res.end("data: [DONE]\n\n");
          return;
        }
        sseData(res, { choices: [{ delta: { content: "ESCAPE_HANDLED" }, finish_reason: null }] });
        sseData(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
        res.end("data: [DONE]\n\n");
        return;
      }

      if (marker.includes("[TEST_NEW_TOOLS]")) {
        if (!hasToolMessage) {
          sseData(res, {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tc_search",
                      type: "function",
                      function: {
                        name: "repo_browser.search_code",
                        arguments: JSON.stringify({ query: "alpha", globs: ["*.txt"] }),
                      },
                    },
                    {
                      index: 1,
                      id: "tc_chunk",
                      type: "function",
                      function: {
                        name: "repo_browser.read_file_chunk",
                        arguments: JSON.stringify({ path: "notes.txt", startLine: 1, endLine: 2 }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          });
          res.end("data: [DONE]\n\n");
          return;
        }
        sseData(res, { choices: [{ delta: { content: "NEW_TOOLS_OK" }, finish_reason: null }] });
        sseData(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
        res.end("data: [DONE]\n\n");
        return;
      }

      sseData(res, { choices: [{ delta: { content: "DEFAULT_OK" }, finish_reason: null }] });
      sseData(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      res.end("data: [DONE]\n\n");
    });
  });

  return server;
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      if (r.ok) return;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error(`Timeout waiting for ${baseUrl}/healthz`);
}

async function main() {
  const repoRoot = process.cwd();
  const tempBase = await mkdtemp(path.join(tmpdir(), "rag-e2e-"));
  const workspaceRoot = path.join(tempBase, "workspace");
  const stateDir = path.join(tempBase, "state");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src", "sample.txt"), "alpha\nbeta\ngamma\n", "utf8");
  await writeFile(path.join(workspaceRoot, "notes.txt"), "alpha line 1\nalpha line 2\nline 3\n", "utf8");

  const mockLm = createMockLmServer();
  await new Promise((resolve) => mockLm.listen(0, "127.0.0.1", resolve));
  const lmPort = mockLm.address().port;
  const lmBase = `http://127.0.0.1:${lmPort}/v1`;

  const dashboardPort = 8797;
  const dashboardBase = `http://127.0.0.1:${dashboardPort}`;
  const runtimePath = path.join(stateDir, "runtime.json");
  const uiStatePath = path.join(stateDir, "ui_state.json");
  await writeFile(
    runtimePath,
    JSON.stringify(
      {
        rootDir: workspaceRoot,
        apiBase: lmBase,
        model: "mock-model",
        mcpEnabled: true,
      },
      null,
      2
    ),
    "utf8"
  );

  process.env.DASHBOARD_PORT = String(dashboardPort);
  process.env.DASHBOARD_BASE = dashboardBase;
  process.env.LMSTUDIO_API_BASE = lmBase;
  process.env.RUNTIME_JSON = runtimePath;
  process.env.UI_STATE_JSON = uiStatePath;
  process.env.MCP_ROOT_DIR = workspaceRoot;
  process.env.MCP_TOOLS_ENABLED = "true";
  let dashboardServer = null;

  try {
    const dashboardModule = pathToFileURL(path.join(repoRoot, "dist/control/server.js")).href;
    const dashboardRuntime = await import(`${dashboardModule}?rag_e2e=${Date.now()}`);
    dashboardServer = dashboardRuntime?.server || null;
    await waitForHealth(dashboardBase);

    console.log("[rag-e2e] test 1: CRLF SSE parsing");
    {
      const events = await parseChatEvents(dashboardBase, "[TEST_CRLF]");
      assert(events.some((e) => e.event === "message" && e.payload?.text === "CRLF_OK"), "CRLF message not forwarded");
      assert(events.some((e) => e.event === "done"), "CRLF flow missing done event");
    }

    console.log("[rag-e2e] test 2: invalid tool args handling");
    {
      const events = await parseChatEvents(dashboardBase, "[TEST_INVALID_ARGS]");
      const invalid = events.find(
        (e) =>
          e.event === "tool_result" &&
          e.payload?.result?.error === "Invalid tool call arguments" &&
          e.payload?.tool === "repo_browser.read_file"
      );
      assert(!!invalid, "Invalid tool arguments were not reported");
      assert(
        events.some((e) => e.event === "message" && String(e.payload?.text || "").includes("INVALID_ARGS_HANDLED")),
        "Invalid-args follow-up response missing"
      );
    }

    console.log("[rag-e2e] test 3: multi-hunk patch application");
    {
      const patchTarget = path.join(workspaceRoot, "multi.txt");
      await writeFile(patchTarget, "a\nb\nc\nd\ne\n", "utf8");
      const patch = [
        "*** Begin Patch",
        "*** Update File: multi.txt",
        "@@ -1,2 +1,3 @@",
        " a",
        "+aa",
        " b",
        "@@ -4,2 +5,3 @@",
        " d",
        "+dd",
        " e",
        "*** End Patch",
      ].join("\n");
      const r = await getJson(`${dashboardBase}/mcp/apply_patch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      });
      assert(r.ok && r.body?.ok, `apply_patch failed: ${JSON.stringify(r.body)}`);
      const next = await readFile(patchTarget, "utf8");
      assert(next === "a\naa\nb\nc\nd\ndd\ne\n", "multi-hunk patch produced wrong output");
    }

    console.log("[rag-e2e] test 4: tool-call depth abort");
    {
      const events = await parseChatEvents(dashboardBase, "[TEST_DEPTH]");
      const depthErr = events.find(
        (e) => e.event === "error" && String(e.payload?.message || "").includes("Too many tool-call rounds")
      );
      assert(!!depthErr, "Depth guard error not emitted");
      const done = events.find((e) => e.event === "done");
      assert(done?.payload?.ok === false, "Depth guard should end with failed done status");
    }

    console.log("[rag-e2e] test 5: root escape prevention");
    {
      const fsRead = await getJson(`${dashboardBase}/fs/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "../package.json" }),
      });
      assert(!fsRead.ok || fsRead.body?.ok === false, "escape read should be blocked");

      const events = await parseChatEvents(dashboardBase, "[TEST_ESCAPE]");
      const toolRes = events.find((e) => e.event === "tool_result" && e.payload?.tool === "repo_browser.read_file");
      const errText = JSON.stringify(toolRes?.payload?.result || {});
      assert(
        errText.includes("Path escapes project root") || errText.includes("outside trusted roots"),
        "tool escape should return root/trust error"
      );
    }

    console.log("[rag-e2e] test 6: new retrieval tools");
    {
      const events = await parseChatEvents(dashboardBase, "[TEST_NEW_TOOLS]");
      const searchRes = events.find((e) => e.event === "tool_result" && e.payload?.tool === "repo_browser.search_code");
      const chunkRes = events.find((e) => e.event === "tool_result" && e.payload?.tool === "repo_browser.read_file_chunk");
      const searchOk = searchRes?.payload?.result?.ok === true;
      const searchNoRg = String(searchRes?.payload?.result?.error || "").includes("rg");
      assert(searchOk || searchNoRg, `search_code tool failed: ${JSON.stringify(searchRes?.payload?.result || null)}`);
      assert(chunkRes?.payload?.result?.ok === true, "read_file_chunk tool failed");
      assert(
        events.some((e) => e.event === "message" && String(e.payload?.text || "").includes("NEW_TOOLS_OK")),
        "new-tools follow-up response missing"
      );
    }

    console.log("[rag-e2e] PASS");
  } finally {
    if (dashboardServer?.close) {
      await new Promise((resolve) => dashboardServer.close(resolve)).catch(() => {});
    }
    mockLm.close();
    await rm(tempBase, { recursive: true, force: true }).catch(() => {});
    await sleep(200);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    console.error(`[rag-e2e] FAIL: ${e?.message || e}`);
    process.exit(1);
  });
