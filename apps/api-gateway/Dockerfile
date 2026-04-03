FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps/api-gateway/package.json ./apps/api-gateway/

RUN npm ci --workspace=@erp/api-gateway

COPY apps/api-gateway/ ./apps/api-gateway/

RUN npm run -w @erp/api-gateway build

FROM node:20-alpine AS runtime
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/api-gateway/package.json ./apps/api-gateway/

RUN npm ci --workspace=@erp/api-gateway --omit=dev

COPY --from=builder /app/apps/api-gateway/dist ./apps/api-gateway/dist

EXPOSE 3000
CMD ["node", "apps/api-gateway/dist/server.js"]
