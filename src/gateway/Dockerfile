FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV CODEX_HOME=/codex-home GATEWAY_PORT=8090
EXPOSE 8090
CMD ["node", "src/server.ts"]
