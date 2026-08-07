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

CMD ["node", "--import", "tsx", "src/index.ts"]
