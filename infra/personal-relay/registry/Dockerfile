FROM node:26-alpine

WORKDIR /app
COPY package.json ./
# The registry runs without dev dependencies; keep the image to runtime code.
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/main.ts"]
