# LM Studio MCP MultiTools

Local AI workspace for code-aware chat, controlled file operations, and multi-project session management.

This project turns a local or self-hosted LLM endpoint into an operator that can inspect a repository, read and write files, search code, apply patches, and maintain multiple project/chat contexts through a browser dashboard. It is designed for local-first development workflows where teams want practical AI assistance without immediately moving code or prompts into a cloud IDE.

## Executive Summary

For a BA:

- This is a local AI workbench for software delivery teams.
- It lets a user point an LLM at a project folder and interact with that project through a governed chat interface.
- It supports multiple projects, persistent chats, project profiles, root-folder validation, backup/restore, and live tool telemetry.
- It is suitable for internal engineering enablement, local developer productivity, and controlled experimentation with AI-assisted code operations.

For a CTO:

- The core value is controlled local AI execution against a filesystem workspace.
- The system wraps an OpenAI-compatible chat endpoint, adds a tool loop, and exposes a governance layer around file access and patching.
- It provides a single-node local architecture with persistent runtime state, persistent UI state, trust-bound path enforcement, streaming telemetry, and test scripts.
- It is closer to an operational prototype / internal platform foundation than a finished enterprise product.

## What Problem It Solves

Most local LLM setups can answer questions, but they do not reliably operate on real project files with enough control around:

- which folders are in scope
- which edits are allowed
- whether changes can be inspected before write
- how project sessions persist across restarts
- how users manage multiple repositories and chats
- how operators observe tool usage and failures

This project fills that gap by combining:

1. A dashboard UI for managing projects and chat sessions
2. A server that runs the LLM conversation and tool-calling loop
3. A controlled file/patch layer for repository operations
4. Persistent local state for runtime configuration and UI workspace history

## What The Product Does Today

### 1. Multi-project AI workspace

Users can create multiple projects, each with its own:

- root directory
- model/API endpoint
- MCP tools enabled/disabled flag
- temperature
- max tokens
- trusted root list
- pinned status

Each project automatically maintains one or more chats with:

- persistent message history
- pinned chats
- archived chats
- rename/delete/archive actions
- bulk delete workflows

### 2. AI chat with tool-calling

The dashboard sends prompts to an OpenAI-compatible `/chat/completions` endpoint and allows the model to call local tools for:

- printing a project tree
- reading files
- reading line ranges from files
- searching code
- creating directories
- creating files
- rewriting files
- applying patch payloads

The system streams results back to the UI using SSE and emits:

- `message`
- `tool_call`
- `tool_result`
- `tool_done`
- `retry`
- `heartbeat`
- `error`
- `done`

### 3. Controlled local file operations

The project includes guardrails around local access:

- project root enforcement
- trusted root enforcement
- path normalization
- binary-file blocking for text reads
- maximum file-size checks
- line-span limits for chunk reads
- payload-size limits on JSON requests

### 4. Operational dashboard

The UI includes workspace-management features beyond a simple chat box:

- project and chat search
- pinning workflows
- archive workflows
- recent roots discovery
- folder validation and dry-run previews
- backup and restore of UI state
- session token support for protected endpoints
- tool activity panel
- performance metrics endpoint
- token estimation in the composer
- undo support for destructive UI actions

## Representative Use Cases

### Engineering productivity

- local codebase exploration with an LLM
- assisted refactors in trusted directories
- patch-based changes generated from natural language
- project-specific chat memory across sessions

### Team enablement

- internal developer assistant for repositories that should stay local
- standardized AI interface for teams already using LM Studio or another OpenAI-compatible local runtime
- sandbox for evaluating model behavior before broader rollout

### BA / product analysis support

- inspect repository structures quickly
- search for business rules or feature implementations in code
- maintain separate chats per initiative or project
- export/import project configurations for repeatable analysis setups

### Platform experimentation

- foundation for a private coding copilot
- wrapper around a self-hosted model endpoint
- basis for adding approval flows, audit logs, SSO, or role-based controls later

## Current Architecture

```text
Browser UI (src/control/index.html)
        |
        v
Dashboard Server (src/control/server.ts)
        |
        +--> Runtime config (runtime.json)
        +--> UI state store (db/ui_state.json)
        +--> File and patch operations
        +--> Tool loop / SSE streaming
        |
        v
OpenAI-compatible LLM endpoint
(LM Studio by default, but any compatible API can work)
```

Supporting modules:

