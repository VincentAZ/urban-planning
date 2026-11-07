# Official Playwright 1.64.1 linux/amd64 manifest, resolved during implementation.
FROM mcr.microsoft.com/playwright@sha256:ee15712262f017b8157421b212b12099146645f44b1bc5c0514cbbe6a229b1d0
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/urban-media
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --ignore-scripts && npm cache clean --force
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# The actual runner and renderer are verified read-only inputs, not arbitrary uploads.
ENTRYPOINT ["node", "/opt/urban-media/worker.mjs"]
