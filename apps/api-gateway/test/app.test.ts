import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const tenantId = "11111111-1111-1111-1111-111111111111";

describe("API Gateway Week 1", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "week1-test-secret-123456";
    process.env.DEFAULT_RATE_LIMIT_MAX = "100";
    process.env.DEFAULT_RATE_LIMIT_WINDOW = "1 minute";

    const built = await buildApp();
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signToken(payload: object): Promise<string> {
    return app.jwt.sign(payload);
  }

  it("returns health status", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "api-gateway" });
  });

  it("rejects unauthenticated query", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/query",
      payload: { query: "hello", estimatedTokens: 10 }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("UNAUTHORIZED");
  });

  it("rejects user lacking role", async () => {
    const token = await signToken({
      sub: "user-1",
      tenantId,
      roles: ["analyst"],
      tokenBudget: 1000
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/query",
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "hello", estimatedTokens: 10 }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("rejects when token budget is exceeded", async () => {
    const token = await signToken({
      sub: "user-2",
      tenantId,
      roles: ["rag:query"],
      tokenBudget: 100
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/query",
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "large request", estimatedTokens: 500 }
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("TOKEN_BUDGET_EXCEEDED");
  });

  it("accepts valid authenticated query", async () => {
    const token = await signToken({
      sub: "user-3",
      tenantId,
      roles: ["rag:query"],
      tokenBudget: 1000
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/query",
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "What is our PTO policy?", estimatedTokens: 100 }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true, executionPath: "pipeline", tenantId });
  });

  it("enforces route-level rate limit", async () => {
    const token = await signToken({
      sub: "user-rate",
      tenantId,
      roles: ["rag:query"],
      tokenBudget: 1000
    });

    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/query",
        headers: { authorization: `Bearer ${token}` },
        payload: { query: `q-${i}`, estimatedTokens: 10 }
      });
      expect(res.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/v1/query",
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "overflow", estimatedTokens: 10 }
    });

    expect(limited.statusCode).toBe(429);
  });
});
