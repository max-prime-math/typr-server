import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { getAsset, isSea } from "node:sea";
import type * as MuPdf from "mupdf";
import type { TexpressoRange } from "../src/companion-protocol/texpresso.ts";
import { runLatexProject } from "./latexProject.ts";
import { hasLatexError, positionToOffset, TexpressoSession, type TexpressoLookup, type TexpressoRenderedPage, type TexpressoSessionOptions, type TexpressoSnapshot } from "./texpressoSession.ts";

export interface LiveLatexSession {
  readonly pid: number;
  applyRangeChange(path: string, range: TexpressoRange, replacement: string): Promise<TexpressoSnapshot>;
  renderPage(page: number, dpi?: number): Promise<TexpressoRenderedPage>;
  getPageCount(): Promise<number>;
  getCachedPage(page: number, dpi?: number): TexpressoRenderedPage | undefined;
  getBuffer(path: string): string | undefined;
  snapshot(): TexpressoSnapshot;
  onUnexpectedExit(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

/** Uses TeXpresso where upstream supports it and an offline full-build renderer on Windows. */
export async function startLiveLatexSession(options: TexpressoSessionOptions): Promise<LiveLatexSession> {
  if (process.platform !== "win32" && process.env.TYPR_COMPANION_LIVE_BACKEND !== "full") {
    return TexpressoSession.start(options);
  }
  return FullCompileLiveSession.start(options);
}

class FullCompileLiveSession implements LiveLatexSession {
  readonly pid = process.pid;

  private readonly options: TexpressoSessionOptions;
  private readonly buffers = new Map<string, string>();
  private readonly renderedPages = new Map<string, TexpressoRenderedPage>();
  private readonly abortController = new AbortController();
  private snapshotValue: TexpressoSnapshot = emptySnapshot();
  private closed = false;

  private constructor(options: TexpressoSessionOptions) {
    this.options = options;
    for (const file of options.files) this.buffers.set(normalizePath(file.path), file.content);
  }

  static async start(options: TexpressoSessionOptions): Promise<FullCompileLiveSession> {
    const session = new FullCompileLiveSession(options);
    await session.compile();
    return session;
  }

  async applyRangeChange(path: string, range: TexpressoRange, replacement: string): Promise<TexpressoSnapshot> {
    this.assertOpen();
    const normalized = normalizePath(path);
    const current = this.buffers.get(normalized);
    if (current === undefined) throw new Error(`Live-preview file is not open: ${normalized}`);
    const start = positionToOffset(current, range.start);
    const end = positionToOffset(current, range.end);
    if (end < start) throw new Error("Live-preview change range end precedes its start.");
    const next = `${current.slice(0, start)}${replacement}${current.slice(end)}`;
    this.buffers.set(normalized, next);
    await writeFile(join(this.options.projectRoot, ...normalized.split("/")), next);
    await this.compile();
    return this.snapshot();
  }

  async renderPage(pageNumber: number, dpi = 144): Promise<TexpressoRenderedPage> {
    this.assertOpen();
    const key = `${pageNumber}:${dpi}`;
    const cached = this.renderedPages.get(key);
    if (cached) return clonePage(cached);
    const mupdf = await loadMuPdf();
    const pdf = await this.openPdf(mupdf);
    try {
      if (pageNumber < 0 || pageNumber >= pdf.countPages()) throw new Error(`PDF page ${pageNumber} is out of range.`);
      const page = pdf.loadPage(pageNumber);
      try {
        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(dpi / 72, dpi / 72),
          mupdf.ColorSpace.DeviceRGB,
          false,
          true
        );
        try {
          const rendered: TexpressoRenderedPage = {
            page: pageNumber,
            width: pixmap.getWidth(),
            height: pixmap.getHeight(),
            dpi,
            mimeType: "image/png",
            data: Uint8Array.from(pixmap.asPNG())
          };
          this.renderedPages.set(key, rendered);
          return clonePage(rendered);
        } finally {
          pixmap.destroy();
        }
      } finally {
        page.destroy();
      }
    } finally {
      pdf.destroy();
    }
  }

  async getPageCount(): Promise<number> {
    const mupdf = await loadMuPdf();
    const pdf = await this.openPdf(mupdf);
    try {
      return pdf.countPages();
    } finally {
      pdf.destroy();
    }
  }

  getCachedPage(page: number, dpi = 144): TexpressoRenderedPage | undefined {
    const cached = this.renderedPages.get(`${page}:${dpi}`);
    return cached ? clonePage(cached) : undefined;
  }

  getBuffer(path: string): string | undefined {
    return this.buffers.get(normalizePath(path));
  }

  snapshot(): TexpressoSnapshot {
    return {
      ...this.snapshotValue,
      inputFiles: [...this.snapshotValue.inputFiles],
      lookups: [...this.snapshotValue.lookups]
    };
  }

  onUnexpectedExit(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortController.abort();
    this.renderedPages.clear();
  }

  private async compile(): Promise<void> {
    const result = await runLatexProject(
      this.options.projectRoot,
      this.options.mainFilePath,
      this.abortController.signal
    );
    const compilerLog = await readFile(this.logPath(), "utf8").catch(() => "");
    const output = [result.stdout, result.stderr, compilerLog].filter(Boolean).join("\n");
    this.snapshotValue = {
      flush: this.snapshotValue.flush + 1,
      output,
      log: compilerLog,
      inputFiles: [...this.buffers.keys()],
      lookups: [] as TexpressoLookup[],
      stderr: result.stderr,
      result: result.exitCode === 0 && !hasLatexError(output) ? "success" : "latex-error"
    };
    this.renderedPages.clear();
  }

  private async openPdf(mupdf: typeof MuPdf): Promise<MuPdf.Document> {
    if (this.snapshotValue.result !== "success") throw new Error("The current source did not produce a renderable PDF.");
    return mupdf.Document.openDocument(await readFile(this.pdfPath()), "application/pdf");
  }

  private pdfPath(): string {
    const main = this.options.mainFilePath;
    return join(this.options.projectRoot, dirname(main), `${basename(main, extname(main))}.pdf`);
  }

  private logPath(): string {
    const main = this.options.mainFilePath;
    return join(this.options.projectRoot, dirname(main), `${basename(main, extname(main))}.log`);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Live-preview session is closed.");
  }
}

let mupdfPromise: Promise<typeof MuPdf> | undefined;

function loadMuPdf(): Promise<typeof MuPdf> {
  if (isSea()) {
    const target = globalThis as typeof globalThis & { $libmupdf_wasm_Module?: { wasmBinary: Uint8Array } };
    target.$libmupdf_wasm_Module ??= { wasmBinary: new Uint8Array(getAsset("mupdf-wasm.wasm")) };
  }
  mupdfPromise ??= import("mupdf");
  return mupdfPromise;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function emptySnapshot(): TexpressoSnapshot {
  return { flush: 0, output: "", log: "", inputFiles: [], lookups: [], stderr: "", result: "success" };
}

function clonePage(page: TexpressoRenderedPage): TexpressoRenderedPage {
  return { ...page, data: Uint8Array.from(page.data) };
}
