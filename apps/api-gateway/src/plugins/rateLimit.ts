import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import type { AppEnv } from "../config/env.js";
import { resolveRateLimitKey } from "./rateLimitKey.js";

export const rateLimitPlugin = fp(async (app: FastifyInstance, env: AppEnv) => {
  await app.register(rateLimit, {
    max: env.DEFAULT_RATE_LIMIT_MAX,
    timeWindow: env.DEFAULT_RATE_LIMIT_WINDOW,
    keyGenerator: (request) => resolveRateLimitKey(app, request)
  });
});
