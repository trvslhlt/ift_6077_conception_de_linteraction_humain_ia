# openDAW studio, built from source and served as static files.
#
# Stage 1 builds the studio (TypeScript + the Rust/WASM audio engine).
# Stage 2 serves dist/ with nginx, adding the cross-origin-isolation headers
# openDAW needs for SharedArrayBuffer.
#
# Every input is pinned (image digests, apt package, rustup, toolchains, openDAW commit;
# npm and cargo dependencies come from openDAW's lockfiles). Verified working 2026-10-29.

FROM node:26.13.0-trixie@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617 AS build

ARG OPENDAW_REPO=https://github.com/andremichelle/openDAW.git
ARG OPENDAW_REF=652e6caf759b06e8171f49fb71257884e7cae66e
ARG RUSTUP_VERSION=1.29.2
ARG RUST_STABLE=1.99.1
ARG RUST_NIGHTLY=nightly-2026-10-29
ARG BINARYEN_VERSION=120-4

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates build-essential \
        binaryen=$BINARYEN_VERSION \
    && rm -rf /var/lib/apt/lists/*

# Rust: stable for the engine, nightly + rust-src for the device side modules (-Zbuild-std=core).
# Default ~/.rustup and ~/.cargo locations: openDAW's build-wasm.sh finds cargo via ~/.cargo/env.
# DEVICE_TOOLCHAIN is read by build-wasm.sh (defaults to the floating "nightly").
ENV PATH=/root/.cargo/bin:$PATH DEVICE_TOOLCHAIN=$RUST_NIGHTLY
RUN arch="$(uname -m)-unknown-linux-gnu" \
    && curl -sSfo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$arch/rustup-init" \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "$RUST_STABLE" \
        --target wasm32-unknown-unknown \
    && rm /tmp/rustup-init \
    && rustup toolchain install "$RUST_NIGHTLY" --profile minimal --component rust-src --target wasm32-unknown-unknown

WORKDIR /src
# git has no network retries (npm and cargo do); Docker Desktop's DNS occasionally drops a lookup.
RUN git init -q . \
    && git remote add origin "$OPENDAW_REPO" \
    && { git fetch -q --depth 1 origin "$OPENDAW_REF" \
        || { sleep 5; git fetch -q --depth 1 origin "$OPENDAW_REF"; } \
        || { sleep 20; git fetch -q --depth 1 origin "$OPENDAW_REF"; }; } \
    && git checkout -q FETCH_HEAD

RUN npm ci --no-audit --no-fund
# The studio's vite build exceeds node's default heap. Loose env mode lets turbo pass
# NODE_OPTIONS and DEVICE_TOOLCHAIN through to the package builds.
ENV NODE_OPTIONS=--max-old-space-size=3072 TURBO_TELEMETRY_DISABLED=1
RUN npx turbo build --filter=@opendaw/app-studio --env-mode=loose --output-logs=errors-only

FROM nginx:1.31.8-alpine@sha256:785835ea65db4bba6f021acc0f3be91b0fef76a53fe41f8588c6698d2aed0606
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/packages/app/studio/dist /usr/share/nginx/html
EXPOSE 8080
