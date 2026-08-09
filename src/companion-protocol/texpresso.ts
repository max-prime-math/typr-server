import type { ProjectFile } from "./index.ts";

/** Private, experimental transport version. It is not part of Companion API v1. */
export const TEXPRESSO_WS_PROTOCOL_VERSION = 1;
export const TEXPRESSO_WS_ROUTE = "/ws/texpresso";

export const DEFAULT_TEXPRESSO_RENDER_DPI = 192;
export const MIN_TEXPRESSO_RENDER_DPI = 72;
export const MAX_TEXPRESSO_RENDER_DPI = 300;

/** LSP-compatible, zero-based UTF-16 source position. */
export interface TexpressoPosition {
  line: number;
  character: number;
}

export interface TexpressoRange {
  start: TexpressoPosition;
  end: TexpressoPosition;
}

export interface TexpressoInitializeMessage {
  type: "initialize";
  protocolVersion: number;
  revision: number;
  mainFilePath: string;
  render?: { dpi?: number };
  files: ProjectFile[];
}

export interface TexpressoChangeMessage {
  type: "change";
  revision: number;
  path: string;
  range: TexpressoRange;
  text: string;
}

export interface TexpressoShutdownMessage {
  type: "shutdown";
}

export type TexpressoClientMessage =
  | TexpressoInitializeMessage
  | TexpressoChangeMessage
  | TexpressoShutdownMessage;

export interface TexpressoDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface TexpressoPageDescriptor {
  page: number;
  width: number;
  height: number;
  dpi: number;
  mimeType: "image/png";
  byteLength: number;
}

export type TexpressoServerMessage =
  | {
      type: "session-ready";
      protocolVersion: number;
      sessionId: string;
      revision: number;
      processId: number;
      render: { dpi: number };
      initialCompileMs: number;
    }
  | { type: "revision-started"; sessionId: string; revision: number; queueDepth: number }
  | {
      type: "revision-applied";
      sessionId: string;
      revision: number;
      updateMs: number;
      render: "pending" | "coalesced" | "not-rendered";
      queueDepth: number;
    }
  | {
      type: "document";
      sessionId: string;
      revision: number;
      lastGoodRevision: number;
      pageCount: number;
      pages: TexpressoPageDescriptor[];
    }
  | ({ type: "page"; sessionId: string; revision: number } & TexpressoPageDescriptor)
  | {
      type: "revision-complete";
      sessionId: string;
      revision: number;
      lastGoodRevision: number;
      pageCount: number;
      renderedPages: number;
      timings: { updateMs: number; renderMs: number; serverMs: number };
    }
  | {
      type: "compile-error";
      sessionId: string;
      revision: number;
      lastGoodRevision: number | null;
      diagnostics: TexpressoDiagnostic[];
      log: string;
      updateMs: number;
    }
  | { type: "protocol-error"; code: string; message: string; revision?: number; fatal: boolean }
  | { type: "session-error"; sessionId?: string; code: string; message: string; revision?: number }
  | {
      type: "session-closed";
      sessionId?: string;
      reason: "client-shutdown" | "client-disconnect" | "server-shutdown" | "error";
    };
