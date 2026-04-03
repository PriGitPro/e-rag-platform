import Fastify from "fastify";
import cors from "@fastify/cors";
import { getEnv } from "./config/env.js";
import { jwtPlugin } from "./plugins/jwt.js";
import { rateLimitPlugin } from "./plugins/rateLimit.js";
import { redisPlugin } from "./plugins/redis.js";
import { healthRoutes } from "./routes/health.js";
import { ingestRoutes } from "./routes/ingest.js";
import { queryRoutes } from "./routes/query.js";
import { devTokenRoutes } from "./routes/devToken.js";

export async function buildApp() {
  const env = getEnv();

  const app = Fastify({
    logger: env.NODE_ENV !== "test"
  });

  // CORS — open in dev, locked to allowed origins in production
  await app.register(cors, {
    origin: env.NODE_ENV === "production" ? false : true,
    methods: ["GET", "POST", "OPTIONS"]
  });

  await app.register(jwtPlugin, env);
  await app.register(rateLimitPlugin, env);
  await app.register(redisPlugin, env);
  await app.register(healthRoutes);
  await app.register(queryRoutes);
  await app.register(ingestRoutes);
  await app.register(devTokenRoutes);

  return { app, env };
}
