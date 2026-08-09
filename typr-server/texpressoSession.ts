import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  DEFAULT_TEXPRESSO_RENDER_DPI,
  MAX_TEXPRESSO_RENDER_DPI,
  MIN_TEXPRESSO_RENDER_DPI,
  type TexpressoPosition,
  type TexpressoRange
} from "../src/companion-protocol/texpresso.ts";

export {
  DEFAULT_TEXPRESSO_RENDER_DPI,
  MAX_TEXPRESSO_RENDER_DPI,
  MIN_TEXPRESSO_RENDER_DPI
};
export type { TexpressoPosition, TexpressoRange };

/**
 * The documented TeXpresso editor protocol is deliberately asynchronous: a
 * `flush` message means that its log/output buffers have reached a stable
 * point suitable for an editor to inspect.  It is not a request/response
 * compiler API, so this experimental adapter exposes snapshots rather than
 * pretending TeXpresso has produced an authoritative final-build result.
 */
export interface TexpressoSessionOptions {
  projectRoot: string;
  mainFilePath: string;
  files: readonly TexpressoTextFile[];
  executable?: string;
  timeoutMs?: number;
}

export interface TexpressoTextFile {
  path: string;
  content: string;
}

export interface TexpressoSnapshot {
  /** TeXpresso's own output/log synchronization reached a `flush` event. */
  flush: number;
  output: string;
  log: string;
  inputFiles: readonly string[];
  lookups: readonly TexpressoLookup[];
  stderr: string;
  /** A conservative classification of TeX diagnostics; it is not a public Typr diagnostic format. */
  result: "success" | "latex-error";
}

/** A browser-native raster page produced from TeXpresso's current display list. */
export interface TexpressoRenderedPage {
  /** Zero-based TeXpresso page number. */
  page: number;
  width: number;
  height: number;
  dpi: number;
  mimeType: "image/png";
  data: Uint8Array;
}

export interface TexpressoLookup {
  kind: string;
  status: string;
  path: string;
}

