# ---- Stage 1: Build Frontend Bundle ----
FROM node:22-bookworm-slim AS frontend-builder

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html tsconfig.json tsconfig.node.json vite.config.ts ./
COPY src ./src
RUN pnpm run build

# ---- Stage 2: Build Rust Web Backend ----
FROM rust:1-bookworm AS backend-builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY src-tauri ./src-tauri

RUN cargo build --release --locked -p lighterm-server

# ---- Stage 3: Minimal Runtime Image ----
FROM debian:bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Lighterm Web" \
      org.opencontainers.image.description="Lighterm self-hosted Web App (SSH/SFTP/Terminal workbench)" \
      org.opencontainers.image.source="https://github.com/LazyBug1E0CF/Lighterm" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    bash \
    curl \
    gosu \
    openssh-client \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --home-dir /home/lighterm --shell /bin/bash --uid 1000 lighterm \
  && mkdir -p /data /app \
  && chown -R lighterm:lighterm /data /app

WORKDIR /app

COPY --from=backend-builder /app/target/release/lighterm-server /app/lighterm-server
COPY --from=frontend-builder /app/dist /app/dist
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod 0755 /app/entrypoint.sh

ENV PORT=8080 \
    LIGHTERM_DATA_DIR=/data \
    LIGHTERM_STATIC_DIR=/app/dist \
    PUID=1000 \
    PGID=1000 \
    HOME=/home/lighterm \
    SHELL=/bin/bash \
    RUST_LOG=info

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["/app/lighterm-server"]
