FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps/ingestion-worker/package.json ./apps/ingestion-worker/

RUN npm ci --workspace=@erp/ingestion-worker

COPY apps/ingestion-worker/ ./apps/ingestion-worker/

RUN npm run -w @erp/ingestion-worker build

FROM node:20-alpine AS runtime
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/ingestion-worker/package.json ./apps/ingestion-worker/

RUN npm ci --workspace=@erp/ingestion-worker --omit=dev

COPY --from=builder /app/apps/ingestion-worker/dist ./apps/ingestion-worker/dist

CMD ["node", "apps/ingestion-worker/dist/worker.js"]
