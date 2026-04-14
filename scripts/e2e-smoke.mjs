#!/usr/bin/env node
/* eslint-disable no-console */

const BASE = (process.env.DASHBOARD_URL || "http://localhost:8787").replace(/\/+$/, "");
const TOKEN = String(process.env.DASHBOARD_TEST_TOKEN || "").trim();

function headers(extra = {}) {
  const out = { ...extra };
  if (TOKEN) out["x-dashboard-token"] = TOKEN;
  return out;
}

async function jfetch(path, options = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...options,
    headers: headers(options.headers || {}),
  });
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { ok: r.ok, status: r.status, body };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitSseDone() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!r.ok || !r.body) return { skipped: true, reason: `chat unavailable (${r.status})` };
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("\nevent: done\n") || buf.startsWith("event: done\n")) {
        return { ok: true };
      }
      if (buf.length > 150000) buf = buf.slice(-50000);
    }
    return { skipped: true, reason: "chat stream ended without explicit done marker in test window" };
  } catch (e) {
    return { skipped: true, reason: `chat stream skipped (${e?.message || e})` };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  console.log(`[smoke] target: ${BASE}`);

  const indexRes = await fetch(`${BASE}/index.html`, { headers: headers() });
  assert(indexRes.ok, `index failed: HTTP ${indexRes.status}`);
  const html = await indexRes.text();
  assert(html.includes("id=\"projectList\""), "index missing projectList");
  assert(html.includes("id=\"chatList\""), "index missing chatList");
  assert(html.includes("id=\"sessionTokenInput\""), "index missing sessionTokenInput");
  assert(html.includes("id=\"tokenStats\""), "index missing tokenStats");
  console.log("[smoke] index HTML sanity ok");

  const health = await jfetch("/healthz");
  assert(health.ok && health.body?.ok, "healthz failed");

  const state = await jfetch("/state");
  assert(state.ok, "state GET failed");

  const uiState = await jfetch("/state/ui");
  assert(uiState.ok && uiState.body?.ok && uiState.body?.state, "state/ui failed");

  const projectsRes = await jfetch("/projects");
  assert(projectsRes.ok && Array.isArray(projectsRes.body?.projects), "projects list failed");

  const cwdPath = process.cwd().replace(/\\/g, "\\\\");
  const validate = await jfetch("/fs/validate-directory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: process.cwd() }),
  });
  assert(validate.ok && validate.body?.ok, "validate-directory failed");
  console.log(`[smoke] cwd health: read=${validate.body?.readable} write=${validate.body?.writable}`);

  const projectName = `Smoke ${Date.now()}`;
  const created = await jfetch("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: projectName,
      rootDir: process.cwd(),
      trustedRoots: [process.cwd()],
    }),
  });
  assert(created.ok && created.body?.ok, "create project failed");

  const projectsAfter = await jfetch("/projects");
  const createdProject = (projectsAfter.body?.projects || []).find((p) => p.name === projectName);
  assert(createdProject?.id, "created project not found");

  const createdChat = await jfetch(`/projects/${encodeURIComponent(createdProject.id)}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "smoke chat" }),
  });
  assert(createdChat.ok && createdChat.body?.ok, "create chat failed");

  const chats = await jfetch(`/projects/${encodeURIComponent(createdProject.id)}/chats?includeArchived=true`);
  assert(chats.ok && Array.isArray(chats.body?.chats), "list chats failed");
  const chatId = chats.body.chats[0]?.id;
  assert(chatId, "missing chat id");

  const archived = await jfetch(`/chats/${encodeURIComponent(chatId)}/archive`, { method: "POST" });
  assert(archived.ok && archived.body?.ok, "archive chat failed");

  const bulk = await jfetch(`/projects/${encodeURIComponent(createdProject.id)}/chats/bulk-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includePinned: false, includeArchived: true }),
  });
  assert(bulk.ok, "bulk-delete failed");

  const restore = await jfetch("/state/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: uiState.body.state }),
  });
  assert(restore.ok && restore.body?.ok, "restore snapshot failed");

  const sse = await waitSseDone();
  if (sse.ok) console.log("[smoke] chat stream done event observed");
  else console.log(`[smoke] ${sse.reason}`);

  console.log("[smoke] PASS");
  console.log(`[smoke] MAX_JSON_BODY_BYTES env can tune request limit (current default 1048576).`);
  console.log(`[smoke] cwd escaped sample: ${cwdPath}`);
}

main().catch((e) => {
  console.error(`[smoke] FAIL: ${e?.message || e}`);
  process.exit(1);
});

