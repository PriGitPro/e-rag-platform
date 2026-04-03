import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireRoles } from "../middleware/rbac.js";

const ingestSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive()
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

      return reply.code(202).send({
        jobId: crypto.randomUUID(),
        status: "queued",
        tenantId: request.auth?.tenantId
      });
    }
  );
}
