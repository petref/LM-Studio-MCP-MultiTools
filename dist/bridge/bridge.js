import 'dotenv/config';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { initRuntime, getRuntime } from '../runtime/index.js';
await initRuntime();
const LLM_BASE_URL = process.env.LLM_BASE_URL || getRuntime().apiBase || 'http://localhost:1234/v1';
const LLM_MODEL = process.env.LLM_MODEL || getRuntime().model || 'qwen2.5-coder:7b-instruct';
const MCP_CMD = process.env.MCP_SERVER_CMD || 'node';
const MCP_ARGS = (process.env.MCP_SERVER_ARGS || 'dist/mcp/standalone.js').split(' ');
// Minimal bridge: spawn MCP server (stdio), and be ready to forward tool calls
// In a real agent loop, you'd parse model output and invoke MCP tools accordingly.
async function main() {
    console.log(`[bridge] starting MCP server: ${MCP_CMD} ${MCP_ARGS.join(' ')}`);
    const proc = spawn(MCP_CMD, MCP_ARGS, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env
    });
    const done = new Promise((resolve, reject) => {
        proc.on('exit', (code) => {
            const exitCode = code ?? 0;
            console.log(`[bridge] MCP server exited with code ${exitCode}`);
            resolve(exitCode);
        });
        proc.on('error', reject);
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
    const signalHandler = () => {
        proc.kill('SIGTERM');
    };
    process.on('SIGINT', signalHandler);
    process.on('SIGTERM', signalHandler);
    const exitCode = await done;
    process.off('SIGINT', signalHandler);
    process.off('SIGTERM', signalHandler);
    if (exitCode !== 0) {
        throw new Error(`MCP child exited with code ${exitCode}`);
    }
}
main().catch((e) => {
    console.error('[bridge] fatal:', e);
    process.exit(1);
});
