/**
 * Shared, transport-neutral contract for Typr Companion implementations.
 *
 * This module intentionally contains only JSON-serializable types and constants.
 * It must remain usable by both the browser app and a future typr-server.
 */

/**
 * Compatibility version for the Companion API contract, independent of either
 * Typr's application version or a Companion server's version.
 */
export const TYPR_COMPANION_PROTOCOL_VERSION = 1;

export const TYPR_COMPANION_API_V1_PREFIX = "/api/v1";

/** Shared HTTP route names. This module does not perform HTTP requests. */
export const TYPR_COMPANION_ROUTES = {
  status: `${TYPR_COMPANION_API_V1_PREFIX}/status`,
  compile: `${TYPR_COMPANION_API_V1_PREFIX}/compile`
} as const;

/**
 * Engines known to the first version of the contract. The string extension
 * permits a server to advertise a new engine without changing this package.
 */
export type KnownCompileEngine =
  | "pdflatex"
  | "xelatex"
  | "lualatex"
  | "latexmk"
  | "typst";

export type CompileEngine = KnownCompileEngine | (string & {});

export interface CompileCapability {
  /** An empty list means that this Companion does not offer compilation. */
  engines: CompileEngine[];
}

export interface FilesystemCapability {
  /** Whether persistent Companion-side project storage is available. */
  projectStorage: boolean;
}

export interface LspCapability {
  /** Language identifiers for which the Companion exposes LSP support. */
  languages: string[];
}

export interface BooleanCapability {
  enabled: boolean;
}

/**
 * Capability groups are objects so future fields can be added without changing
 * their existing boolean/list meaning.
 */
export interface CompanionCapabilities {
  compile: CompileCapability;
  filesystem: FilesystemCapability;
  lsp: LspCapability;
  git: BooleanCapability;
  terminal: BooleanCapability;
}

export interface CompanionStatusResponse {
  protocolVersion: number;
  serverVersion: string;
  capabilities: CompanionCapabilities;
}

/** A UTF-8 project file. Text files are the initial supported input form. */
export interface TextProjectFile {
  path: string;
  kind: "text";
  content: string;
}

/**
 * A JSON-safe binary representation reserved for asset support. This contract
 * does not define upload, size limits, or streaming behavior.
 */
export interface BinaryProjectFile {
  path: string;
  kind: "binary";
  encoding: "base64";
  content: string;
}

export type ProjectFile = TextProjectFile | BinaryProjectFile;

/** A complete project compilation request, not just the active document. */
export interface CompileRequest {
  protocolVersion: number;
  engine: CompileEngine;
  mainFilePath: string;
  files: ProjectFile[];
}

/** The generated primary output for a successful initial compilation. */
export interface CompileOutput {
  path: string;
  mediaType: "application/pdf";
  encoding: "base64";
  content: string;
}

/** Minimal compiler-provided error context; richer diagnostics belong to LSP. */
export interface CompileError {
  code: string;
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface CompileSuccess {
  ok: true;
  engine: CompileEngine;
  output: CompileOutput;
  log: string;
  durationMs: number;
}

export interface CompileFailure {
  ok: false;
  engine: CompileEngine;
  errors: CompileError[];
  log: string;
  durationMs?: number;
}

export type CompileResult = CompileSuccess | CompileFailure;
