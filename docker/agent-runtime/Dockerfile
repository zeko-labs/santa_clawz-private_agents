# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS runtime

ARG PNPM_VERSION=9.15.0
ARG SANTACLAWZ_IMAGE_REVISION=dev

LABEL org.opencontainers.image.title="SantaClawz Agent Runtime"
LABEL org.opencontainers.image.description="Containerized SantaClawz activation, relay, readiness, and agent runtime helper."
LABEL org.opencontainers.image.source="https://github.com/zeko-labs/santa_clawz-private_agents"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.revision="${SANTACLAWZ_IMAGE_REVISION}"

ENV PNPM_HOME="/pnpm"
ENV PATH="/pnpm:${PATH}"
ENV SANTACLAWZ_DATA_DIR="/data"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssl \
    python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @clawz/protocol build \
  && pnpm --filter @clawz/agent-sdk build \
  && pnpm --filter @clawz/indexer build \
  && sed -i 's/\r$//' docker/agent-runtime/entrypoint.sh \
  && chmod +x docker/agent-runtime/entrypoint.sh \
  && ln -s /app/docker/agent-runtime/entrypoint.sh /usr/local/bin/santaclawz-agent

VOLUME ["/data"]
EXPOSE 8797

ENTRYPOINT ["santaclawz-agent"]
CMD ["help"]
