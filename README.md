# 🧠 MCPS – Model Context Protocol Server & Bridge
**Version:** 0.2.0  
**Author:** Petre Florea  
**Last Updated:** November 2025

---

## 📘 Overview

This project provides a **local MCP (Model Context Protocol) Server** that can expose your local filesystem, diff, and shell tools to any LLM that supports the MCP standard — including **LM Studio**, **Ollama**, **OpenAI-compatible runtimes**, or custom AI agents.  

It also includes a **Bridge** that connects the MCP Server to an HTTP-compatible LLM endpoint (such as `http://localhost:1234/v1` for LM Studio).

---

## 🧩 Folder Structure

```
mcps-tight-ts/
├── src/
│   ├── bridge/bridge.ts        # Bridge between LLM and MCP Server
│   ├── mcp/server.ts           # Core MCP server (Zod + SDK)
│   └── types/shim.d.ts         # Module declarations
├── dist/                       # Compiled JS files
├── .env.example                # Environment template
├── package.json                # Scripts, dependencies
├── tsconfig.json               # TypeScript configuration
└── README.md                   # You are here
```

---

## 🛠️ Tech Stack

- **TypeScript + Node 22+**
- **@modelcontextprotocol/sdk@^1.21.x**
- **Zod** for schema validation  
- **dotenv** for environment configuration  
- **diff** for unified file diffs  
- **Child Process API** for controlled shell execution  

---

## ⚙️ Environment Variables (`.env`)

Create a `.env` file (copy from `.env.example`):

```bash
MCP_SERVER_NAME=mcps-tight-ts
MCP_SERVER_VERSION=0.2.0
MCP_ROOT_DIR=.
MCP_TOOLS_ENABLED=true
MCP_SHELL_ALLOWLIST=echo,node,pnpm,npm,cat,grep
LMSTUDIO_URL=http://localhost:1234/v1
LMSTUDIO_MODEL=qwen2.5-coder:7b-instruct
```

### Key Variables

| Variable | Description |
|-----------|-------------|
| `MCP_SERVER_NAME` | Custom name for the MCP server |
| `MCP_SERVER_VERSION` | Version displayed to clients |
| `MCP_ROOT_DIR` | Root path for file operations (sandboxed) |
| `MCP_TOOLS_ENABLED` | Global on/off switch for all tools |
| `MCP_SHELL_ALLOWLIST` | Comma-separated list of allowed shell commands |
| `LMSTUDIO_URL` | Base URL for the LLM endpoint (LM Studio, Ollama, etc.) |
| `LMSTUDIO_MODEL` | Model name to query from the endpoint |

---

## 🧰 Tools Available via MCP

Each tool is registered and validated with **Zod schemas** and can be called by LLMs or directly via the bridge.

| Tool | Description | Input Example |
|------|--------------|----------------|
| `read_file` | Reads a UTF-8 text file under `MCP_ROOT_DIR` | `{ "path": "README.md" }` |
| `diff_file` | Returns unified diff between old and new content | `{ "path": "file.ts", "new_content": "..." }` |
| `apply_patch` | Overwrites file if SHA matches | `{ "path": "file.ts", "new_content": "...", "expected_sha256": "..." }` |
| `run_command` | Executes allowlisted shell commands safely | `{ "cmd": "echo", "args": ["Hello"] }` |

---

## 🧩 LLM Integration

### 🔹 With LM Studio

LM Studio uses `stdio` communication for MCPs.  
Simply add this MCP in LM Studio’s **MCP configuration** (under *Tools / Extensions*).  
The Bridge (`bridge.ts`) can spawn the server automatically.

**Run:**
```bash
npm run bridge
```

Expected output:
```
[bridge] starting MCP server: node dist/mcp/server.js
[bridge] LM Studio base: http://localhost:1234/v1, model: qwen2.5-coder:7b-instruct
[bridge] ready
```

Then LM Studio will start using this MCP as a local plugin for filesystem access and code manipulation.

---

### 🔹 With Ollama or Other OpenAI-Compatible APIs

If you want to use the **bridge** for other LLMs:

1. Edit `.env`:
   ```bash
   LMSTUDIO_URL=http://localhost:11434/v1
   LMSTUDIO_MODEL=llama3.1:8b
   ```
2. Run:
   ```bash
   npm run bridge
   ```
3. The bridge will relay context, prompts, and MCP tool calls between your MCP server and that LLM.

---

### 🔹 With Custom AI Clients

