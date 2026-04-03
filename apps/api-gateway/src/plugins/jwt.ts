import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import type { FastifyInstance } from "fastify";
import type { AppEnv } from "../config/env.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: {
      userId: string;
      tenantId: string;
      roles: string[];
      tokenBudget: number;
    };
  }
}

export const jwtPlugin = fp(async (app: FastifyInstance, env: AppEnv) => {
  await app.register(jwt, {
    secret: env.JWT_SECRET
  });
});
