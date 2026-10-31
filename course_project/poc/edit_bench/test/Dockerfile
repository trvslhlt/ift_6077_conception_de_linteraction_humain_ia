# Smoke-test runner: Playwright's image ships the matching Chromium, for amd64 and arm64.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
WORKDIR /test
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY *.mjs ./
CMD ["node", "smoke.mjs"]
