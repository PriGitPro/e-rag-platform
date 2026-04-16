/**
 * Query routes:
 *   POST /v1/query        — authenticated hybrid retrieval (sync, proto01)
 *   POST /v1/query/stream — authenticated agentic hybrid retrieval (SSE, M2)
 *
 * /v1/query:
 *   1. JWT auth + RBAC + token-budget check
 *   2. Forward to Python query-service /retrieve (sync)
 *   3. Return ranked chunks
 *
 * /v1/query/stream:
 *   1. JWT auth + RBAC (no token-budget — context size not known upfront)
 *   2. Forward to Python query-service /retrieve/stream
 *   3. Pipe SSE stream back to client verbatim
 *   SSE events: thought | tool_call | tool_result | governance | chunk | done
 */
import { Readable } from "node:stream";
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

const streamQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).default(5),
  useLlmClassifier: z.boolean().default(true),
});

export async function queryRoutes(app: FastifyInstance): Promise<void> {
  // ── Sync retrieval (proto01, unchanged) ──────────────────────────────────────
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

  // ── Streaming agentic retrieval (M2) ─────────────────────────────────────────
  app.post(
    "/v1/query/stream",
    {
      preHandler: [requireAuth, requireRoles(["rag:query", "admin"])],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
          keyGenerator: (request) => resolveRateLimitKey(app, request)
        }
      }
    },
    async (request, reply) => {
      const parsed = streamQuerySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "BAD_REQUEST", message: "Invalid request body" });
      }

      const { query, topK, useLlmClassifier } = parsed.data;
      const tenantId = request.auth?.tenantId ?? "";
      const userId = request.auth?.sub ?? "";
      const planRunId = crypto.randomUUID();
      const { QUERY_SERVICE_URL } = getEnv();

      let upstream: Response;
      try {
        upstream = await fetch(`${QUERY_SERVICE_URL}/retrieve/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            tenant_id: tenantId,
            user_id: userId,
            plan_run_id: planRunId,
            top_k: topK,
            use_llm_classifier: useLlmClassifier,
          }),
          signal: AbortSignal.timeout(120_000)  // 2 min — agentic loops can be slow
        });
      } catch (err) {
        app.log.error({ err }, "query-service stream unreachable");
        return reply.code(503).send({ error: "SERVICE_UNAVAILABLE", message: "Query service is unavailable" });
      }

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => "");
        app.log.warn({ status: upstream.status, detail }, "query-service stream error");
        return reply.code(502).send({ error: "UPSTREAM_ERROR", message: detail || "Query service returned an error" });
      }

      // Set SSE headers before streaming
      reply.header("Content-Type", "text/event-stream");
      reply.header("Cache-Control", "no-cache");
      reply.header("X-Accel-Buffering", "no");
      reply.header("Connection", "keep-alive");

      // Convert the Web ReadableStream to a Node.js Readable and pipe via reply.send().
      // Fastify will flush headers and stream the bytes verbatim.
      // Readable.fromWeb is available in Node.js 18+.
      const nodeStream = Readable.fromWeb(
        upstream.body as Parameters<typeof Readable.fromWeb>[0]
      );

      return reply.send(nodeStream);
    }
  );
}