interface FlushWaiter {
  after: number;
  resolve: (snapshot: TexpressoSnapshot) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PageImageWaiter {
  page: number;
  dpi: number;
  resolve: (page: TexpressoRenderedPage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PageCountWaiter {
  resolve: (count: number) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER_CHARS = 256 * 1024;
const MAX_LINES = 8_000;
const MAX_RENDER_BYTES = 16 * 1024 * 1024;

/**
 * Owns one persistent TeXpresso child process and its virtual-file-system
 * overlay.  This is intentionally internal: no Companion HTTP endpoint or
 * advertised capability uses it in this milestone.
 */
export class TexpressoSession {
  readonly pid: number;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;
  private readonly projectRoot: string;
  private readonly buffers = new Map<string, string>();
  private readonly outputLines: string[] = [];
  private readonly logLines: string[] = [];
  private readonly inputFiles: string[] = [];
  private readonly lookups: TexpressoLookup[] = [];
  private readonly stderrChunks: string[] = [];
  private readonly flushWaiters = new Set<FlushWaiter>();
  private readonly pageImageWaiters = new Set<PageImageWaiter>();
  private readonly pageCountWaiters = new Set<PageCountWaiter>();
  private readonly renderedPages = new Map<string, TexpressoRenderedPage>();
  private flushCount = 0;
  private closed = false;
  private exitError: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly unexpectedExitListeners = new Set<(error: Error) => void>();

  private constructor(
    child: ChildProcessWithoutNullStreams,
    projectRoot: string,
    timeoutMs: number,
    files: readonly TexpressoTextFile[]
  ) {
    if (!child.pid) {
      throw new Error("TeXpresso started without a process identifier.");
    }
    this.child = child;
    this.pid = child.pid;
    this.projectRoot = projectRoot;
    this.timeoutMs = timeoutMs;
    for (const file of files) {
      this.buffers.set(normalizeProtocolPath(file.path), file.content);
    }

    createInterface({ input: child.stdout }).on("line", (line) => this.handleProtocolLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.appendStderr(chunk));
    child.on("error", (error) => this.fail(new Error(`TeXpresso failed to start: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (!this.closed) {
        this.fail(new Error(`TeXpresso exited unexpectedly (code ${code ?? "none"}, signal ${signal ?? "none"}). ${this.stderrText()}`));
      }
    });
  }

  static async start(options: TexpressoSessionOptions): Promise<TexpressoSession> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const executable = options.executable ?? "texpresso";
    const mainFilePath = normalizeProtocolPath(options.mainFilePath);
    if (!options.files.some((file) => normalizeProtocolPath(file.path) === mainFilePath)) {
      throw new Error("The TeXpresso session main file must be present in its virtual filesystem.");
    }

    const child = spawn(
      executable,
      ["-json", "-lines", "-texlive", "-stream", options.mainFilePath],
      {
        cwd: options.projectRoot,
        detached: process.platform !== "win32",
        env: { ...process.env, SDL_VIDEODRIVER: process.env.SDL_VIDEODRIVER ?? "dummy" },
        stdio: "pipe"
      }
    );
    const session = new TexpressoSession(child, options.projectRoot, timeoutMs, options.files);

    // -stream starts paused. Register and populate every source buffer before
    // resuming, which is TeXpresso's documented deterministic startup flow.
    for (const file of options.files) session.send(["register", session.commandPath(file.path)]);
    for (const file of options.files) session.send(["open", session.commandPath(file.path), file.content]);
    const initialFlush = session.flushCount;
    session.send(["resume"]);
    await session.waitForFlush(initialFlush);
    return session;
  }

  /** Replaces text using TeXpresso's native LSP-style UTF-16 `change-range` command. */
  async replaceText(path: string, expectedText: string, replacement: string): Promise<TexpressoSnapshot> {
    const protocolPath = normalizeProtocolPath(path);
    const current = this.buffers.get(protocolPath);
    if (current === undefined) throw new Error(`TeXpresso virtual file is not open: ${protocolPath}`);
    const offset = current.indexOf(expectedText);
    if (offset < 0) throw new Error(`Expected text was not found in ${protocolPath}.`);

    const startPosition = offsetToPosition(current, offset);
    const endPosition = offsetToPosition(current, offset + expectedText.length);
    return this.applyRangeChange(path, {
      start: { line: startPosition.line, character: startPosition.column },
      end: { line: endPosition.line, character: endPosition.column }
    }, replacement);
  }

  /** Applies a native LSP-style range edit. Lines and characters are UTF-16 based. */
  async applyRangeChange(path: string, range: TexpressoRange, replacement: string): Promise<TexpressoSnapshot> {
    const protocolPath = normalizeProtocolPath(path);
    const current = this.buffers.get(protocolPath);
    if (current === undefined) throw new Error(`TeXpresso virtual file is not open: ${protocolPath}`);
    const startOffset = positionToOffset(current, range.start);
    const endOffset = positionToOffset(current, range.end);
    if (endOffset < startOffset) throw new Error("TeXpresso change range end precedes its start.");

    const flush = this.flushCount;
    this.send([
      "change-range",
      this.commandPath(protocolPath),
      range.start.line,
      range.start.character,
      range.end.line,
      range.end.character,
      replacement
    ]);
    this.buffers.set(protocolPath, `${current.slice(0, startOffset)}${replacement}${current.slice(endOffset)}`);
    const snapshot = await this.waitForFlush(flush);
    // The upstream protocol exposes no dirty-page set. A successful source
    // change can shift later pages or alter a cross-reference, so invalidate
    // every cached raster result rather than risking a stale preview.
    if (snapshot.result === "success") this.renderedPages.clear();
    return snapshot;
  }

  /** Returns the current TeXpresso page count without involving SDL. */
  getPageCount(): Promise<number> {
    const response = this.waitForPageCount();
    try {
      this.send(["page-count"]);
    } catch (error) {
      // The child can exit between waiter registration and the protocol write.
      // Mark the otherwise-orphaned waiter rejection as observed.
      void response.catch(() => {});
      throw error;
    }
    return response;
  }

  /**
   * Rasterizes one current display-list page to PNG in the TeXpresso process.
   * This is intentionally an internal experimental adapter, not a Companion API.
   */
  async renderPage(page: number, dpi = DEFAULT_TEXPRESSO_RENDER_DPI): Promise<TexpressoRenderedPage> {
    if (!Number.isInteger(page) || page < 0) throw new Error("TeXpresso page must be a non-negative integer.");
    if (!Number.isInteger(dpi) || dpi < MIN_TEXPRESSO_RENDER_DPI || dpi > MAX_TEXPRESSO_RENDER_DPI) {
      throw new Error(`TeXpresso render DPI must be between ${MIN_TEXPRESSO_RENDER_DPI} and ${MAX_TEXPRESSO_RENDER_DPI}.`);
    }
    const cacheKey = `${page}:${dpi}`;
    const cached = this.renderedPages.get(cacheKey);
    if (cached) return cloneRenderedPage(cached);

    const response = this.waitForPageImage(page, dpi);
    try {
      this.send(["render-page", page, dpi]);
    } catch (error) {
      void response.catch(() => {});
      throw error;
    }
    const rendered = await response;
    this.renderedPages.set(cacheKey, rendered);
    return cloneRenderedPage(rendered);
  }

  /** Returns a retained last-known-good page without asking TeXpresso to rerender. */
  getCachedPage(page: number, dpi = DEFAULT_TEXPRESSO_RENDER_DPI): TexpressoRenderedPage | undefined {
    const cached = this.renderedPages.get(`${page}:${dpi}`);
    return cached ? cloneRenderedPage(cached) : undefined;
  }

  getBuffer(path: string): string | undefined {
    return this.buffers.get(normalizeProtocolPath(path));
  }

  snapshot(): TexpressoSnapshot {
    const log = this.logLines.join("\n");
    const output = this.outputLines.join("\n");
    return {
      flush: this.flushCount,
      output,
      log,
      inputFiles: [...this.inputFiles],
      lookups: [...this.lookups],
      stderr: this.stderrText(),
      // stderr is TeXpresso's process-lifetime debug stream and deliberately
      // retains historical errors. The protocol's truncatable output/log VFS
      // is the current diagnostic state, so recovery must be classified from
      // those buffers only.
      result: hasLatexError(`${output}\n${log}`) ? "latex-error" : "success"
    };
  }

  /** Lets an owner tear down its transport immediately if the native child dies. */
  onUnexpectedExit(listener: (error: Error) => void): () => void {
    this.unexpectedExitListeners.add(listener);
    if (this.exitError && !this.closed) queueMicrotask(() => listener(this.exitError!));
    return () => this.unexpectedExitListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = new Promise((resolveClose) => {
      let forceTimeout: NodeJS.Timeout | undefined;
      const gracefulTimeout = setTimeout(() => {
        terminateProcessGroup(this.child);
        forceTimeout = setTimeout(() => {
          terminateProcessGroup(this.child, "SIGKILL");
          resolveClose();
        }, 1_500);
      }, 1_500);
      this.child.once("close", () => {
        clearTimeout(gracefulTimeout);
        if (forceTimeout) clearTimeout(forceTimeout);
        resolveClose();
      });
      this.child.stdin.end();
    });
    return this.closePromise;
  }

  private send(command: readonly unknown[]): void {
    if (this.closed || this.exitError) {
      throw this.exitError ?? new Error("TeXpresso session is closed.");
    }
    if (!this.child.stdin.write(`${JSON.stringify(command)}\n`)) {
      // The pipe remains valid; node will apply backpressure. Protocol writes
      // here are tiny and the POC serializes edits, so no manual drain queue is needed.
    }
  }

  /** The upstream `change-range` handler resolves paths against the root, so
   * use absolute paths consistently for every VFS command. */
  private commandPath(path: string): string {
    return resolve(this.projectRoot, normalizeProtocolPath(path));
  }

  private waitForFlush(after: number): Promise<TexpressoSnapshot> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (this.flushCount > after) return Promise.resolve(this.snapshot());
    return new Promise((resolve, reject) => {
      const waiter: FlushWaiter = {
        after,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.flushWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for TeXpresso flush after ${this.timeoutMs} ms. ${this.stderrText()}`));
        }, this.timeoutMs)
      };
      this.flushWaiters.add(waiter);
    });
  }

