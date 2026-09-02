# ===========================================================================
# Mimo Bot — RPA Execution Agent
# Runs the bot (Express + Playwright-SAP Fiori RPA) headless in a container.
# ===========================================================================
FROM node:20-bookworm

# Install browsers into a fixed, predictable location.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# 1) Install Node dependencies (cached unless the manifests change).
COPY package.json package-lock.json ./
RUN npm ci

# 2) Install the exact Chromium build the playwright-sap fork pins (rev 1179)
#    plus the OS libraries it needs to run headless on Debian.
RUN npx playwright install --with-deps chromium

# 3) Copy the application source.
#    config.json is excluded via .dockerignore — provide it at runtime
#    (bind mount) so secrets are never baked into the image.
COPY . .

# The bot's HTTP server (config.port). The server reaches this for the /poll wake.
EXPOSE 3001

CMD ["node", "index.js"]
