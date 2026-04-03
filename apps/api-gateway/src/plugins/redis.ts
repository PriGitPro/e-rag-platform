import fp from "fastify-plugin";
import Redis from "ioredis";
import type { FastifyInstance } from "fastify";
import type { AppEnv } from "../config/env.js";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export const redisPlugin = fp(async (app: FastifyInstance, env: AppEnv) => {
  const client = new Redis(env.REDIS_URL, { lazyConnect: false });
  app.decorate("redis", client);
  app.addHook("onClose", async () => {
    client.disconnect();
  });
});