  private handleProtocolLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.appendStderr(`Unexpected TeXpresso stdout: ${line}\n`);
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== "string") return;
    const [verb, ...args] = message;
    if (verb === "append-lines" && (args[0] === "out" || args[0] === "log")) {
      const destination = args[0] === "out" ? this.outputLines : this.logLines;
      destination.push(...args.slice(1).filter((line): line is string => typeof line === "string"));
      trimLines(destination);
      return;
    }
    if (verb === "truncate-lines" && (args[0] === "out" || args[0] === "log") && Number.isInteger(args[1])) {
      const destination = args[0] === "out" ? this.outputLines : this.logLines;
      destination.length = Math.max(0, Number(args[1]));
      return;
    }
    if (verb === "input-file" && typeof args[1] === "string") {
      this.inputFiles.push(args[1]);
      trimLines(this.inputFiles);
      return;
    }
    if (verb === "lookup-file" && typeof args[0] === "string" && typeof args[1] === "string" && typeof args[2] === "string") {
      this.lookups.push({ kind: args[0], status: args[1], path: args[2] });
      if (this.lookups.length > MAX_LINES) this.lookups.splice(0, this.lookups.length - MAX_LINES);
      return;
    }
    if (verb === "flush") {
      this.flushCount += 1;
      const snapshot = this.snapshot();
      for (const waiter of [...this.flushWaiters]) {
        if (this.flushCount > waiter.after) {
          clearTimeout(waiter.timeout);
          this.flushWaiters.delete(waiter);
          waiter.resolve(snapshot);
        }
      }
      return;
    }
    if (verb === "page-count" && Number.isInteger(args[0]) && Number(args[0]) >= 0) {
      const waiter = this.pageCountWaiters.values().next().value as PageCountWaiter | undefined;
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.pageCountWaiters.delete(waiter);
        waiter.resolve(Number(args[0]));
      }
      return;
    }
    if (verb === "page-image") {
      const [page, width, height, mimeType, encoded] = args;
      if (!Number.isInteger(page) || !Number.isInteger(width) || !Number.isInteger(height) ||
          Number(page) < 0 || Number(width) <= 0 || Number(height) <= 0 ||
          mimeType !== "image/png" || typeof encoded !== "string") {
        this.appendStderr(`Invalid TeXpresso page-image message.\n`);
        return;
      }
      const waiter = [...this.pageImageWaiters].find((candidate) => candidate.page === Number(page));
      if (!waiter) return;
      try {
        const data = Buffer.from(encoded, "base64");
        if (data.length === 0 || data.length > MAX_RENDER_BYTES || !isPng(data)) {
          throw new Error(`TeXpresso returned an invalid or oversized PNG page (${data.length} bytes).`);
        }
        const png = pngDimensions(data);
        if (png.width !== Number(width) || png.height !== Number(height)) {
          throw new Error("TeXpresso page-image dimensions disagree with its PNG header.");
        }
        clearTimeout(waiter.timeout);
        this.pageImageWaiters.delete(waiter);
        waiter.resolve({ page: Number(page), width: Number(width), height: Number(height), dpi: waiter.dpi, mimeType, data: new Uint8Array(data) });
      } catch (error) {
        clearTimeout(waiter.timeout);
        this.pageImageWaiters.delete(waiter);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (verb === "page-image-error" && Number.isInteger(args[0]) && typeof args[1] === "string") {
      const waiter = [...this.pageImageWaiters].find((candidate) => candidate.page === Number(args[0]));
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.pageImageWaiters.delete(waiter);
        waiter.reject(new Error(`TeXpresso could not render page ${args[0]}: ${args[1]}`));
      }
    }
  }

  private appendStderr(chunk: string): void {
    this.stderrChunks.push(chunk);
    let length = this.stderrChunks.reduce((total, value) => total + value.length, 0);
    while (length > MAX_BUFFER_CHARS && this.stderrChunks.length > 1) {
      length -= this.stderrChunks.shift()!.length;
    }
  }

  private waitForPageCount(): Promise<number> {
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise((resolve, reject) => {
      const waiter: PageCountWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.pageCountWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for TeXpresso page count after ${this.timeoutMs} ms. ${this.stderrText()}`));
        }, this.timeoutMs)
      };
      this.pageCountWaiters.add(waiter);
    });
  }

  private waitForPageImage(page: number, dpi: number): Promise<TexpressoRenderedPage> {
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise((resolve, reject) => {
      const waiter: PageImageWaiter = {
        page,
        dpi,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.pageImageWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for TeXpresso page ${page} after ${this.timeoutMs} ms. ${this.stderrText()}`));
        }, this.timeoutMs)
      };
      this.pageImageWaiters.add(waiter);
    });
  }

  private stderrText(): string {
    return this.stderrChunks.join("").slice(-MAX_BUFFER_CHARS);
  }

  private fail(error: Error): void {
    if (this.exitError) return;
    this.exitError = error;
    for (const waiter of this.flushWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.flushWaiters.clear();
    for (const waiter of this.pageImageWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.pageImageWaiters.clear();
    for (const waiter of this.pageCountWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.pageCountWaiters.clear();
    if (!this.closed) {
      for (const listener of this.unexpectedExitListeners) listener(error);
    }
  }
}

function cloneRenderedPage(page: TexpressoRenderedPage): TexpressoRenderedPage {
  return { ...page, data: new Uint8Array(page.data) };
}

function isPng(data: Uint8Array): boolean {
  return data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
}

export function pngDimensions(data: Uint8Array): { width: number; height: number } {
  if (!isPng(data) || String.fromCharCode(...data.subarray(12, 16)) !== "IHDR") {
    throw new Error("Expected a PNG IHDR header.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function offsetToPosition(source: string, offset: number): { line: number; column: number } {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    throw new Error("TeXpresso range offset is outside the UTF-16 source string.");
  }
  const previousLine = source.lastIndexOf("\n", offset - 1);
  const line = previousLine < 0 ? 0 : source.slice(0, previousLine).split("\n").length;
  return { line, column: offset - previousLine - 1 };
}

export function positionToOffset(source: string, position: TexpressoPosition): number {
  if (!Number.isInteger(position.line) || position.line < 0 ||
      !Number.isInteger(position.character) || position.character < 0) {
    throw new Error("TeXpresso positions must contain non-negative integer line and character values.");
  }
  let lineStart = 0;
  for (let line = 0; line < position.line; line += 1) {
    const newline = source.indexOf("\n", lineStart);
    if (newline < 0) throw new Error("TeXpresso change position line is outside the UTF-16 source string.");
    lineStart = newline + 1;
  }
  const lineEnd = source.indexOf("\n", lineStart);
  const limit = lineEnd < 0 ? source.length : lineEnd;
  const offset = lineStart + position.character;
  if (offset > limit) throw new Error("TeXpresso change position character is outside its UTF-16 source line.");
  return offset;
}

export function hasLatexError(output: string): boolean {
  return /(?:^|\n)! |LaTeX Error:|Emergency stop|Fatal error occurred|Undefined control sequence|Runaway argument\?/m.test(output);
}

function normalizeProtocolPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function trimLines(lines: string[]): void {
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

function terminateProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}