- `src/control/server.ts`: main application server, tool loop, API surface, SSE chat stream
- `src/control/stateStore.ts`: persistent project/chat state management
- `src/mcp/server.ts`: patch and rewrite HTTP endpoints with root/trust checks
- `src/mcp/standalone.ts`: standalone HTTP server for patch endpoints and health
- `src/runtime/index.ts`: runtime configuration loading and persistence
- `src/chat/chat.ts`: CLI smoke-style chat client for the configured model endpoint
- `src/bridge/bridge.ts`: minimal bridge process that spawns the standalone MCP server

## Tool Surface Available To The Model

The current tool catalog exposed by the dashboard chat loop is:

- `repo_browser.print_tree(path)`
- `repo_browser.read_file(path)`
- `repo_browser.read_file_chunk(path, startLine, endLine)`
- `repo_browser.search_code(query, globs?)`
- `repo_browser.create_directory(path)`
- `repo_browser.create_file(path, content)`
- `repo_browser.apply_patch(patch)`
- `repo_browser.rewrite_file(path, content)`

Important implementation notes:

- Retrieval tools are cached within a chat round to reduce repeated reads.
- Write operations clear the retrieval cache.
- Tool execution has a timeout.
- The server aborts if the model exceeds the configured tool-call depth.
- Invalid tool arguments are reported back into the conversation as tool results.

## Governance And Safety Model

This is one of the most important parts of the project.

### Boundary controls

- Every project has a `rootDir`.
- Every project also has `trustedRoots`.
- Reads and writes are validated against the active workspace root.
- Writes are additionally checked against trusted roots.
- Absolute paths are normalized before comparison.

### Content controls

- oversized text reads are blocked
- likely-binary files are blocked
- oversized JSON bodies are rejected early
- file chunk reads are bounded
- search results are capped

### Operational controls

- optional dashboard auth token
- explicit health endpoints
- performance event capture
- state backup and restore
- dry-run validation for candidate roots

### What this does not yet provide

- user/role separation
- immutable audit logging
- approval workflow before every file write
- external secrets management
- enterprise authentication
- container/Kubernetes production packaging

## Product Maturity

The codebase is functional and materially more capable than the original README suggests, but it should be evaluated as:

- a strong internal tool
- a local platform prototype
- a base for a governed coding assistant

It is not yet a hardened enterprise product.

### Strengths

- practical end-to-end workflow already exists
- state persistence is implemented
- project isolation model exists
- trust/root checks are implemented
- streaming tool telemetry exists
- smoke and RAG-style end-to-end tests exist

### Gaps / limitations

- no formal authentication/authorization model beyond a shared token
- no database beyond local JSON state and included SQLite artifact
- minimal bridge implementation
- no packaging for multi-user deployment
- no formal audit trail of file edits
- no approval queue for model-generated changes
- UI is single-file HTML/JS rather than a componentized frontend application

For a CTO, the right framing is: this is a credible local-first AI ops shell for repositories, not yet a finished internal developer platform.

## API Overview

### State and health

- `GET /`
- `GET /healthz`
- `GET /state`
- `POST /state`
- `GET /state/ui`
- `POST /state/backup`
- `POST /state/restore`

### Projects

- `GET /projects`
- `POST /projects`
- `POST /projects/active`
- `PATCH /projects/:id`
- `DELETE /projects/:id`
- `POST /projects/:id/duplicate`
- `GET /projects/:id/export`
- `POST /projects/import`

### Chats

- `GET /projects/:id/chats?includeArchived=true|false`
- `POST /projects/:id/chats`
- `POST /projects/:id/chats/bulk-delete`
- `POST /chats/active`
- `GET /chats/:id`
- `PATCH /chats/:id`
- `DELETE /chats/:id`
- `POST /chats/:id/messages`
- `POST /chats/:id/archive`

### Model interaction

- `GET /models`
- `POST /chat` (SSE stream)
- `POST /abort`

### Filesystem and trust checks

- `POST /fs/read`
- `POST /fs/write`
- `POST /fs/pick-directory`
- `POST /fs/validate-directory`
- `POST /fs/dry-run-root`
- `GET /fs/recent-roots`

### Patch helpers

- `POST /mcp/apply_patch`
- `POST /mcp/rewrite_file`

### Performance

- `GET /perf?limit=N`

## Persistence Model

The application stores data locally in files.

- `runtime.json`: active runtime settings such as root, API base, model, and MCP enabled flag
- `db/ui_state.json`: persistent UI state for projects, chats, pinned flags, archive flags, and settings
- `db/ui_state.json.bak`: backup copy written during state writes

