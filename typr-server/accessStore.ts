import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ManagedUser {
  id: string;
  name: string;
  disabled: boolean;
  createdAt: string;
}

export interface ManagedApiKey {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface StoredApiKey extends ManagedApiKey {
  hash: string;
}

interface AccessState {
  version: 1;
  requireApiKeys: boolean;
  users: ManagedUser[];
  keys: StoredApiKey[];
}

export interface AccessSnapshot {
  persistent: boolean;
  requireApiKeys: boolean;
  users: ManagedUser[];
  keys: ManagedApiKey[];
}

export interface ApiPrincipal {
  userId: string;
  userName: string;
  keyId: string;
}

export type AuthorizationResult =
  | { ok: true; principal?: ApiPrincipal }
  | { ok: false; message: string };

const API_KEY_PREFIX = "typr_";

/** Local user and API-key state. Raw API keys are returned once and never persisted. */
export class AccessStore {
  private state: AccessState;
  private readonly statePath?: string;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(state: AccessState, statePath?: string) {
    this.state = state;
    this.statePath = statePath;
  }

  static async open(statePath?: string): Promise<AccessStore> {
    if (!statePath) return new AccessStore(emptyState());
    try {
      const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
      return new AccessStore(validateState(parsed), statePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return new AccessStore(emptyState(), statePath);
      throw error;
    }
  }

  snapshot(): AccessSnapshot {
    return {
      persistent: Boolean(this.statePath),
      requireApiKeys: this.state.requireApiKeys,
      users: this.state.users.map((user) => ({ ...user })),
      keys: this.state.keys.map(({ hash: _hash, ...key }) => ({ ...key }))
    };
  }

  async createUser(name: string): Promise<ManagedUser> {
    const normalized = normalizeLabel(name, "User name", 80);
    if (this.state.users.some((user) => user.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
      throw new AccessStoreError(409, "user-name-conflict", "A user with that name already exists.");
    }
    const user: ManagedUser = {
      id: randomUUID(),
      name: normalized,
      disabled: false,
      createdAt: new Date().toISOString()
    };
    this.state.users.push(user);
    await this.persist();
    return { ...user };
  }

  async setUserDisabled(userId: string, disabled: boolean): Promise<ManagedUser> {
    const user = this.requireUser(userId);
    user.disabled = disabled;
    await this.persist();
    return { ...user };
  }

  async createApiKey(userId: string, label: string): Promise<{ key: ManagedApiKey; secret: string }> {
    const user = this.requireUser(userId);
    if (user.disabled) throw new AccessStoreError(409, "user-disabled", "Enable this user before creating an API key.");
    const normalized = normalizeLabel(label, "API key label", 80);
    const secret = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const key: StoredApiKey = {
      id: randomUUID(),
      userId,
      label: normalized,
      prefix: secret.slice(0, 13),
      hash: hashSecret(secret),
      createdAt: new Date().toISOString()
    };
    this.state.keys.push(key);
    await this.persist();
    const { hash: _hash, ...publicKey } = key;
    return { key: { ...publicKey }, secret };
  }

  async revokeApiKey(keyId: string): Promise<ManagedApiKey> {
    const key = this.state.keys.find((candidate) => candidate.id === keyId);
    if (!key) throw new AccessStoreError(404, "api-key-not-found", "API key was not found.");
    key.revokedAt ??= new Date().toISOString();
    await this.persist();
    const { hash: _hash, ...publicKey } = key;
    return { ...publicKey };
  }

  async setRequireApiKeys(requireApiKeys: boolean): Promise<void> {
    if (requireApiKeys && !this.hasUsableKey()) {
      throw new AccessStoreError(
        409,
        "usable-api-key-required",
        "Create an API key for an enabled user before requiring authentication."
      );
    }
    this.state.requireApiKeys = requireApiKeys;
    await this.persist();
  }

  async authorize(authorization: string | undefined): Promise<AuthorizationResult> {
    if (!authorization) {
      return this.state.requireApiKeys
        ? { ok: false, message: "A Typr Companion API key is required." }
        : { ok: true };
    }
    const match = authorization.match(/^Bearer\s+(typr_[A-Za-z0-9_-]+)$/u);
    if (!match) return { ok: false, message: "Authorization must use a Typr Bearer API key." };
    const secretHash = Buffer.from(hashSecret(match[1]), "hex");
    for (const key of this.state.keys) {
      const storedHash = Buffer.from(key.hash, "hex");
      if (storedHash.byteLength !== secretHash.byteLength || !timingSafeEqual(storedHash, secretHash)) continue;
      const user = this.state.users.find((candidate) => candidate.id === key.userId);
      if (!user || user.disabled || key.revokedAt) {
        return { ok: false, message: "This Typr Companion API key is disabled or revoked." };
      }
      const now = new Date().toISOString();
      if (!key.lastUsedAt || Date.now() - Date.parse(key.lastUsedAt) >= 60_000) {
        key.lastUsedAt = now;
        await this.persist();
      }
      return { ok: true, principal: { userId: user.id, userName: user.name, keyId: key.id } };
    }
    return { ok: false, message: "The Typr Companion API key is invalid." };
  }

  private requireUser(userId: string): ManagedUser {
    const user = this.state.users.find((candidate) => candidate.id === userId);
    if (!user) throw new AccessStoreError(404, "user-not-found", "User was not found.");
    return user;
  }

  private hasUsableKey(): boolean {
    return this.state.keys.some((key) => !key.revokedAt &&
      this.state.users.some((user) => user.id === key.userId && !user.disabled));
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    const serialized = `${JSON.stringify(this.state, null, 2)}\n`;
    const temporary = `${this.statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.statePath!), { recursive: true, mode: 0o700 });
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.statePath!);
    });
    await this.writeQueue;
  }
}

export class AccessStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AccessStoreError";
    this.status = status;
    this.code = code;
  }
}

function emptyState(): AccessState {
  return { version: 1, requireApiKeys: false, users: [], keys: [] };
}

function validateState(value: unknown): AccessState {
  if (!isRecord(value) || value.version !== 1 || typeof value.requireApiKeys !== "boolean" ||
    !Array.isArray(value.users) || !Array.isArray(value.keys)) {
    throw new Error("Typr Companion management state is invalid.");
  }
  const users = value.users.map((user) => {
    if (!isRecord(user) || typeof user.id !== "string" || typeof user.name !== "string" ||
      typeof user.disabled !== "boolean" || typeof user.createdAt !== "string") {
      throw new Error("Typr Companion management user state is invalid.");
    }
    return { id: user.id, name: user.name, disabled: user.disabled, createdAt: user.createdAt };
  });
  const keys = value.keys.map((key) => {
    if (!isRecord(key) || typeof key.id !== "string" || typeof key.userId !== "string" ||
      typeof key.label !== "string" || typeof key.prefix !== "string" || typeof key.hash !== "string" ||
      typeof key.createdAt !== "string" || (key.lastUsedAt !== undefined && typeof key.lastUsedAt !== "string") ||
      (key.revokedAt !== undefined && typeof key.revokedAt !== "string")) {
      throw new Error("Typr Companion management API-key state is invalid.");
    }
    return {
      id: key.id,
      userId: key.userId,
      label: key.label,
      prefix: key.prefix,
      hash: key.hash,
      createdAt: key.createdAt,
      ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt } : {}),
      ...(key.revokedAt ? { revokedAt: key.revokedAt } : {})
    };
  });
  return { version: 1, requireApiKeys: value.requireApiKeys, users, keys };
}

function normalizeLabel(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new AccessStoreError(400, "invalid-label", `${field} must contain 1-${maxLength} printable characters.`);
  }
  return normalized;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
