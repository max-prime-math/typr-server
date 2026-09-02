# syntax=docker/dockerfile:1

# This tag is multi-architecture and keeps the runtime aligned with the Node
# 22.6+ requirement for built-in TypeScript type stripping.
ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
ARG TEXPRESSO_REV=e8df7709077b2f86f6e16e6c86ceefb86de06f8d
ARG WS_VERSION=8.21.3
ARG COMPANION_VERSION=0.1.6-dev
ARG IMAGE_SOURCE=https://github.com/max-prime-math/typr-server
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG TINYTEX_VERSION=2026.08

# TeXpresso builds a custom incremental XeTeX frontend/engine pair. Keep its
# compiler and development headers out of the Companion runtime image.
FROM ${NODE_IMAGE} AS texpresso-build
ARG TEXPRESSO_REV

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        build-essential \
        ca-certificates \
        git \
        libfontconfig-dev \
        libfreetype-dev \
        libgraphite2-dev \
        libgumbo-dev \
        libharfbuzz-dev \
        libicu-dev \
        libjbig2dec0-dev \
        libjpeg-dev \
        libleptonica-dev \
        libmupdf-dev \
        libmujs-dev \
        libopenjp2-7-dev \
        libpng-dev \
        libsdl2-dev \
        libssl-dev \
        pkg-config \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
COPY docker/patches/texpresso-page-export.patch /tmp/texpresso-page-export.patch
RUN git clone https://github.com/let-def/texpresso.git texpresso \
    && cd texpresso \
    && git checkout --detach "${TEXPRESSO_REV}" \
    && git apply --recount /tmp/texpresso-page-export.patch \
    && make all

COPY docker/typr-native-sandbox.c /tmp/typr-native-sandbox.c
RUN cc -O2 -Wall -Wextra -Werror -o /opt/typr-native-sandbox /tmp/typr-native-sandbox.c

FROM ${NODE_IMAGE} AS runtime
ARG TEXPRESSO_REV
ARG WS_VERSION
ARG COMPANION_VERSION
ARG IMAGE_SOURCE
ARG VCS_REF
ARG BUILD_DATE
ARG TINYTEX_VERSION

LABEL org.opencontainers.image.title="typr-server" \
      org.opencontainers.image.description="Local Typr Companion native LaTeX runtime with experimental TeXpresso live preview" \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.url="${IMAGE_SOURCE}" \
      org.opencontainers.image.documentation="${IMAGE_SOURCE}/blob/main/docs/companion-installation.md" \
      org.opencontainers.image.version="${COMPANION_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      io.typr.companion.protocol-version="1" \
      io.typr.texpresso.revision="${TEXPRESSO_REV}"

# Keep the native toolchain deliberately LaTeX-focused.  The package selection
# covers the standard LaTeX classes, common packages/fonts, graphics/TikZ, and
# BibTeX/Biber workflows without installing the full TeX Live collection.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        biber \
        ca-certificates \
        cm-super \
        curl \
        latexmk \
        lmodern \
        libfontconfig1 \
        libfreetype6 \
        libgraphite2-3 \
        libgumbo1 \
        libharfbuzz0b \
        libicu72 \
        libjbig2dec0 \
        libjpeg62-turbo \
        libleptonica-dev \
        libmupdf-dev \
        libmujs2 \
        libopenjp2-7 \
        libpng16-16 \
        libsdl2-2.0-0 \
        libssl3 \
        zlib1g \
        texlive-bibtex-extra \
        texlive-fonts-recommended \
        texlive-latex-base \
        texlive-latex-extra \
        texlive-latex-recommended \
        texlive-pictures \
        texlive-plain-generic \
        texlive-science \
        texlive-xetex \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# tlmgr verifies the signed TeX Live database when GnuPG is available.