Current UI state schema version:

- `version: 3`

## Compatibility

The server is built around OpenAI-compatible chat APIs.

Default target:

- LM Studio at `http://localhost:1234/v1`

Other likely-compatible targets:

- Ollama instances exposing OpenAI-compatible routes
- private gateway services that implement `/chat/completions`
- self-hosted inference layers exposing OpenAI-style APIs

## Installation And Local Start

### Prerequisites

- Node.js
- npm
- a reachable OpenAI-compatible LLM endpoint

### Install

```bash
npm install
```

### Configure

Copy `.env.example` to `.env` and adjust values for your environment.

Typical values:

```bash
LMSTUDIO_API_BASE=http://localhost:1234/v1
LMSTUDIO_API_KEY=lm-studio
LMSTUDIO_MODEL=qwen2.5-coder:7b-instruct
MCP_ROOT_DIR=.
RUNTIME_JSON=runtime.json
MCP_TOOLS_ENABLED=true
```

### Run the dashboard

```bash
npm run dashboard
```

Open:

- [http://localhost:8787](http://localhost:8787)

### Build TypeScript

```bash
npm run build
```

### Start the standalone MCP HTTP server

```bash
npm run mcp
```

### Run the simple CLI chat client

```bash
npm run chat -- "Summarize this repository"
```

### Start the bridge process

```bash
npm run bridge
```

Note: the current bridge is minimal. It spawns the MCP standalone process and logs child output, but it is not yet a full orchestration layer for production agent workflows.

## Environment Variables

### Core LLM settings

- `LMSTUDIO_API_BASE`: base URL for the OpenAI-compatible API
- `LMSTUDIO_API_KEY`: bearer token
- `LMSTUDIO_MODEL`: default model
- `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`: legacy/bridge-oriented alternatives

### Runtime and filesystem

- `MCP_ROOT_DIR`: default filesystem root
- `RUNTIME_JSON`: runtime config path
- `MCP_TOOLS_ENABLED`: enable/disable tool usage

### Dashboard server

- `DASHBOARD_PORT`: dashboard port, default `8787`
- `DASHBOARD_BASE`: dashboard base URL used for internal helper calls
- `DASHBOARD_AUTH_TOKEN`: optional shared token for non-public endpoints

### Guardrails and limits

- `TOOL_CALL_TIMEOUT_MS`
- `TREE_CONCURRENCY`
- `MAX_JSON_BODY_BYTES`
- `MAX_READ_FILE_BYTES`
- `MAX_CHUNK_LINE_SPAN`
- `MAX_SEARCH_RESULTS`
- `MAX_SEARCH_RESULTS_PER_FILE`
- `CHAT_MESSAGES_MAX`

### Observability

- `PERF_LOGS`
- `PERF_EVENTS_MAX`

### UI persistence

- `UI_STATE_JSON`

## Testing

Available scripts:

- `npm run test:e2e:smoke`
- `npm run test:e2e:rag`

What they cover:

- dashboard health and HTML sanity
- project and chat lifecycle basics
- state restore flow
- SSE `done` event behavior
- CRLF event parsing
- invalid tool argument handling
- multi-hunk patch application
- tool-call depth guard
- root escape prevention
- retrieval tool behavior

## Repository Structure

```text
src/
  bridge/
    bridge.ts
  chat/
    chat.ts
  control/
    index.html
    server.ts
    stateStore.ts
  mcp/
    server.ts
    standalone.ts
  runtime/
    index.ts
  types/
    shim.d.ts
scripts/
  e2e-smoke.mjs
  rag-e2e.mjs
db/
  rag/
    mem.sqlite
runtime.json
```

## Recommended Next Steps If You Want To Productize It

1. Add user identity, roles, and per-project authorization.
2. Add approval gates and immutable audit logs for file writes.
3. Replace shared-token auth with SSO or gateway auth.
4. Move state from JSON files to a service-grade store.
5. Separate UI into a maintainable frontend application.
6. Add deployment packaging and operational docs.
7. Expand tests around failure modes and write safety.
8. Formalize the bridge or remove it in favor of the dashboard runtime as the main product surface.

## Bottom Line

This project already demonstrates a useful pattern: a local AI coding workspace that adds structure, persistence, and control on top of an OpenAI-compatible model endpoint. For business stakeholders, it shows how AI-assisted engineering can be made usable in a local environment. For technical leadership, it provides a strong prototype for a governed internal coding assistant, with clear next steps to harden it into a platform.
