import Redis from "ioredis";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const QUEUE_KEY = "erp:ingest:jobs";

const redis = new Redis(REDIS_URL);

redis.on("connect", () => {
  console.log("[ingestion-worker] connected to Redis, polling queue:", QUEUE_KEY);
});

redis.on("error", (err) => {
  console.error("[ingestion-worker] Redis error:", err);
});

async function poll(): Promise<void> {
  // BLPOP blocks until a job arrives or timeout (5s), then loops
  const result = await redis.blpop(QUEUE_KEY, 5);
  if (result) {
    const [, payload] = result;
    console.log("[ingestion-worker] received job:", payload);
    // TODO Week 2: parse payload, fetch from MinIO, chunk, embed, upsert to Milvus
  }
}

async function run(): Promise<void> {
  console.log("[ingestion-worker] starting");
  while (true) {
    await poll();
  }
}

void run();
