# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app
COPY package.json tsconfig.json .env.example README.md ./
COPY src ./src

RUN corepack enable && corepack prepare pnpm@9.7.1 --activate  && pnpm i --frozen-lockfile=false  && pnpm build

# Default command runs the bridge (which spawns the MCP server)
CMD ["node", "dist/bridge/bridge.js"]
