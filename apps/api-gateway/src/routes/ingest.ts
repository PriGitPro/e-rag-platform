import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireRoles } from "../middleware/rbac.js";

const INGEST_QUEUE = "erp:ingest:jobs";

const ingestSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  storageKey: z.string().min(1), // object key in MinIO/R2 — client uploads directly first
  sourceUrl: z.string().optional()
});

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/ingest",
    {
      preHandler: [requireAuth, requireRoles(["rag:ingest", "admin"])]
    },
    async (request, reply) => {
      const parsed = ingestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "BAD_REQUEST",
          message: "Invalid request body"
        });
      }

      const jobId = crypto.randomUUID();
      const documentId = crypto.randomUUID();
      const job = {
        jobId,
        documentId,
        tenantId: request.auth?.tenantId,
        storageKey: parsed.data.storageKey,
        filename: parsed.data.filename,
        mimeType: parsed.data.mimeType,
        sizeBytes: parsed.data.sizeBytes,
        sourceUrl: parsed.data.sourceUrl ?? ""
      };

      await request.server.redis.lpush(INGEST_QUEUE, JSON.stringify(job));

      return reply.code(202).send({ jobId, documentId, status: "queued" });
    }
  );
}
