import type { FastifyReply, FastifyRequest } from "fastify";

export function requireRoles(requiredRoles: string[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.auth) {
      reply.code(401).send({ error: "UNAUTHORIZED", message: "Auth required" });
      return;
    }

    const hasRole = requiredRoles.some((role) => request.auth?.roles.includes(role));

    if (!hasRole) {
      reply.code(403).send({
        error: "FORBIDDEN",
        message: "Insufficient role permissions",
        requiredRoles
      });
      return;
    }
  };
}