RUN apt-get update \
    && apt-get install --no-install-recommends -y gnupg \
    && rm -rf /var/lib/apt/lists/*

# The final compiler uses a portable, current TeX Live tree. The Debian TeX
# packages above remain for TeXpresso's custom engine. Each architecture asset
# is pinned by exact byte size and SHA-256 before extraction.
RUN set -eu; \
    architecture="$(dpkg --print-architecture)"; \
    case "$architecture" in \
      amd64) archive="TinyTeX-linux-x86_64-v${TINYTEX_VERSION}.tar.xz"; expected_size="152058464"; expected_sha="59685643fb4160f779df5e3d7d78266a86818ebb86ac25c7900723b0fd73a7cd"; tex_bin="x86_64-linux" ;; \
      arm64) archive="TinyTeX-linux-arm64-v${TINYTEX_VERSION}.tar.xz"; expected_size="155871496"; expected_sha="c6713bf6c44048a4902040a08763c611deac3644b844f03d7244ae49a54a2a08"; tex_bin="aarch64-linux" ;; \
      *) echo "Unsupported TinyTeX architecture: $architecture" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/rstudio/tinytex-releases/releases/download/v${TINYTEX_VERSION}/${archive}"; \
    curl --fail --location --silent --show-error "$url" --output /tmp/tinytex.tar.xz; \
    test "$(stat -c %s /tmp/tinytex.tar.xz)" = "$expected_size"; \
    echo "$expected_sha  /tmp/tinytex.tar.xz" | sha256sum --check --strict; \
    install -d -o node -g node /opt/typr-texlive-seed; \
    tar -xJf /tmp/tinytex.tar.xz --strip-components=1 --directory=/opt/typr-texlive-seed --no-same-owner --owner=node --group=node; \
    ln -s "$tex_bin" /opt/typr-texlive-seed/bin/typr; \
    rm /tmp/tinytex.tar.xz; \
    /opt/typr-texlive-seed/bin/typr/pdflatex --version; \
    /opt/typr-texlive-seed/bin/typr/tlmgr --version

COPY --from=texpresso-build /opt/texpresso/build/texpresso /usr/local/bin/texpresso
COPY --from=texpresso-build /opt/texpresso/build/texpresso-xetex /usr/local/bin/texpresso-xetex
COPY --from=texpresso-build /opt/typr-native-sandbox /usr/local/bin/typr-native-sandbox

WORKDIR /app

# The private TeXpresso transport needs only this small WebSocket implementation;
# keep the frontend dependency tree out of the runtime image.
COPY docker/typr-server-package.json ./package.json
COPY docker/typr-server-package-lock.json ./package-lock.json
RUN test "$(node -p "require('./package.json').dependencies.ws")" = "${WS_VERSION}" \
    && npm ci --omit=dev \
    && npm cache clean --force

# Node 22 strips the server's TypeScript types exactly as `npm run companion`
# does during local development. Copy only its runtime source and the stable
# transport-neutral protocol, so the frontend toolchain is absent here.
COPY --chown=node:node typr-server ./typr-server
COPY --chown=node:node src/companion-protocol ./src/companion-protocol

RUN install -d -o node -g node /var/lib/typr-texlive

VOLUME ["/var/lib/typr-texlive"]

ENV NODE_ENV=production \
    TYPR_COMPANION_VERSION=${COMPANION_VERSION} \
    TYPR_COMPANION_HOST=0.0.0.0 \
    TYPR_COMPANION_PORT=8484 \
    TYPR_COMPANION_SANDBOX_EXECUTABLE=/usr/local/bin/typr-native-sandbox \
    TYPR_COMPANION_BUNDLED_TEX_SEED=/opt/typr-texlive-seed \
    TYPR_COMPANION_BUNDLED_TEX_CACHE=/var/lib/typr-texlive \
    TYPR_COMPANION_BUNDLED_TEX_VERSION=${TINYTEX_VERSION} \
    TYPR_COMPANION_ALLOWED_ORIGINS=https://typr.ca,https://beta.typr.ca,https://dev.typr.ca,http://localhost:5173,http://127.0.0.1:5173,http://[::1]:5173

USER node

EXPOSE 8484 8485

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8484/api/v1/status').then((response) => process.exit(response.ok || response.status === 401 ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "--experimental-strip-types", "typr-server/cli.ts"]