If you’re writing your own client:
- Connect to the MCP server via `stdio`.
- Use the standard MCP request types:
  - `tools/list`
  - `tools/call`
- Responses follow the MCP schema.

You can also embed the bridge in your own Node project.

---

## 🚀 Commands

| Script | Action |
|---------|---------|
| `npm run build` | Compile TypeScript to `/dist` |
| `npm run dev` | Hot-reload MCP server via `tsx` |
| `npm run mcp` | Start MCP server standalone |
| `npm run bridge` | Start bridge + spawn MCP server |
| `npm run chat` | Simple test chat with the connected LLM |

---

## 🧩 How it Works (Architecture)

```
        ┌──────────────────────────────┐
        │        LM Studio / LLM       │
        └────────────┬─────────────────┘
                     │  HTTP (Bridge)
                     ▼
          ┌──────────────────────────────┐
          │         bridge.ts            │
          │   ↳ spawns MCP server        │
          │   ↳ connects to LLM API      │
          └────────────┬─────────────────┘
                     │  stdio (MCP)
                     ▼
          ┌──────────────────────────────┐
          │         server.ts            │
          │ Tools: read, diff, patch, sh │
          │ Sandbox: MCP_ROOT_DIR        │
          └──────────────────────────────┘
```

---

## 🧩 Developing & Extending

### Add a new tool

```ts
registerTool({
  name: 'list_json_files',
  description: 'List all .json files under root',
  schema: z.object({}),
  async handler() {
    const files = (await fs.readdir(ROOT_DIR)).filter(f => f.endsWith('.json'));
    return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
  }
});
```

### Add a new LLM backend

Edit `.env`:
```bash
LMSTUDIO_URL=https://api.openai.com/v1
LMSTUDIO_MODEL=gpt-4-turbo
OPENAI_API_KEY=your-key
```
Then adapt the bridge to forward the API key in headers.

---

## 🧩 Troubleshooting

| Issue | Fix |
|-------|-----|
| `server.tool is not a function` | You’re on SDK 1.21.x; this version uses `setRequestHandler` instead. Fixed here. |
| TypeScript complains about Zod types | Already resolved: Tool schemas now use `ZodTypeAny`. |
| “Missing script: dev” | Added in this version; run `npm run dev`. |
| LM Studio doesn’t detect MCP | Make sure the bridge is running *before* opening LM Studio. |

---

## 🧭 Version Notes (Change Log)

| Version | Date | Notes |
|----------|------|-------|
| **0.2.0** | Nov 2025 | Rebuilt for SDK 1.21.x, Zod schemas, dotenv config, bridge improvements |
| **0.1.0** | Oct 2025 | Initial PoC with direct `server.tool()` API |


## Chat + Dashboard UI (Current)

The dashboard is now a full local workspace manager with:
- project-based roots (each project has its own `rootDir`)
- per-project profiles (`model`, `temperature`, `maxTokens`, MCP tools on/off)
- project/chat pinning and menu actions (`⋯`)
- chat archive and bulk-delete workflows
- fuzzy search + highlight + pinned/recent/archived filters
- root safety checks (`validate`, `dry-run`, health indicator)
- tool activity panel (live `tool_call` / `tool_result` / `tool_done`)
- backup/restore of UI state
- optional token protection for API endpoints

### Start
```bash
npm install
npm run dashboard
# open http://localhost:8787/
```

### Core Runtime Notes
- Runtime state is persisted in `runtime.json`.
- UI workspace state is persisted in `db/ui_state.json` (with `.bak` backup writes).
- Project state schema is versioned (`version: 2`) and includes:
  - project `pinned`
  - project profile fields: `temperature`, `maxTokens`
  - chat `archived`

### Dashboard Tabs
- `Proj`: projects/chats, root management, import/backup
- `Set`: model/profile/session token/settings
- `Tools`: live tool telemetry stream
- `Perf`: request/tool performance metrics

### Project & Chat Features
- Projects:
  - `⋯` menu: `Pin/Unpin`, `Duplicate`, `Export`, `Rename`, `Delete`
  - Import project config from JSON
  - Backup full UI state
- Chats:
  - `⋯` menu: `Pin/Unpin`, `Archive`, `Rename`, `Delete`
  - Bulk delete by project (configurable archived/pinned inclusion server-side)
- Search:
  - fuzzy scoring
  - query highlight
  - filter mode (`all`, `pinned`, `recent`, and for chats `archived`)

