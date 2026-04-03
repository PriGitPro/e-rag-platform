# Contributing Guide

## Development setup

1. Install Node.js 20+.
2. Install dependencies:
   - `npm install`
3. Run local checks:
   - `npm run typecheck`
   - `npm run test`

Optional local infrastructure:

- `docker compose -f infra/docker-compose.yml up -d`

## Branching and PRs

- Create small, focused pull requests.
- Include tests for all behavior changes.
- Keep public APIs and contracts backwards compatible unless the PR explicitly includes a breaking-change note.
- Link relevant issues and RFC sections in PR descriptions.

## Commit quality

- Prefer descriptive commit messages.
- Keep one logical concern per commit.
- Ensure CI is green before requesting review.

## Security and governance changes

Changes that touch auth, RBAC, governance intercepts, or audit logs must include:

- Unit/integration coverage
- Explicit threat-model impact in PR notes
- Rollback plan (if schema or enforcement behavior changes)
