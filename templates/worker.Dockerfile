# Image for running repository checks under Orbit's container isolation
# provider (src/isolation/container.ts). It stays minimal on purpose: the
# repository brings its own dependencies through its lockfile, and the
# hardening is applied at `docker run` time, not here (no network, read-only
# root filesystem, all capabilities dropped, no-new-privileges, the host
# uid:gid, CPU/memory/pids limits, a tmpfs on /tmp).
#
# Build it once; runs use --pull never and fail fast if it is missing:
#
#   docker build -t orbit-check:node22 -f templates/worker.Dockerfile templates
FROM node:22-bookworm-slim

# git: checks commonly call it (lint-staged, changed-file detection), and the
# worktree's git directory is mounted read-only beside it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The container runs as the host uid, which has no passwd entry or home
# directory in the image, and the root filesystem is read-only. HOME and the
# npm cache therefore point at the /tmp tmpfs (Orbit also sets HOME=/tmp).
ENV HOME=/tmp \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false

WORKDIR /tmp
CMD ["node", "--version"]
