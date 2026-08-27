import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions
} from "node:crypto";
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60_000;
const MAX_SESSIONS = 32;
const FAILURE_WINDOW_MS = 15 * 60_000;
const FAILURE_LIMIT = 5;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;
const SECURE_COOKIE_NAME = "__Host-typr_management";
const LOCAL_COOKIE_NAME = "typr_management";

interface PasswordCredential {
  salt: Buffer;
  hash: Buffer;
}

interface StoredSession {
  username: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
}

interface LoginFailureState {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

export interface ManagementSession {
  username: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

export interface ManagementLoginResult {
  ok: boolean;
  retryAfterSeconds?: number;
  session?: ManagementSession;
  setCookie?: string;
}

export interface ManagementAuthenticatorOptions {
  username: string;
  password: string;
  secureCookies: boolean;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  scryptOptions?: ScryptOptions;
}

/** Password login and opaque server-side sessions for the management console. */
export class ManagementAuthenticator {
  readonly username: string;
  readonly secureCookies: boolean;
  private readonly credential: PasswordCredential;
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly scryptOptions: ScryptOptions;
  private readonly sessions = new Map<string, StoredSession>();
  private readonly failures = new Map<string, LoginFailureState>();

  private constructor(options: ManagementAuthenticatorOptions, credential: PasswordCredential) {
    this.username = validateManagementUsername(options.username);
    this.secureCookies = options.secureCookies;
    this.credential = credential;
    this.idleTimeoutMs = positiveDuration(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, "idle timeout");
    this.absoluteTimeoutMs = positiveDuration(options.absoluteTimeoutMs, DEFAULT_ABSOLUTE_TIMEOUT_MS, "absolute timeout");
    if (this.absoluteTimeoutMs < this.idleTimeoutMs) {
      throw new Error("Management absolute session timeout must not be shorter than the idle timeout.");
    }
    this.now = options.now ?? Date.now;
    this.random = options.randomBytes ?? randomBytes;
    this.scryptOptions = options.scryptOptions ?? { N: 131_072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
  }

  static async create(options: ManagementAuthenticatorOptions): Promise<ManagementAuthenticator> {
    validateManagementPassword(options.password);
    const salt = (options.randomBytes ?? randomBytes)(16);
    const scryptOptions = options.scryptOptions ?? { N: 131_072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
    const hash = await derivePassword(options.password, salt, scryptOptions);
    return new ManagementAuthenticator(options, { salt, hash });
  }

  async login(username: string, password: string, clientKey: string): Promise<ManagementLoginResult> {
    const now = this.now();
    const failureKey = hashValue(`${clientKey}\u0000${username.toLocaleLowerCase()}`);
    const currentFailure = this.failures.get(failureKey);
    if (currentFailure && currentFailure.blockedUntil > now) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((currentFailure.blockedUntil - now) / 1_000)) };
    }

    const suppliedHash = await derivePassword(password, this.credential.salt, this.scryptOptions);
    const usernameMatches = constantTimeTextEqual(username, this.username);
    const passwordMatches = suppliedHash.byteLength === this.credential.hash.byteLength &&
      timingSafeEqual(suppliedHash, this.credential.hash);
    if (!usernameMatches || !passwordMatches) {
      const state = currentFailure && now - currentFailure.firstAt <= FAILURE_WINDOW_MS
        ? currentFailure
        : { count: 0, firstAt: now, blockedUntil: 0 };
      state.count += 1;
      state.blockedUntil = state.count >= FAILURE_LIMIT
        ? now + Math.min(MAX_LOCKOUT_MS, BASE_LOCKOUT_MS * (2 ** Math.min(5, state.count - FAILURE_LIMIT)))
        : 0;
      this.failures.set(failureKey, state);
      return {
        ok: false,
        ...(state.blockedUntil > now
          ? { retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - now) / 1_000)) }
          : {})
      };
    }

    this.failures.delete(failureKey);
    this.prune(now);
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (typeof oldest !== "string") break;
      this.sessions.delete(oldest);
    }
    const token = this.random(32).toString("base64url");
    const csrfToken = this.random(32).toString("base64url");
    const stored: StoredSession = { username: this.username, csrfToken, createdAt: now, lastSeenAt: now };
    this.sessions.set(hashValue(token), stored);
    return {
      ok: true,
      session: this.publicSession(stored),
      setCookie: this.serializeCookie(token)
    };
  }

  session(cookieHeader: string | undefined): ManagementSession | undefined {
    const token = readCookie(cookieHeader, this.cookieName());
    if (!token) return undefined;
    const key = hashValue(token);
    const stored = this.sessions.get(key);
    if (!stored) return undefined;
    const now = this.now();
    if (now - stored.lastSeenAt > this.idleTimeoutMs || now - stored.createdAt > this.absoluteTimeoutMs) {
      this.sessions.delete(key);
      return undefined;
    }
    stored.lastSeenAt = now;
    return this.publicSession(stored);
  }

  logout(cookieHeader: string | undefined): string {
    const token = readCookie(cookieHeader, this.cookieName());
    if (token) this.sessions.delete(hashValue(token));
    return `${this.cookieName()}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${this.secureCookies ? "; Secure" : ""}`;
  }

  validCsrf(session: ManagementSession, supplied: string | undefined): boolean {
    return typeof supplied === "string" && constantTimeTextEqual(supplied, session.csrfToken);
  }

  private publicSession(stored: StoredSession): ManagementSession {
    return {
      username: stored.username,
      csrfToken: stored.csrfToken,
      createdAt: stored.createdAt,
      expiresAt: Math.min(stored.createdAt + this.absoluteTimeoutMs, stored.lastSeenAt + this.idleTimeoutMs)
    };
  }

  private cookieName(): string {
    return this.secureCookies ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME;
  }

  private serializeCookie(token: string): string {
    const maxAge = Math.floor(this.idleTimeoutMs / 1_000);
    return `${this.cookieName()}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${this.secureCookies ? "; Secure" : ""}`;
  }

  private prune(now: number): void {
    for (const [key, session] of this.sessions) {
      if (now - session.lastSeenAt > this.idleTimeoutMs || now - session.createdAt > this.absoluteTimeoutMs) {
        this.sessions.delete(key);
      }
    }
    for (const [key, failure] of this.failures) {
      if (failure.blockedUntil <= now && now - failure.firstAt > FAILURE_WINDOW_MS) this.failures.delete(key);
    }
  }
}

export function validateManagementUsername(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(normalized)) {
    throw new Error("Management username must contain 3-64 letters, numbers, dots, underscores, or hyphens.");
  }
  return normalized;
}

export function validateManagementPassword(value: string): void {
  if (value.length < 24 || value.length > 1_024 || /[\u0000\r\n]/u.test(value)) {
    throw new Error("Management password must contain 24-1024 characters without NUL or line breaks.");
  }
}

async function derivePassword(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 32, options, (error, key) => {
      if (error) reject(error);
      else resolve(Buffer.from(key));
    });
  });
}

function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftHash = Buffer.from(hashValue(left), "hex");
  const rightHash = Buffer.from(hashValue(right), "hex");
  return timingSafeEqual(leftHash, rightHash);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 8_192) return undefined;
  for (const field of header.split(";")) {
    const separator = field.indexOf("=");
    if (separator < 0 || field.slice(0, separator).trim() !== name) continue;
    const value = field.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined;
  }
  return undefined;
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`Management ${name} must be a positive duration.`);
  return resolved;
}
