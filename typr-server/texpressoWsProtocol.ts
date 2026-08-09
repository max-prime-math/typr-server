import {
  DEFAULT_TEXPRESSO_RENDER_DPI,
  MAX_TEXPRESSO_RENDER_DPI,
  MIN_TEXPRESSO_RENDER_DPI,
  TEXPRESSO_WS_PROTOCOL_VERSION,
  TEXPRESSO_WS_ROUTE,
  type TexpressoChangeMessage,
  type TexpressoClientMessage,
  type TexpressoDiagnostic,
  type TexpressoInitializeMessage,
  type TexpressoPageDescriptor,
  type TexpressoRange,
  type TexpressoServerMessage,
  type TexpressoShutdownMessage
} from "../src/companion-protocol/texpresso.ts";
import type { ProjectFile } from "../src/companion-protocol/index.ts";

export { TEXPRESSO_WS_PROTOCOL_VERSION, TEXPRESSO_WS_ROUTE };
export type {
  TexpressoChangeMessage,
  TexpressoClientMessage,
  TexpressoDiagnostic,
  TexpressoInitializeMessage,
  TexpressoPageDescriptor,
  TexpressoServerMessage,
  TexpressoShutdownMessage
};

/** Private transport version. This is deliberately independent of Companion API v1. */
export const TEXPRESSO_WS_LIMITS = {
  maxMessageBytes: 25 * 1024 * 1024,
  maxProjectBytes: 25 * 1024 * 1024,
  maxProjectFiles: 512,
  maxQueuedRevisions: 64,
  maxPageBytes: 16 * 1024 * 1024,
  maxDocumentImageBytes: 128 * 1024 * 1024,
  maxPages: 64,
  maxDiagnosticLogChars: 32 * 1024,
  minDpi: MIN_TEXPRESSO_RENDER_DPI,
  maxDpi: MAX_TEXPRESSO_RENDER_DPI,
  defaultDpi: DEFAULT_TEXPRESSO_RENDER_DPI
} as const;

export type ClientMessageValidation =
  | { ok: true; message: TexpressoClientMessage }
  | { ok: false; code: string; message: string; revision?: number };

export function validateTexpressoClientMessage(value: unknown): ClientMessageValidation {
  if (!isRecord(value) || typeof value.type !== "string") {
    return invalid("malformed-message", "WebSocket messages must be JSON objects with a string type.");
  }
  if (value.type === "shutdown") return { ok: true, message: { type: "shutdown" } };
  if (value.type === "initialize") return validateInitialize(value);
  if (value.type === "change") return validateChange(value);
  return invalid("unknown-message-type", `Unknown TeXpresso message type: ${value.type}.`);
}