### Root Safety & Onboarding
- `Pick Folder` uses native Windows folder picker via server endpoint.
- Root path validation checks:
  - exists
  - is directory
  - readable
  - writable
- `Dry-run Root` previews entries and confirms access.
- Recent roots endpoint suggests candidate directories from prior project roots and runtime root.

### Chat QoL
- `Regenerate` resends from last user prompt.
- Retry button supports edit-and-resend via custom modal.
- Optional message timestamps display in chat history.
- SSE stream includes retries/errors and tool telemetry.

### Optional Access Control
Set in `.env`:
```bash
DASHBOARD_AUTH_TOKEN=your-local-token
```
When set:
- all non-public endpoints require token
- send token via `x-dashboard-token` header (or `Authorization: Bearer ...`)
- UI supports entering/storing session token locally

### API Endpoints (Dashboard Server)

#### State & Health
- `GET /`
- `GET /healthz`
- `GET /state`
- `POST /state`
- `POST /state/backup`
- `POST /state/restore`

#### Projects
- `GET /projects`
- `POST /projects`
- `POST /projects/active`
- `PATCH /projects/:id`
- `DELETE /projects/:id`
- `POST /projects/:id/duplicate`
- `GET /projects/:id/export`
- `POST /projects/import`

#### Chats
- `GET /projects/:id/chats?includeArchived=true|false`
- `POST /projects/:id/chats`
- `POST /projects/:id/chats/bulk-delete`
- `POST /chats/active`
- `GET /chats/:id`
- `PATCH /chats/:id`
- `DELETE /chats/:id`
- `POST /chats/:id/messages`
- `POST /chats/:id/archive`

#### Model / Chat Stream
- `GET /models`
- `POST /chat` (SSE, includes tool events)
- `POST /abort`

#### Filesystem / Root Safety
- `POST /fs/read`
- `POST /fs/write`
- `POST /fs/pick-directory`
- `POST /fs/validate-directory`
- `POST /fs/dry-run-root`
- `GET /fs/recent-roots`

#### MCP HTTP Helpers
- `POST /mcp/apply_patch`
- `POST /mcp/rewrite_file`

#### Performance
- `GET /perf?limit=N`

### Environment Variables (Dashboard-Relevant)
- `DASHBOARD_PORT` (default `8787`)
- `LMSTUDIO_API_BASE` (default `http://localhost:1234/v1`)
- `DASHBOARD_BASE` (default `http://localhost:${DASHBOARD_PORT}`)
- `DASHBOARD_AUTH_TOKEN` (optional)
- `TREE_CONCURRENCY`
- `PERF_LOGS`
- `PERF_EVENTS_MAX`
- `TOOL_CALL_TIMEOUT_MS`
- `UI_STATE_JSON`
- `CHAT_MESSAGES_MAX`

### Developer Notes
- The dashboard server is in `src/control/server.ts`.
- Persistent state logic is in `src/control/stateStore.ts`.
- Frontend is a single-file UI in `src/control/index.html`.
- Build:
```bash
npm run build
```

## Dashboard Enhancements (April 14, 2026)

### Implemented
- fixed project profile persistence bug:
  - `temperature` and `maxTokens` now persist on project update
- chat send now uses active project temperature instead of fixed `0.2`
- explicit SSE completion event:
  - server emits `event: done` with status (`done` / `aborted` / `error`)
  - client consumes `done` and added stream watchdog timeout fallback
- request body hardening:
  - request-size cap via `MAX_JSON_BODY_BYTES` (default `1048576`)
  - early reject on oversized `content-length`
- XSS hardening:
  - escaped code-block language attribute (`data-lang`)
- virtualized rendering for project/chat lists (better scaling on large datasets)
- modal keyboard UX improvement:
  - Enter behavior is safer in textareas (`Ctrl/Cmd+Enter` to submit)
- undo for destructive actions:
  - snapshot-based undo snackbar for project/chat delete, archive, bulk delete
- root trust policy:
  - per-project `trustedRoots` allowlist
  - health line includes trust state (`trusted` / `untrusted`)
  - untrusted root changes require explicit `TRUST` confirmation
- token counter:
  - composer shows estimated input/output tokens in real time
- added smoke test script:
  - `npm run test:e2e:smoke`

### New/Updated API Notes
- `GET /state/ui`: returns full UI state snapshot (used by undo/restore)
- `POST /chat` SSE now includes `done` event

### Updated State Schema
- UI state version is now `3`
- project fields now include `trustedRoots: string[]`
