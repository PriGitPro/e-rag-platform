import type { FastifyReply, FastifyRequest } from "fastify";

interface TokenBudgetBody {
  estimatedTokens?: number;
}

export async function enforceTokenBudget(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.auth) {
    void reply.code(401).send({ error: "UNAUTHORIZED", message: "Auth required" });
    return;
  }

  const body = (request.body ?? {}) as TokenBudgetBody;
  const estimatedTokens = body.estimatedTokens ?? 0;

  if (estimatedTokens > request.auth.tokenBudget) {
    void reply.code(422).send({
      error: "TOKEN_BUDGET_EXCEEDED",
      message: "Requested query exceeds per-request token budget",
      available: request.auth.tokenBudget,
      requested: estimatedTokens
    });
  }
}
