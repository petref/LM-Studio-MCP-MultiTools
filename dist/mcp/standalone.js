import "dotenv/config";
import { createServer } from "node:http";
import { attachMCPToServer } from "./server.js";
import { getRuntime, initRuntime } from "../runtime/index.js";
const PORT = Number(process.env.MCP_HTTP_PORT || 8790);
function getRoot() {
    return getRuntime().rootDir || process.env.MCP_ROOT_DIR || process.cwd();
}
await initRuntime();
const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    if (req.url?.startsWith("/mcp/"))
        return;
    res.statusCode = 404;
    res.end("Not Found");
});
attachMCPToServer(server, { getRoot });
server.listen(PORT, () => {
    console.log(`[mcp] HTTP server listening on http://localhost:${PORT}`);
    console.log(`[mcp] Root: ${getRoot()}`);
});
