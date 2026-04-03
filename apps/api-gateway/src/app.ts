import Fastify from "fastify";
import { getEnv } from "./config/env.js";
import { jwtPlugin } from "./plugins/jwt.js";
import { rateLimitPlugin } from "./plugins/rateLimit.js";
import { healthRoutes } from "./routes/health.js";
import { ingestRoutes } from "./routes/ingest.js";
import { queryRoutes } from "./routes/query.js";

export async function buildApp() {
  const env = getEnv();

  const app = Fastify({
    logger: env.NODE_ENV !== "test"
  });

  await app.register(jwtPlugin, env);
  await app.register(rateLimitPlugin, env);
  await app.register(healthRoutes);
  await app.register(queryRoutes);
  await app.register(ingestRoutes);

  return { app, env };
}
