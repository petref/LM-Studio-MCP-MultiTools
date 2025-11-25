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


## Chat + Dashboard UI (Lightweight)

A tiny web UI is included to:
- stream chat with your selected LLM,
- toggle **MCP tools ON/OFF**,
- change the **sandbox root** (MCP_ROOT_DIR),
- query `/models` and pick a **model**,
- **open & save files** safely inside the sandbox,
- render code blocks with **Copy** button.

### Start the UI
```bash
npm run dashboard
# then open http://localhost:8787/
```

### Endpoints
- `GET /` – serves the UI page
- `GET /state` – get current runtime (mcpEnabled, rootDir, apiBase, model)
- `POST /state` – update runtime (persists to `runtime.json`)
- `GET /models` – lists models from `${apiBase}/models` (LM Studio / Ollama compatible)
- `POST /chat` – streams chat via `${apiBase}/chat/completions` (OpenAI-compatible)
- `POST /fs/read` – read a file within sandbox root
- `POST /fs/write` – write a file within sandbox root

### Runtime store (`runtime.json`)
```json
{
  "mcpEnabled": true,
  "rootDir": ".",
  "apiBase": "http://127.0.0.1:1234/v1",
  "model": "qwen2.5-coder:7b-instruct"
}
```

If you also import the runtime in `src/mcp/server.ts` and `src/bridge/bridge.ts`, toggling settings in the UI applies **live**.


## Live runtime wiring in MCP & Bridge

Both the MCP server and the bridge now read **apiBase**, **model**, **rootDir**, and **mcpEnabled** from the shared runtime store at `runtime.json` via:

```ts
import { initRuntime, getRuntime } from '../runtime/index.js';
await initRuntime();
```

- Toggle settings in the Dashboard UI (or edit `runtime.json`) and they take effect **without rebuild**.
- MCP tools should respect `mcpEnabled` and file operations are confined to `rootDir`.


## How to run (Dashboard + Agent Tools)

1. Start your LLM backend (LM Studio or Ollama).
   - LM Studio default API: `http://127.0.0.1:1234/v1`
   - Ollama default API: `http://127.0.0.1:11434/v1`

2. Install and start the dashboard:
```bash
npm install
npm run dashboard
# Open http://localhost:8787/
```

3. In the left sidebar:
   - Set **LLM API Base** to your backend’s `/v1` endpoint.
   - Click ↻ to fetch models, choose one, then **Save**.
   - Toggle **Enable MCP Tools** if you’re using the MCP server/bridge.
   - Set **Sandbox Root** to your project root for safe file access.

4. Chat usage:
   - Ask normally, e.g., “show the repo tree depth 3”.
   - The model may emit an internal directive like  
     `<|channel|>commentary to=repo_browser.print_tree {"path":"", "depth":3}`  
     The dashboard now **intercepts and executes** that and prints the tree.

5. File editor:
   - Enter a relative path (e.g., `README.md`), click **Open**, edit and **Save**.

### Notes
- File operations are sandboxed to `runtime.json` → `rootDir`.
- You can add more tools by following the same pattern inside `src/control/server.ts`.
