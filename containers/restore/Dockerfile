# Pinned restore runtime (S3-R3). Base image pinned by digest; the OpenCode
# Linux build is version- and checksum-pinned. Resolved versions are baked
# into the image and verified at run time by the restore worker.
ARG BASE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
FROM ${BASE_IMAGE}

# Required runtime tools: git (workspace VCS), sqlite3 (session store
# seeding), ca-certificates (TLS trust for OpenCode). Everything resolves
# from ONE frozen Debian snapshot over HTTPS and every package is pinned to
# an exact version. The base image ships no CA bundle, so the CA bundle is
# extracted from the vendored, sha256-pinned ca-certificates .deb before
# any apt traffic; the real pinned package then replaces it. A version
# drift fails the build instead of silently changing the runtime.
COPY vendor/ca-certificates_20230311+deb12u1_all.deb /tmp/ca-certificates.deb
RUN echo "0d5f444f594e48c1e16a41d8fc628a09b24c658916a1274025c2330f2a802bed  /tmp/ca-certificates.deb" | sha256sum -c - \
    && dpkg -x /tmp/ca-certificates.deb /tmp/ca-extract \
    && mkdir -p /etc/ssl/certs \
    && cat /tmp/ca-extract/usr/share/ca-certificates/mozilla/*.crt > /etc/ssl/certs/ca-certificates.crt \
    && rm -rf /tmp/ca-extract /tmp/ca-certificates.deb
RUN set -eux; \
    printf 'Types: deb\nURIs: https://snapshot.debian.org/archive/debian/20261008T000000Z\nSuites: bookworm\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' > /etc/apt/sources.list.d/debian.sources; \
    rm -f /etc/apt/sources.list.d/debian-security.sources; \
    apt-get -o Acquire::Retries=8 -o Acquire::https::Timeout=60 update; \
    apt-get -o Acquire::Retries=8 install -y --no-install-recommends \
      git=1:2.39.5-0+deb12u3 \
      git-man=1:2.39.5-0+deb12u3 \
      sqlite3=3.40.1-2+deb12u2 \
      libsqlite3-0=3.40.1-2+deb12u2 \
      ca-certificates=20230311+deb12u1 \
      openssl=3.0.20-1~deb12u2 \
      libssl3=3.0.20-1~deb12u2; \
    rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=2.0.18
ARG OPENCODE_SHA256=f46253f0ff5eff0c1751d3b734ede55cc60d932d60af81d061d03745f9998082
ARG OPENCODE_URL=https://opencode.ai/files/bin/2.0.18/opencode-linux-arm64.tar.gz
# The download uses the base image's node (no curl/wget needed).
RUN node -e "fetch(process.argv[1]).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then(b => require('fs').writeFileSync('/tmp/opencode.tar.gz', Buffer.from(b)))" "${OPENCODE_URL}" \
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