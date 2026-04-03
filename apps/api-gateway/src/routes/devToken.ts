/**
 * Dev-only token endpoint — disabled in production.
 *
 * Returns a signed JWT for the hardcoded test tenant so the local UI and
 * curl scripts can authenticate without a sign-up flow (Week 1 scope).
 *
 * RBAC note: the test user gets every role so nothing is blocked during
 * local development.  Add per-role test tokens in Week 4 when RBAC UI lands.
 */
import type { FastifyInstance } from "fastify";

const TEST_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export async function devTokenRoutes(app: FastifyInstance): Promise<void> {
  if (process.env["NODE_ENV"] === "production") return;

  app.get("/dev/token", async (_request, reply) => {
    const token = app.jwt.sign(
      {
        sub: "dev-user",
        tenantId: TEST_TENANT_ID,
        roles: ["rag:query", "rag:ingest", "admin"],
        tokenBudget: 32000
      },
      { expiresIn: "24h" }
    );
    return reply.send({ token, tenantId: TEST_TENANT_ID, expiresIn: "24h" });
  });
}
