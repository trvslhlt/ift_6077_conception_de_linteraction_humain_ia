# TakeDo's backend: Node running the TypeScript sources directly (type stripping), restarted on change.
# Only the dependencies are baked in; src/ and ../shared/ are bind-mounted at run time (compose.yaml), at the same
# relative paths as in the repo, so `../../shared/` imports resolve in both places.
FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
WORKDIR /app/backend
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
EXPOSE 8787
CMD ["node", "--watch", "src/main.ts"]