function validateInitialize(value: Record<string, unknown>): ClientMessageValidation {
  if (value.protocolVersion !== TEXPRESSO_WS_PROTOCOL_VERSION) {
    return invalid(
      "unsupported-protocol-version",
      `Unsupported private protocolVersion ${String(value.protocolVersion)}; expected ${TEXPRESSO_WS_PROTOCOL_VERSION}.`
    );
  }
  if (!validRevision(value.revision)) return invalid("invalid-revision", "Initialization revision must be a positive safe integer.");
  const mainPathError = validatePrivateProjectPath(value.mainFilePath, "mainFilePath");
  if (mainPathError) return invalid("invalid-project", mainPathError, value.revision as number);
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > TEXPRESSO_WS_LIMITS.maxProjectFiles) {
    return invalid("invalid-project", `files must contain between 1 and ${TEXPRESSO_WS_LIMITS.maxProjectFiles} project files.`, value.revision as number);
  }

  const files: ProjectFile[] = [];
  const seen = new Set<string>();
  let decodedBytes = 0;
  for (let index = 0; index < value.files.length; index += 1) {
    const file = value.files[index];
    if (!isRecord(file)) return invalid("invalid-project", `files[${index}] must be an object.`, value.revision as number);
    const pathError = validatePrivateProjectPath(file.path, `files[${index}].path`);
    if (pathError) return invalid("invalid-project", pathError, value.revision as number);
    const path = file.path as string;
    if (seen.has(path)) return invalid("invalid-project", `files[${index}].path duplicates another file.`, value.revision as number);
    seen.add(path);
    if (file.kind === "text" && typeof file.content === "string") {
      decodedBytes += Buffer.byteLength(file.content);
      files.push({ path, kind: "text", content: file.content });
    } else if (file.kind === "binary" && file.encoding === "base64" && typeof file.content === "string" && isBase64(file.content)) {
      decodedBytes += Buffer.byteLength(file.content, "base64");
      files.push({ path, kind: "binary", encoding: "base64", content: file.content });
    } else {
      return invalid("invalid-project", `files[${index}] must be a text file or valid base64 binary file.`, value.revision as number);
    }
    if (decodedBytes > TEXPRESSO_WS_LIMITS.maxProjectBytes) {
      return invalid("project-too-large", `Decoded project exceeds ${TEXPRESSO_WS_LIMITS.maxProjectBytes} bytes.`, value.revision as number);
    }
  }

  const mainFilePath = value.mainFilePath as string;
  const main = files.find((file) => file.path === mainFilePath);
  if (!main || main.kind !== "text") {
    return invalid("invalid-project", "mainFilePath must identify a supplied text file.", value.revision as number);
  }
  let dpi: number = TEXPRESSO_WS_LIMITS.defaultDpi;
  if (value.render !== undefined) {
    if (!isRecord(value.render) || (value.render.dpi !== undefined && !Number.isInteger(value.render.dpi))) {
      return invalid("invalid-render-settings", "render.dpi must be an integer.", value.revision as number);
    }
    dpi = (value.render.dpi as number | undefined) ?? dpi;
  }
  if (dpi < TEXPRESSO_WS_LIMITS.minDpi || dpi > TEXPRESSO_WS_LIMITS.maxDpi) {
    return invalid(
      "invalid-render-settings",
      `render.dpi must be between ${TEXPRESSO_WS_LIMITS.minDpi} and ${TEXPRESSO_WS_LIMITS.maxDpi}.`,
      value.revision as number
    );
  }

  return {
    ok: true,
    message: {
      type: "initialize",
      protocolVersion: TEXPRESSO_WS_PROTOCOL_VERSION,
      revision: value.revision as number,
      mainFilePath,
      render: { dpi },
      files
    }
  };
}

function validateChange(value: Record<string, unknown>): ClientMessageValidation {
  if (!validRevision(value.revision)) return invalid("invalid-revision", "Change revision must be a positive safe integer.");
  const pathError = validatePrivateProjectPath(value.path, "path");
  if (pathError) return invalid("invalid-change", pathError, value.revision as number);
  if (typeof value.text !== "string") return invalid("invalid-change", "change.text must be a string.", value.revision as number);
  if (!isRange(value.range)) {
    return invalid("invalid-change", "change.range must contain non-negative integer UTF-16 start/end positions.", value.revision as number);
  }
  return {
    ok: true,
    message: {
      type: "change",
      revision: value.revision as number,
      path: value.path as string,
      range: value.range,
      text: value.text
    }
  };
}

function isRange(value: unknown): value is TexpressoRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function isPosition(value: unknown): value is { line: number; character: number } {
  return isRecord(value) && Number.isInteger(value.line) && Number(value.line) >= 0 &&
    Number.isInteger(value.character) && Number(value.character) >= 0;
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validatePrivateProjectPath(value: unknown, label: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return `${label} must be a non-empty relative POSIX path.`;
  if (value === "." || value.endsWith("/") || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return `${label} must be a safe relative POSIX path.`;
  }
  if (value.split("/").some((segment) => segment === ".." || segment === "")) return `${label} must not contain traversal or empty segments.`;
  return undefined;
}

function isBase64(value: string): boolean {
  return value.length % 4 !== 1 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}={0,2}|[A-Za-z0-9+/]{3}={0,1})?$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(code: string, message: string, revision?: number): ClientMessageValidation {
  return { ok: false, code, message, ...(revision === undefined ? {} : { revision }) };
}
