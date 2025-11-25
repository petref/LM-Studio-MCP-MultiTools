import 'dotenv/config';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';


import { initRuntime, getRuntime } from '../runtime/index.js';
await initRuntime();

function getLLM() {
  const base = getRuntime().apiBase || 'http://localhost:1234/v1';
  const model = getRuntime().model || 'qwen2.5-coder:7b-instruct';
  return { base, model };
}

const LLM_BASE_URL = process.env.LLM_BASE_URL || getRuntime().apiBase || 'http://localhost:1234/v1';
const LLM_MODEL    = process.env.LLM_MODEL    || getRuntime().model    || 'qwen2.5-coder:7b-instruct';
const LLM_API_KEY  = process.env.LLM_API_KEY  || process.env.LMSTUDIO_API_KEY  || 'lm-studio';

const MCP_CMD  = process.env.MCP_SERVER_CMD || 'node';
const MCP_ARGS = (process.env.MCP_SERVER_ARGS || 'dist/mcp/server.js').split(' ');

// Minimal bridge: spawn MCP server (stdio), and be ready to forward tool calls
// In a real agent loop, you'd parse model output and invoke MCP tools accordingly.
async function main() {
  console.log(`[bridge] starting MCP server: ${MCP_CMD} ${MCP_ARGS.join(' ')}`);
  const proc = spawn(MCP_CMD, MCP_ARGS, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });

  proc.on('exit', (code) => {
    console.log(`[bridge] MCP server exited with code ${code}`);
  });

  // Demonstration: attach stdio to console for now
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    // Typically you'd parse MCP protocol messages here
    console.log(`[mcp-out] ${line}`);
  });

  const rle = readline.createInterface({ input: proc.stderr });
  rle.on('line', (line) => console.error(`[mcp-err] ${line}`));

  console.log(`[bridge] LM Studio base: ${LLM_BASE_URL}, model: ${LLM_MODEL}`);
  console.log(`[bridge] ready`);

  // Keep process alive
  for (;;) await delay(3600_000);
}

main().catch((e) => {
  console.error('[bridge] fatal:', e);
  process.exit(1);
});



