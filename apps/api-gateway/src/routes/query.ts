/**
 * /v1/query — authenticated query endpoint.
 *
 * Flow:
 *   1. JWT auth + RBAC + token-budget check (preHandler chain)
 *   2. Validate request body
 *   3. Forward to Python query-service (hybrid retrieval + BGE rerank)
 *   4. Return ranked chunks — no LLM generation yet (proto01)
 *
 * RFC forward:
 *   - Add LLM generation pass after chunks are retrieved (Week 3)
 *   - Add governance intercepts (PII scan, faithfulness NLI) around the
 *     generation step using the governance_events table
 *   - Stream the response via SSE when generation is live
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireRoles } from "../middleware/rbac.js";
import { enforceTokenBudget } from "../middleware/tokenBudget.js";
import { resolveRateLimitKey } from "../plugins/rateLimitKey.js";
import { getEnv } from "../config/env.js";

const querySchema = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).default(5),
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
          keyGenerator: (request) => resolveRateLimitKey(app, request)
        }
      }
    },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "BAD_REQUEST", message: "Invalid request body" });
      }

      const { query, topK } = parsed.data;
      const tenantId = request.auth?.tenantId ?? "";
      const { QUERY_SERVICE_URL } = getEnv();

      let upstream: Response;
      try {
        upstream = await fetch(`${QUERY_SERVICE_URL}/retrieve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, tenant_id: tenantId, top_k: topK }),
          signal: AbortSignal.timeout(30_000)
        });
      } catch (err) {
        app.log.error({ err }, "query-service unreachable");
        return reply.code(503).send({ error: "SERVICE_UNAVAILABLE", message: "Query service is unavailable" });
      }

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        app.log.warn({ status: upstream.status, detail }, "query-service error");
        return reply.code(upstream.status === 501 ? 501 : 502).send({
          error: "UPSTREAM_ERROR",
          message: detail || "Query service returned an error"
        });
      }

      const result = await upstream.json() as Record<string, unknown>;
      return reply.send({
        queryId: crypto.randomUUID(),
        tenantId,
        ...result
      });
    }
  );
}
