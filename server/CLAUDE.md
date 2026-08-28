# Kept server - agent notes

All domain logic is here: HST arithmetic, export generation, filename derivation, fiscal-period slicing, validation.
The root `CLAUDE.md` carries the constraints and engineering rules that govern this directory too.

## Architecture landmarks

- `src/index.ts` is the only place environment variables are read, and it refuses to bind the port until Postgres and object storage both answer. That is why `resolveReceiptParseModel` takes an env bag rather than reading `process.env` itself (2026-08-28): the entrypoint resolves the parse model once and hands it to the sweep, which requires it, so a stored `llm_suggestions` record can never name a model other than the one that produced it.
- `src/productionEnv.ts` holds the checks that run only under `NODE_ENV=production`.
- `src/app.ts` builds the Hono app from injected dependencies; nothing inside it reads the environment, which is what keeps the test-mode Apple verifier out of production.
- `GET /health` is liveness only and is registered above the edge-secret middleware, because Fly's checker probes the machine directly and cannot carry the Cloudflare header.

## Build and test

`docker compose up -d` first: the server and the integration tests both need the local Postgres and MinIO it brings up.

- `npm test` - the integration tests create their own test database.
- `npm run dev` - the real entrypoint, and the one a gate must start before it closes.
- `npm run db:migrate` - migrations are deliberate and never run on boot.
