# Enterprise RAG Platform

Production-oriented monorepo implementing **Week 1** of RFC-001.

## Week 1 scope

- Infrastructure baseline via Docker Compose (Postgres, Redis, Milvus, MinIO)
- Fastify API gateway skeleton
- JWT auth
- RBAC middleware
- Rate limiting and token budget guardrails
- Test suite (Vitest) for core gateway governance controls

## Repo layout

- `apps/api-gateway` - Fastify API service (TypeScript)
- `packages/shared` - shared contracts and constants
- `services/*` - service placeholders for later milestones
- `infra/docker-compose.yml` - local infrastructure stack
- `migrations` - SQL migrations

## Quick start

```bash
npm install
npm run typecheck
npm run test
npm run dev:gateway
```

To boot local infrastructure:

```bash
docker compose -f infra/docker-compose.yml up -d
```

## Open-source standards

- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [License](./LICENSE)
