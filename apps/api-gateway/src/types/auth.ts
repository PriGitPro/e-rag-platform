export type Role =
  | "admin"
  | "analyst"
  | "confluence:read"
  | "jira:read"
  | "rag:query";

export interface UserClaims {
  sub: string;
  tenantId: string;
  roles: Role[];
  tokenBudget: number;
}
