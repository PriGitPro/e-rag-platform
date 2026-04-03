FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/

RUN npm ci --workspace=@erp/web

COPY apps/web/ ./apps/web/

WORKDIR /app/apps/web
EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0"]
