FROM node:22-bookworm-slim

# ffmpeg/ffprobe: the sessions audio engine (TTS transcode, duration sync).
# python3: the Lyria BGM recipe (stdlib-only). The lib* set is
# chrome-headless-shell's runtime deps for `kenectai capture` + `check`;
# fonts-liberation/noto keep captured-page screenshots from tofu-ing.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    ffmpeg \
    python3 \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.9"
ENV PATH="/root/.bun/bin:$PATH"

# Pre-install chrome-headless-shell so a session's first capture doesn't
# download a browser at request time; KENECT_BROWSER_PATH short-circuits the
# CLI's browser manager to this binary.
RUN npx -y @puppeteer/browsers install chrome-headless-shell@stable --path /opt/chrome \
    && ln -s "$(find /opt/chrome -name chrome-headless-shell -type f | head -1)" /usr/local/bin/chrome-headless-shell
ENV KENECT_BROWSER_PATH=/usr/local/bin/chrome-headless-shell

WORKDIR /app

COPY package.json bun.lock ./
COPY packages ./packages

RUN bun install --frozen-lockfile
RUN bun run --cwd packages/parsers build \
    && bun run --cwd packages/lint build \
    && bun run --cwd packages/core build \
    && bun run --cwd packages/studio-server build \
    && bun run --cwd packages/engine build \
    && (cd packages/producer && bunx tsx scripts/generate-font-data.ts) \
    && bun run --cwd packages/producer build
RUN bun run --filter @kenectai/gcp-cloud-run build
# The kenectai CLI powers session capture / lint (spawned via KENECT_CLI_PATH).
RUN bun run --filter @kenectai/cli build
RUN bun run --filter @kenectai/api build

# The skills tree IS the sessions orchestrator's playbook: step reference
# docs become Gemini prompt context, and the deterministic pipeline scripts
# (build-frame, audio, captions, transitions, assemble-index) run from here.
COPY skills /app/skills
ENV KENECT_SKILLS_DIR=/app/skills
ENV KENECT_CLI_PATH=/app/packages/cli/dist/cli.js

WORKDIR /app/packages/kenect-api

ENV NODE_ENV=production
ENV PORT=8080

CMD ["bun", "dist/server.js"]
