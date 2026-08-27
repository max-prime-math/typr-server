import { describe, expect, it } from "vitest";
import { ManagementAuthenticator, validateManagementPassword, validateManagementUsername } from "./managementAuth.ts";

const TEST_SCRYPT = { N: 1_024, r: 8, p: 1, maxmem: 16 * 1024 * 1024 };

describe("management authentication", () => {
  it("creates opaque secure sessions and validates CSRF tokens", async () => {
    let now = 1_000;
    let randomCall = 0;
    const auth = await ManagementAuthenticator.create({
      username: "admin.user",
      password: "correct-horse-battery-staple",
      secureCookies: true,
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, ++randomCall),
      scryptOptions: TEST_SCRYPT
    });

    const result = await auth.login("admin.user", "correct-horse-battery-staple", "client");
    expect(result.ok).toBe(true);
    expect(result.setCookie).toMatch(/^__Host-typr_management=/u);
    expect(result.setCookie).toContain("Secure");
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=Strict");
    expect(result.setCookie).not.toContain("correct-horse");

    const session = auth.session(result.setCookie);
    expect(session).toMatchObject({ username: "admin.user" });
    expect(auth.validCsrf(session!, session!.csrfToken)).toBe(true);
    expect(auth.validCsrf(session!, "wrong")).toBe(false);

    now += 31 * 60_000;
    expect(auth.session(result.setCookie)).toBeUndefined();
  });

  it("uses a local cookie without the Secure attribute for LAN-only HTTP", async () => {
    const auth = await ManagementAuthenticator.create({
      username: "typr",
      password: "correct-horse-battery-staple",
      secureCookies: false,
      scryptOptions: TEST_SCRYPT
    });
    const result = await auth.login("typr", "correct-horse-battery-staple", "client");
    expect(result.setCookie).toMatch(/^typr_management=/u);
    expect(result.setCookie).not.toContain("; Secure");
  });

  it("rate limits repeated invalid credentials without identifying the bad field", async () => {
    let now = 1_000;
    const auth = await ManagementAuthenticator.create({
      username: "typr",
      password: "correct-horse-battery-staple",
      secureCookies: false,
      now: () => now,
      scryptOptions: TEST_SCRYPT
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(auth.login("wrong", "wrong-password", "client")).resolves.toEqual({ ok: false });
    }
    const blocked = await auth.login("wrong", "wrong-password", "client");
    expect(blocked).toMatchObject({ ok: false, retryAfterSeconds: 30 });
    const stillBlocked = await auth.login("wrong", "wrong-password", "client");
    expect(stillBlocked.retryAfterSeconds).toBe(30);
    now += 31_000;
    await expect(auth.login("typr", "correct-horse-battery-staple", "client")).resolves.toMatchObject({ ok: true });
  });

  it("validates usernames and strong bootstrap passwords", () => {
    expect(validateManagementUsername(" admin.user ")).toBe("admin.user");
    expect(() => validateManagementUsername("a")).toThrow(/3-64/u);
    expect(() => validateManagementUsername("admin@example.com")).toThrow(/3-64/u);
    expect(() => validateManagementPassword("short")).toThrow(/24-1024/u);
    expect(() => validateManagementPassword("x".repeat(24))).not.toThrow();
  });
});
