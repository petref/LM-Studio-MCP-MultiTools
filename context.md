# Project Context

## Overview

The repository contains a minimal implementation of an MCP (Machine‑Control Protocol) server, a simple chat client that talks to a language model via HTTP, and a small web UI for interacting with the chat endpoint.

```
src/
├─ bridge/          # Starts the MCP server and forwards its output
├─ chat.ts          # Wrapper around the LM /chat/completions endpoint
├─ control/
│  ├─ index.html    # Minimal UI that sends messages to /chat
│  └─ server.ts     # Express proxy for the chat endpoint
├─ mcp/             # MCP server implementation (tool calls)
├─ runtime/         # Runtime configuration loader
└─ types/
   └─ shim.d.ts    # TypeScript definitions for MCP protocol
```

## File Summaries

### `src/bridge/bridge.ts`

- Starts an MCP server via `spawn`.
- Reads stdout/stderr and logs lines to console.
- Configures LM base URL, model, API key from env or runtime config.
- **Potential improvements**: parse MCP messages, graceful shutdown, remove infinite loop.

### `src/chat.ts`

- Simple wrapper around the LM’s `/chat/completions` endpoint.
- No error handling for non‑200 responses; hard‑coded model/temperature.

### `src/control/index.html`

- Minimal UI that loads a script (`control.js`) and sends user messages to `/chat`.

### `src/control/server.ts`

- Express server proxies `/chat` requests to the LM.
- Lacks validation of query params, CORS support, error handling.

### `src/mcp/server.ts`

- MCP server listening on stdin/stdout via `readline`.
- Parses JSON tool calls and executes tools (`echo`, `add`).
- No error handling for malformed JSON or unknown tools; synchronous execution only.

### `src/runtime/index.ts`

- Loads runtime config from `runtime.json` and environment variables.
- No validation of required fields; throws if file missing.

### `src/types/shim.d.ts`

- TypeScript definitions for the MCP protocol (`ToolCall`, `ToolResponse`).

## Feature Improvement Ideas & Bugs

1. **Bridge**: add proper MCP message parsing, integrate with an agent loop.
2. **Chat**: handle HTTP errors, timeouts, retries; make model/temperature configurable.
3. **Control UI**: fix missing `control.js`; bundle client code or serve from `/static`.
4. **Server**: validate query params, add CORS, log requests.
5. **MCP Server**: async tool execution, better error handling, dynamic tool registration.
6. **Runtime**: validate config schema, provide defaults if missing.
7. **Testing**: implement unit tests for chat and MCP server logic.

---

Feel free to add more notes or modify this file as the project evolves.
