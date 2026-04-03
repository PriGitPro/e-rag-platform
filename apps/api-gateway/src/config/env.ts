import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  JWT_SECRET: z.string().min(16).default("dev-secret-change-me-12345"),
  DATABASE_URL: z.string().default("postgres://erp:erp@localhost:5432/erp"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  DEFAULT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  DEFAULT_RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  DEFAULT_TOKEN_BUDGET: z.coerce.number().int().positive().default(4000)
});

export type AppEnv = z.infer<typeof schema>;

export function getEnv(): AppEnv {
  return schema.parse(process.env);
}
