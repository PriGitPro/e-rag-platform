import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireRoles } from "../middleware/rbac.js";
import { enforceTokenBudget } from "../middleware/tokenBudget.js";

const querySchema = z.object({
  query: z.string().min(1),
  estimatedTokens: z.number().int().positive().max(32000).default(256)
});

export async function queryRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/query",
    {
      preHandler: [requireAuth, requireRoles(["rag:query", "admin"]), enforceTokenBudget],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.headers.authorization ?? request.ip
        }
      }
    },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "BAD_REQUEST",
          message: "Invalid request body"
        });
      }

      return reply.send({
        queryId: crypto.randomUUID(),
        executionPath: "pipeline",
        tenantId: request.auth?.tenantId,
        accepted: true
      });
    }
  );
}
