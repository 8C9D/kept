# Kept web - agent notes

Gated locally; production enablement is the owner's, ordered in `README.md`.
The session is the same bearer JWT iOS uses, and the API origin is baked per build rather than configured at runtime.

## Build and test

- `npm test` - vitest over the client's logic (money, query assembly, upload outcomes, prefill/patch rules).
- `npm run dev` - Vite on 5173, the origin the API's dev CORS default grants; sign in with a token from `npm run dev:session-token` (server/).
