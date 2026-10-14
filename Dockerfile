# For running Haii for several people on a server (cloud mode). Running it for yourself needs none
# of this: `npm install` and `npm run dev` are the whole setup.
#
# A bare `docker run` is not a working local app. Without DATABASE_URL the server listens on
# 127.0.0.1 inside the container, where a published port cannot reach it. Setting DATABASE_URL
# starts cloud mode, and then ENCRYPTION_KEY must be set too (64 hex characters).
# server/.env.example lists the other settings.
#
# This project has NO build step: tsx runs the TypeScript directly (server/package.json start is
# `tsx src/index.ts`), and packages/schema is consumed as raw source (its "main" is src/index.ts).
# What has to happen is: get Node, install node_modules, copy the source, run it.
#
# Deliberately boring. No multi-stage, no alpine, no tricks.

FROM node:22-slim

# NEVER ADD `ARG` FOR A SECRET HERE. This file deliberately declares no build arguments at all.
#
# ARG and ENV values persist in image layers, so anyone who can pull the image can read them.
# ENCRYPTION_KEY is the one that matters. It encrypts every user's stored connector tokens
# (lib/crypto.ts), and it cannot simply be rotated if it leaks: changing it makes stored tokens
# unreadable, and no re-encryption path exists. A key you cannot rotate must never end up
# somewhere it can be read.
#
# Nothing in this build needs a secret. `npm ci` reads a lockfile. Every secret is injected by the
# host at container start and read from process.env at runtime: env.ts refuses to boot a cloud
# deploy without a valid ENCRYPTION_KEY.
#
# If you genuinely need a build-time value later, check first whether it is a secret. If it is,
# use BuildKit secret mounts (RUN --mount=type=secret), never ARG.

WORKDIR /app

ENV NODE_ENV=production

# Manifests on their own layer, before the source. Dependencies reinstall only when a package.json
# or the lockfile changes, not on every edit to a route or a prompt. Copy each workspace's manifest
# too, or `npm ci` cannot resolve the workspace graph.
COPY package.json package-lock.json ./
COPY packages/schema/package.json ./packages/schema/
COPY server/package.json ./server/

# --include=dev is EXPLICIT on purpose, twice over.
#
# First, the intent: both workspace packages are consumed as raw TypeScript and resolved by tsx at
# runtime, so the dev/prod split is not a reliable guide to what is needed to RUN this.
#
# Second, the trap: npm reads NODE_ENV, and `ENV NODE_ENV=production` above would otherwise make
# this omit devDependencies silently. Stating the flag means the behaviour cannot be changed by
# someone moving an unrelated ENV line.
RUN npm ci --include=dev

COPY . .

# Documentation only. The host injects PORT and server/src/env.ts reads it, falling back to 4820
# for local runs; EXPOSE binds nothing.
EXPOSE 4820

CMD ["npm", "start", "-w", "@haii/server"]
