import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

const claimsSchema = z.object({
  sub: z.string().min(1),
  tenantId: z.string().uuid(),
  roles: z.array(z.string()).default([]),
  tokenBudget: z.number().int().positive().default(4000)
});

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
    const parsed = claimsSchema.parse(request.user);
    request.auth = {
      userId: parsed.sub,
      tenantId: parsed.tenantId,
      roles: parsed.roles,
      tokenBudget: parsed.tokenBudget
    };
  } catch {
    void reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "Valid JWT required"
    });
  }
}
