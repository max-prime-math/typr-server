import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket, { type RawData } from "ws";
import { materializeProjectFiles } from "./projectFiles.ts";
import {
  TEXPRESSO_WS_LIMITS,
  TEXPRESSO_WS_PROTOCOL_VERSION,
  validateTexpressoClientMessage,
  type TexpressoChangeMessage,
  type TexpressoDiagnostic,
  type TexpressoInitializeMessage,
  type TexpressoPageDescriptor,
  type TexpressoServerMessage
} from "./texpressoWsProtocol.ts";
import {
  TexpressoSession,
  type TexpressoRenderedPage,
  type TexpressoSnapshot
} from "./texpressoSession.ts";

interface QueuedChange {
  message: TexpressoChangeMessage;
  receivedAt: number;
}

export type LiveSessionCloseReason = "client-shutdown" | "client-disconnect" | "server-shutdown" | "error";

/** Owns exactly one private WebSocket connection and at most one TeXpresso process. */
export class TexpressoLiveSession {
  readonly closed: Promise<void>;

  private readonly socket: WebSocket;
  private readonly onClosed: (session: TexpressoLiveSession) => void;
  private readonly sessionId = randomUUID();
  private readonly queue: QueuedChange[] = [];
  private workspace: string | undefined;
  private session: TexpressoSession | undefined;
  private renderDpi: number = TEXPRESSO_WS_LIMITS.defaultDpi;
  private initialized = false;
  private initializing = false;
  private processing = false;
  private closing = false;
  private latestReceivedRevision = 0;
  private appliedRevision = 0;
  private lastGoodRevision: number | null = null;
  private outbound: Promise<void> = Promise.resolve();
  private resolveClosed!: () => void;
  private removeExitListener: (() => void) | undefined;
  private idleTimer: NodeJS.Timeout;
  private readonly lifetimeTimer: NodeJS.Timeout;

  constructor(socket: WebSocket, onClosed: (session: TexpressoLiveSession) => void) {
    this.socket = socket;
    this.onClosed = onClosed;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.idleTimer = setTimeout(() => { void this.close("error"); }, 5 * 60_000);
    this.lifetimeTimer = setTimeout(() => { void this.close("error"); }, 30 * 60_000);
    socket.on("message", (data, isBinary) => {
      this.resetIdleTimer();
      void this.handleFrame(data, isBinary).catch(() => this.close("error", false));
    });
    socket.once("close", () => { void this.close("client-disconnect", false); });
    socket.once("error", () => { void this.close("error", false); });
  }

