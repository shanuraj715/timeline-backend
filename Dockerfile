# Single image used for both the API web process and the background worker
# (see docker-compose.yml in the frontend project) — the worker imports
# directly from src/, so it needs the full source tree and node_modules.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/server.js"]
