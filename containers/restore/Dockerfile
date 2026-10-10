# Pinned restore runtime (S3-R3). Base image pinned by digest; the OpenCode
# Linux build is version- and checksum-pinned. Resolved versions are baked
# into the image and verified at run time by the restore worker.
ARG BASE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
FROM ${BASE_IMAGE}

# Required runtime tools: git (workspace VCS), sqlite3 (session store
# seeding), ca-certificates and curl (pinned downloads). Versions are
# recorded at build time from THIS base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git sqlite3 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=2.0.18
ARG OPENCODE_SHA256=f46253f0ff5eff0c1751d3b734ede55cc60d932d60af81d061d03745f9998082
ARG OPENCODE_URL=https://opencode.ai/files/bin/2.0.18/opencode-linux-arm64.tar.gz
RUN curl -fsSL "${OPENCODE_URL}" -o /tmp/opencode.tar.gz \
    && echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
    && mkdir -p /usr/local/opencode \
    && tar -xzf /tmp/opencode.tar.gz -C /usr/local/opencode \
    && chmod +x /usr/local/opencode/opencode \
    && rm /tmp/opencode.tar.gz \
    && /usr/local/opencode/opencode --version

# Resolved-version fingerprints, verified by the worker at run time.
RUN sqlite3 --version | head -c 200 > /usr/local/share/harness-sqlite-version \
    && git --version > /usr/local/share/harness-git-version \
    && node --version > /usr/local/share/harness-node-version

ENV HARNESS_SQLITE_VERSION_FILE=/usr/local/share/harness-sqlite-version
ENV OPENCODE_BIN=/usr/local/opencode/opencode

WORKDIR /work
CMD ["/bin/bash"]