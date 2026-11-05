# One image, two modes: "control-plane" (dashboard + API) and "runner" (one per host).
# Both base images are pinned by digest: bump them by hand.
ARG BUILDER_IMAGE=node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:55de7e48a8414e7aff825207c0b3c0f7db3b10133efc50d748560c27c9053be1

# Metadata-capable checkpoint tool, isolated from the Node build dependencies.
FROM ${BUILDER_IMAGE} AS checkpoint-tool
RUN apt-get update && apt-get install -y --no-install-recommends rsync \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /checkpoint-tool/lib /checkpoint-tool/licenses \
  && cp /usr/bin/rsync /checkpoint-tool/rsync \
  && ldd /usr/bin/rsync | awk '$2 == "=>" && $3 ~ /^\// { print $3 }' | while read -r library; do \
       case "$(basename "$library")" in libc.so.6) continue ;; esac; \
       cp -L "$library" /checkpoint-tool/lib/; \
     done \
  && cp /usr/bin/tar /checkpoint-tool/tar \
  && ldd /usr/bin/tar | awk '$2 == "=>" && $3 ~ /^\// { print $3 }' | while read -r library; do \
       case "$library" in */libc.so*) ;; *) cp -L "$library" /checkpoint-tool/lib/ ;; esac; \
     done \
  && for package in tar libselinux1 libpcre2-8-0 rsync libacl1 libpopt0 liblz4-1 libzstd1 libxxhash0 libssl3t64 zlib1g; do \
       cp -L "/usr/share/doc/$package/copyright" "/checkpoint-tool/licenses/$package"; \
     done \
  && cp -R /usr/share/common-licenses /checkpoint-tool/licenses/common \
  && dpkg-query -W > /checkpoint-tool/debian-packages.txt \
  && printf '%s\n' 'Corresponding Debian source packages: https://sources.debian.org/' \
       > /checkpoint-tool/SOURCES \
  && LD_LIBRARY_PATH=/checkpoint-tool/lib /checkpoint-tool/rsync --version \
  && LD_LIBRARY_PATH=/checkpoint-tool/lib /checkpoint-tool/tar --version

# nsenter, for a shell on the host: the helper container that opens one enters the host's namespaces with it. Copied
# to where the builder has it, with the two libraries the runtime lacks, by their real paths (not /lib's symlink).
FROM ${BUILDER_IMAGE} AS host-terminal-tool
RUN mkdir -p /host-terminal-tool/usr/bin /host-terminal-licenses \
  && cp /usr/bin/nsenter /host-terminal-tool/usr/bin/nsenter \
  && ldd /usr/bin/nsenter | awk '$2 == "=>" && $3 ~ /^\// { print $3 }' | while read -r library; do \
       case "$(basename "$library")" in libc.so.6) continue ;; esac; \
       real="$(readlink -f "$library")"; \
       mkdir -p "/host-terminal-tool$(dirname "$real")"; \
       cp "$real" "/host-terminal-tool$(dirname "$real")/$(basename "$library")"; \
     done \
  && for package in util-linux libselinux1 libpcre2-8-0; do \
       cp -L "/usr/share/doc/$package/copyright" "/host-terminal-licenses/$package"; \
     done \
  && /usr/bin/nsenter --version

FROM ${BUILDER_IMAGE} AS dependencies
WORKDIR /build
COPY package.json package-lock.json ./
# --ignore-scripts: no package install scripts run at build time; native modules ship prebuilt.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-fund --no-audit

FROM dependencies AS build
ARG BUILDER_IMAGE
ARG RUNTIME_IMAGE
COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev
# What tells two builds of one release apart: every runtime input a runner has, which src/shared/runner-identity.ts
# works out from the imports of the code a runner runs, so a dashboard-only change asks nothing of it.
RUN node dist/server/shared/runner-identity.js dist/server package.json package-lock.json \
      "${BUILDER_IMAGE}" "${RUNTIME_IMAGE}" > dist/server/build-id \
  && cat dist/server/build-id
# Keep only this platform's SQLite binary; its C sources, other platforms' builds and type
# definitions are ~28 MB the runtime never reads. ssh2's optional native helpers are never built
# (--ignore-scripts), and it runs on Node's own crypto without them.
RUN rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src node_modules/@types \
  node_modules/cpu-features node_modules/nan \
  && find node_modules/better-sqlite3/prebuilds -type f ! -name "linux-$(node -p process.arch).node" -delete \
  && mkdir -p /build/empty-data /build/empty-join

# Same Debian release (glibc) as the builder, so the native modules installed above load here.
FROM ${RUNTIME_IMAGE}
# What the dashboard's "Add a host" tells new runners to run: the release build passes this image's own name.
ARG AUTOHEAL_IMAGE=ghcr.io/aiulian25/autoheal:1
WORKDIR /app
# Owned by root and not writable by the app user: the app cannot modify its own code.
COPY --from=build /build/package.json ./
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --from=checkpoint-tool /checkpoint-tool ./checkpoint-tool
COPY --from=host-terminal-tool /host-terminal-tool/ /
COPY --from=host-terminal-tool /host-terminal-licenses ./host-terminal-tool/licenses
# A fresh named volume takes its directory's owner, so the non-root app can write its data, and
# the control plane the join code its own host's runner reads.
COPY --from=build --chown=65532:65532 /build/empty-data /data
COPY --from=build --chown=65532:65532 /build/empty-join /join
ENV NODE_ENV=production AUTOHEAL_IMAGE=${AUTOHEAL_IMAGE}
USER 65532:65532
EXPOSE 8443 9443
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/dist/server/main.js", "healthcheck"]
# "control-plane", "runner", or another command main.js lists: backup-passphrase, restore, reset-admin…
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/server/main.js"]
CMD ["control-plane"]
