import type { FastifyInstance, FastifyRequest } from "fastify";

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

export function resolveRateLimitKey(app: FastifyInstance, request: FastifyRequest): string {
  if (request.auth?.userId) {
    return request.auth.userId;
  }

  const token = extractBearerToken(request);
  if (token) {
    const decoded = app.jwt.decode<{ sub?: string }>(token);
    if (decoded && typeof decoded === "object" && typeof decoded.sub === "string" && decoded.sub.length > 0) {
      return decoded.sub;
    }
  }

  return request.ip;
}