  async close(reason: LiveSessionCloseReason, notifyClient = true): Promise<void> {
    if (this.closing) return this.closed;
    this.closing = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.lifetimeTimer);
    this.queue.length = 0;
    this.removeExitListener?.();
    try {
      if (notifyClient && this.socket.readyState === WebSocket.OPEN) {
        try {
          await this.sendJson({ type: "session-closed", sessionId: this.initialized ? this.sessionId : undefined, reason });
        } catch {
          // Teardown must continue even if the peer vanished during this send.
        }
        this.socket.close(reason === "server-shutdown" ? 1012 : 1000, reason);
      }
      await Promise.allSettled([
        this.session?.close() ?? Promise.resolve(),
        this.workspace ? rm(this.workspace, { recursive: true, force: true }) : Promise.resolve()
      ]);
      if (!notifyClient && this.socket.readyState === WebSocket.OPEN) this.socket.close();
    } finally {
      this.onClosed(this);
      this.resolveClosed();
    }
  }

  private resetIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.close("error"); }, 5 * 60_000);
  }

  private async handleFrame(data: RawData, isBinary: boolean): Promise<void> {
    if (this.closing) return;
    if (isBinary) {
      await this.protocolFailure("unexpected-binary-frame", "Clients must send JSON text frames; binary frames are server-to-client PNG payloads only.", true);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(rawDataToUtf8(data));
    } catch {
      await this.protocolFailure("malformed-json", "WebSocket text frames must contain valid JSON.", false);
      return;
    }
    const validation = validateTexpressoClientMessage(value);
    if (!validation.ok) {
      await this.protocolFailure(validation.code, validation.message, false, validation.revision);
      return;
    }
    const message = validation.message;
    if (message.type === "shutdown") {
      await this.close("client-shutdown");
      return;
    }
    if (message.type === "initialize") {
      if (this.initialized || this.initializing) {
        await this.protocolFailure("already-initialized", "A WebSocket connection can initialize only one TeXpresso session.", false, message.revision);
        return;
      }
      void this.initialize(message);
      return;
    }
    await this.enqueueChange(message);
  }

  private async initialize(message: TexpressoInitializeMessage): Promise<void> {
    this.initializing = true;
    const startedAt = performance.now();
    try {
      this.workspace = await mkdtemp(join(tmpdir(), "typr-texpresso-ws-"));
      await materializeProjectFiles(this.workspace, message.files);
      const textFiles = message.files
        .filter((file): file is Extract<typeof file, { kind: "text" }> => file.kind === "text")
        .map((file) => ({ path: file.path, content: file.content }));
      const session = await TexpressoSession.start({
        projectRoot: this.workspace,
        mainFilePath: message.mainFilePath,
        files: textFiles,
        timeoutMs: 30_000
      });
      if (this.closing) {
        await session.close();
        return;
      }
      this.session = session;
      this.renderDpi = message.render?.dpi ?? TEXPRESSO_WS_LIMITS.defaultDpi;
      this.latestReceivedRevision = message.revision;
      this.appliedRevision = message.revision;
      this.initialized = true;
      this.removeExitListener = session.onUnexpectedExit((error) => { void this.nativeSessionFailed(error); });
      const initialCompileMs = performance.now() - startedAt;
      await this.sendJson({
        type: "session-ready",
        protocolVersion: TEXPRESSO_WS_PROTOCOL_VERSION,
        sessionId: this.sessionId,
        revision: message.revision,
        processId: session.pid,
        render: { dpi: this.renderDpi },
        initialCompileMs: rounded(initialCompileMs)
      });
      const snapshot = session.snapshot();
      if (snapshot.result === "latex-error") {
        await this.sendCompileError(message.revision, snapshot, initialCompileMs);
      } else {
        await this.renderRevision(message.revision, initialCompileMs, startedAt);
      }
    } catch (error) {
      await this.sessionFailure("initialization-failed", error, message.revision);
    } finally {
      this.initializing = false;
      if (!this.closing) void this.drainChanges();
    }
  }

  private async enqueueChange(message: TexpressoChangeMessage): Promise<void> {
    if (!this.initialized || !this.session) {
      await this.protocolFailure("not-initialized", "Send initialize and wait for session-ready before sending changes.", false, message.revision);
      return;
    }
    if (message.revision <= this.latestReceivedRevision) {
      await this.protocolFailure(
        "stale-revision",
        `Revision ${message.revision} is not greater than the latest accepted revision ${this.latestReceivedRevision}.`,
        false,
        message.revision
      );
      return;
    }
    if (this.queue.length >= TEXPRESSO_WS_LIMITS.maxQueuedRevisions) {
      await this.protocolFailure(
        "revision-queue-full",
        `Revision queue exceeds ${TEXPRESSO_WS_LIMITS.maxQueuedRevisions}; reconnect with a complete current source state.`,
        true,
        message.revision
      );
      return;
    }
    if (this.session.getBuffer(message.path) === undefined) {
      await this.protocolFailure("unknown-file", `Change path is not an open text file: ${message.path}.`, false, message.revision);
      return;
    }
    this.latestReceivedRevision = message.revision;
    this.queue.push({ message, receivedAt: performance.now() });
    if (!this.initializing) void this.drainChanges();
  }

  private async drainChanges(): Promise<void> {
    if (this.processing || this.initializing || this.closing || !this.session) return;
    this.processing = true;
    try {
      while (!this.closing && this.queue.length > 0) {
        const change = this.queue.shift()!;
        await this.sendJson({
          type: "revision-started",
          sessionId: this.sessionId,
          revision: change.message.revision,
          queueDepth: this.queue.length
        });
        const updateStart = performance.now();
        let snapshot: TexpressoSnapshot;
        try {
          snapshot = await this.session.applyRangeChange(change.message.path, change.message.range, change.message.text);
        } catch (error) {
          await this.protocolFailure(
            "invalid-change-range",
            error instanceof Error ? error.message : String(error),
            true,
            change.message.revision
          );
          continue;
        }
        const updateMs = performance.now() - updateStart;
        this.appliedRevision = change.message.revision;
        if (snapshot.result === "latex-error") {
          await this.sendJson({
            type: "revision-applied",
            sessionId: this.sessionId,
            revision: change.message.revision,
            updateMs: rounded(updateMs),
            render: "not-rendered",
            queueDepth: this.queue.length
          });
          await this.sendCompileError(change.message.revision, snapshot, updateMs);
          continue;
        }
        if (this.queue.length > 0) {
          await this.sendJson({
            type: "revision-applied",
            sessionId: this.sessionId,
            revision: change.message.revision,
            updateMs: rounded(updateMs),
            render: "coalesced",
            queueDepth: this.queue.length
          });
          continue;
        }
        await this.sendJson({
          type: "revision-applied",
          sessionId: this.sessionId,
          revision: change.message.revision,
          updateMs: rounded(updateMs),
          render: "pending",
          queueDepth: 0
        });
        await this.renderRevision(change.message.revision, updateMs, change.receivedAt);
      }
    } catch (error) {
      await this.sessionFailure("session-operation-failed", error, this.appliedRevision || undefined);
    } finally {
      this.processing = false;
      if (!this.closing && this.queue.length > 0) void this.drainChanges();
    }
  }

  /** Conservatively renders every page because upstream exposes no dirty-page set. */
  private async renderRevision(revision: number, updateMs: number, revisionStartedAt: number): Promise<boolean> {
    if (!this.session || this.closing) return false;
    const renderStartedAt = performance.now();
    const pages: TexpressoRenderedPage[] = [];
    let bytes = 0;
    for (let page = 0; page <= TEXPRESSO_WS_LIMITS.maxPages; page += 1) {
      if (revision !== this.latestReceivedRevision && pages.length > 0) return false;
      try {
        const rendered = await this.session.renderPage(page, this.renderDpi);
        if (page === TEXPRESSO_WS_LIMITS.maxPages) {
          throw new Error(`Document exceeds the private transport limit of ${TEXPRESSO_WS_LIMITS.maxPages} pages.`);
        }
        bytes += rendered.data.byteLength;
        if (rendered.data.byteLength > TEXPRESSO_WS_LIMITS.maxPageBytes || bytes > TEXPRESSO_WS_LIMITS.maxDocumentImageBytes) {
          throw new Error("Rendered PNG payload exceeds the private transport image limits.");
        }
        pages.push(rendered);
      } catch (error) {
        const pageCount = await this.session.getPageCount();
        if (page < TEXPRESSO_WS_LIMITS.maxPages && pageCount === pages.length && pages.length > 0) break;
        throw error;
      }
    }
    if (revision !== this.latestReceivedRevision) return false;
    const renderMs = performance.now() - renderStartedAt;
    this.lastGoodRevision = revision;
    const descriptors = pages.map(pageDescriptor);
    await this.sendJson({
      type: "document",
      sessionId: this.sessionId,
      revision,
      lastGoodRevision: revision,
      pageCount: pages.length,
      pages: descriptors
    });
    for (const page of pages) await this.sendPage(revision, page);
    await this.sendJson({
      type: "revision-complete",
      sessionId: this.sessionId,
      revision,
      lastGoodRevision: revision,
      pageCount: pages.length,
      renderedPages: pages.length,
      timings: {
        updateMs: rounded(updateMs),
        renderMs: rounded(renderMs),
        serverMs: rounded(performance.now() - revisionStartedAt)
      }
    });
    return true;
  }

  private async sendCompileError(revision: number, snapshot: TexpressoSnapshot, updateMs: number): Promise<void> {
    const log = `${snapshot.output}\n${snapshot.log}`.slice(-TEXPRESSO_WS_LIMITS.maxDiagnosticLogChars);
    await this.sendJson({
      type: "compile-error",
      sessionId: this.sessionId,
      revision,
      lastGoodRevision: this.lastGoodRevision,
      diagnostics: diagnosticsFromLog(log),
      log,
      updateMs: rounded(updateMs)
    });
  }

  private async nativeSessionFailed(error: Error): Promise<void> {
    if (this.closing) return;
    await this.sessionFailure("texpresso-exited", error, this.appliedRevision || undefined);
  }

  private async sessionFailure(code: string, error: unknown, revision?: number): Promise<void> {
    if (this.closing) return;
    try {
      await this.sendJson({
        type: "session-error",
        sessionId: this.initialized ? this.sessionId : undefined,
        code,
        message: error instanceof Error ? error.message : String(error),
        ...(revision === undefined ? {} : { revision })
      });
    } catch {
      // The native session still must be reaped if the peer reset first.
    } finally {
      await this.close("error");
    }
  }

  private async protocolFailure(code: string, message: string, fatal: boolean, revision?: number): Promise<void> {
    try {
      await this.sendJson({ type: "protocol-error", code, message, fatal, ...(revision === undefined ? {} : { revision }) });
    } catch {
      if (!fatal) await this.close("error", false);
    } finally {
      if (fatal) await this.close("error");
    }
  }

  private sendJson(message: TexpressoServerMessage): Promise<void> {
    return this.enqueueFrames([{ data: JSON.stringify(message), binary: false }]);
  }

  private sendPage(revision: number, page: TexpressoRenderedPage): Promise<void> {
    const metadata: TexpressoServerMessage = {
      type: "page",
      sessionId: this.sessionId,
      revision,
      ...pageDescriptor(page)
    };
    // One outbound queue writes these adjacent frames atomically with respect
    // to every other server message, so the binary frame is never ambiguous.
    return this.enqueueFrames([
      { data: JSON.stringify(metadata), binary: false },
      { data: page.data, binary: true }
    ]);
  }

  private enqueueFrames(frames: readonly { data: string | Uint8Array; binary: boolean }[]): Promise<void> {
    const task = async () => {
      for (const frame of frames) {
        if (this.socket.readyState !== WebSocket.OPEN) return;
        await new Promise<void>((resolve, reject) => {
          this.socket.send(frame.data, { binary: frame.binary }, (error) => error ? reject(error) : resolve());
        });
      }
    };
    this.outbound = this.outbound.then(task, task);
    return this.outbound;
  }
}

function pageDescriptor(page: TexpressoRenderedPage): TexpressoPageDescriptor {
  return {
    page: page.page,
    width: page.width,
    height: page.height,
    dpi: page.dpi,
    mimeType: page.mimeType,
    byteLength: page.data.byteLength
  };
}

function diagnosticsFromLog(log: string): TexpressoDiagnostic[] {
  const fileLine = /(?:^|\n)(?:\.\/)?([^:\n]+\.tex):(\d+):(?:(\d+):)?\s*(.+)/m.exec(log);
  const bang = /^!\s*(.+)$/m.exec(log);
  const line = /^l\.(\d+)/m.exec(log);
  const message = fileLine?.[4]?.trim() || bang?.[1]?.trim() || "TeXpresso reported a LaTeX error; see the bounded log.";
  return [{
    severity: "error",
    message,
    ...(fileLine?.[1] ? { path: fileLine[1] } : {}),
    ...(fileLine?.[2] ? { line: Number(fileLine[2]) - 1 } : line?.[1] ? { line: Number(line[1]) - 1 } : {}),
    ...(fileLine?.[3] ? { column: Number(fileLine[3]) - 1 } : {})
  }];
}

function rawDataToUtf8(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}
