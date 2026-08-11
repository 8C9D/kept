# The production image for Fly.io. It runs the SAME entrypoint the same
# way development does - `node --import tsx src/index.ts` - because a
# compiled artifact would be a second code shape that only exists in
# production, which is exactly the environment divergence this project
# keeps paying for (framework §9.3 rule 5, eight instances). tsx's startup
# cost is irrelevant to a process that runs for weeks.
FROM node:24-slim

WORKDIR /app

# Fails the entrypoint loudly if the deployed configuration is not
# production-shaped (src/productionEnv.ts).
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# --include=dev deliberately: tsx runs the TypeScript directly, and
# drizzle-kit must be present so `fly ssh console -C "npm run db:migrate"`
# can run migrations deliberately from inside the machine (never on boot).
RUN npm ci --include=dev

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src

EXPOSE 3000

# Defence in depth, and nothing more: the process reaches no filesystem path at
# runtime beyond reading its own source, and a Fly machine is a single-tenant
# VM. It is here because it costs one line and because "the container runs as
# root" is free to fix now and expensive to fix after something else goes wrong.
#
# node:24-slim ships this user at uid 1000. Everything above ran as root, so
# /app and node_modules are root-owned - which is FINE and is the point of not
# chowning them: the runtime user can read them and cannot modify them, so the
# image's own code is not writable by the process running it. Nothing here
# writes to disk; exports are built in memory and streamed to object storage.
USER node

CMD ["node", "--import", "tsx", "src/index.ts"]
