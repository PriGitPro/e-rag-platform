import type { FastifyInstance } from "fastify";
import pg from "pg";
import { Redis } from "ioredis";
import { getEnv } from "../config/env.js";

const { Pool } = pg;

async function checkDb(databaseUrl: string): Promise<"ok" | "error"> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query("SELECT 1");
    return "ok";
  } catch {
    return "error";
  } finally {
    await pool.end();
  }
}

async function checkRedis(redisUrl: string): Promise<"ok" | "error"> {
  const client = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 3000 });
  try {
    await client.connect();
    await client.ping();
    return "ok";
  } catch {
    return "error";
  } finally {
    client.disconnect();
  }
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    const env = getEnv();
    const [db, redis] = await Promise.all([
      checkDb(env.DATABASE_URL),
      checkRedis(env.REDIS_URL)
    ]);

    const status = db === "ok" && redis === "ok" ? "ok" : "degraded";
    return { status, services: { db, redis } };
  });
}
