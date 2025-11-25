
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type RuntimeState = {
  mcpEnabled: boolean;
  rootDir: string;
  apiBase: string;
  model: string;
};

const RUNTIME_PATH = path.resolve(process.env.RUNTIME_JSON || 'runtime.json');

const defaults: RuntimeState = {
  mcpEnabled: (process.env.MCP_TOOLS_ENABLED || 'true').toLowerCase() === 'true',
  rootDir: process.env.MCP_ROOT_DIR || '.',
  apiBase: process.env.LMSTUDIO_API_BASE || process.env.LMSTUDIO_URL || 'http://localhost:1234/v1',
  model: process.env.LMSTUDIO_MODEL || 'qwen2.5-coder:7b-instruct',
};

let cache: RuntimeState = defaults;

export async function initRuntime() {
  try {
    const text = await fs.readFile(RUNTIME_PATH, 'utf-8');
    cache = { ...defaults, ...JSON.parse(text) };
  } catch {
    await saveRuntime(cache);
  }
}

export function getRuntime(): RuntimeState {
  return cache;
}

export async function saveRuntime(state: Partial<RuntimeState>) {
  cache = { ...cache, ...state };
  await fs.writeFile(RUNTIME_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

