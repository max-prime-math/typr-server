# Third-party notices

## Windows portable runtime

The Windows single-executable build embeds the following unmodified runtime
components so it can operate without administrator access or network downloads:

- TinyTeX v2026.08, a portable TeX Live distribution, GPL-2.0 and the component
  licenses collected by TeX Live. The release artifact is pinned by SHA-256.
- MuPDF.js v1.28.0 and its MuPDF WebAssembly engine, AGPL-3.0-or-later.
- Node.js, distributed under the Node.js license and its bundled third-party
  notices.

The corresponding source and license information is available from the public
Typr Server source tree, the TinyTeX/TeX Live distributions, Artifex's MuPDF.js
repository, and the Node.js distribution. Typr Server itself is
AGPL-3.0-or-later.

## TikZ Editor

Typr embeds the visual [TikZ Editor](https://github.com/DominikPeters/tikz-editor)
through the [TeXlyre embed mirror](https://github.com/TeXlyre/tikz-editor-embed-mirror).
Both projects are distributed under the MIT License. The exact license texts are
installed beside the generated browser assets by `npm run tikz-editor:assets`.

- TikZ Editor v0.5.2, copyright (c) 2026 Dominik Peters
- TeXlyre embed mirror v0.5.2, copyright (c) 2026 TeXlyre contributors

## Tylax

Typr uses the browser build of [Tylax](https://github.com/scipenai/tylax) for
experimental TikZ-to-CeTZ conversion. Tylax is distributed under the Apache
License 2.0. The exact license text and checksum-pinned browser assets are
installed by `npm run tylax:assets`.

- Tylax v0.3.7, copyright its contributors
