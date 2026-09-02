import { describe, expect, it, vi } from "vitest";
import {
  parseUnsandboxedStatelessOptIn,
  parseUnsandboxedWorkspaceOptIn,
  resolveNativeSandbox,
  validateStatelessFallbackMountInfo,
  validateTrustedWorkspaceFallbackMountInfo
} from "./sandboxPolicy.ts";

const succeeds = async () => undefined;
const fails = async () => { throw new Error("Landlock unavailable"); };

describe("native sandbox startup policy", () => {
  it("keeps the verified launcher when its probe succeeds", async () => {
    await expect(resolveNativeSandbox({
      allowUnsandboxedStateless: false,
      allowUnsandboxedWorkspace: false,
      platform: "linux",
      sandboxExecutable: "/sandbox",
      accessExecutable: succeeds,
      probeSandbox: succeeds
    })).resolves.toBe("/sandbox");
  });

  it("fails closed by default when the launcher probe fails", async () => {
    await expect(resolveNativeSandbox({
      allowUnsandboxedStateless: false,
      allowUnsandboxedWorkspace: false,
      platform: "linux",
      sandboxExecutable: "/sandbox",
      accessExecutable: succeeds,
      probeSandbox: fails
    })).rejects.toThrow(/Landlock unavailable/u);
  });

  it("permits only an explicit volume-free stateless fallback", async () => {
    const onFallback = vi.fn();
    await expect(resolveNativeSandbox({
      allowUnsandboxedStateless: true,
      allowUnsandboxedWorkspace: false,
      platform: "linux",
      sandboxExecutable: "/sandbox",
      accessExecutable: succeeds,
      probeSandbox: fails,
      assertVolumeFree: succeeds,
      onFallback
    })).resolves.toBeUndefined();
    expect(onFallback).toHaveBeenCalledWith(expect.stringMatching(/trusted documents only/u));
  });

  it("audits mounts when the explicit fallback has no configured launcher", async () => {
    const assertVolumeFree = vi.fn(succeeds);
    const onFallback = vi.fn();
    await expect(resolveNativeSandbox({
      allowUnsandboxedStateless: true,
      allowUnsandboxedWorkspace: false,
      platform: "linux",
      assertVolumeFree,
      onFallback
    })).resolves.toBeUndefined();
    expect(assertVolumeFree).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith(expect.stringMatching(/not configured/u));
  });

  it("still refuses a mapped workspace when fallback is enabled", async () => {
    await expect(resolveNativeSandbox({
      allowUnsandboxedStateless: true,
      allowUnsandboxedWorkspace: false,
      platform: "linux",
      sandboxExecutable: "/sandbox",
      workspaceRoot: "/workspace",
      accessExecutable: succeeds,
      probeSandbox: fails,
      assertVolumeFree: succeeds
    })).rejects.toThrow(/Landlock unavailable/u);
  });

  it("still refuses a mapped workspace without a launcher", async () => {
    await expect(resolveNativeSandbox({
      allowUnsandboxedStateless: true,
      allowUnsandboxedWorkspace: false,
      platform: "linux",
      workspaceRoot: "/workspace"
    })).rejects.toThrow(/mapped workspace requires/u);
  });

  it("permits an explicitly trusted mapped workspace when the launcher probe fails", async () => {
    const assertWorkspaceScoped = vi.fn(succeeds);
    const onFallback = vi.fn();
    await expect(resolveNativeSandbox({
      allowUnsandboxedStateless: false,
      allowUnsandboxedWorkspace: true,
      platform: "linux",
      sandboxExecutable: "/sandbox",
      workspaceRoot: "/workspace",
      accessExecutable: succeeds,
      probeSandbox: fails,
      assertWorkspaceScoped,
      onFallback
    })).resolves.toBeUndefined();
    expect(assertWorkspaceScoped).toHaveBeenCalledWith("/workspace");
    expect(onFallback).toHaveBeenCalledWith(expect.stringMatching(/compiler processes may access/u));
  });

  it("audits an explicitly trusted workspace when no launcher is configured", async () => {
    const assertWorkspaceScoped = vi.fn(succeeds);
    await expect(resolveNativeSandbox({
      allowUnsandboxedStateless: false,
      allowUnsandboxedWorkspace: true,
      platform: "linux",
      workspaceRoot: "/workspace",
      assertWorkspaceScoped
    })).resolves.toBeUndefined();
    expect(assertWorkspaceScoped).toHaveBeenCalledWith("/workspace");
  });

  it("starts per-user Windows mode without Landlock or administrator setup", async () => {
    const onFallback = vi.fn();
    await expect(resolveNativeSandbox({
      allowUnsandboxedStateless: false,
      allowUnsandboxedWorkspace: false,
      workspaceRoot: "C:\\Users\\person\\Typr",
      platform: "win32",
      onFallback
    })).resolves.toBeUndefined();
    expect(onFallback).toHaveBeenCalledWith(expect.stringMatching(/Windows portable mode/u));
  });
});

describe("stateless fallback mount policy", () => {
  const standardMounts = [
    "29 1 0:25 / / rw,relatime - overlay overlay rw",
    "30 29 0:27 / /proc rw,nosuid,nodev,noexec - proc proc rw",
    "31 29 0:28 / /dev rw,nosuid - tmpfs tmpfs rw",
    "32 31 0:29 / /dev/pts rw,nosuid,noexec - devpts devpts rw",
    "33 29 0:30 / /sys ro,nosuid,nodev,noexec - sysfs sysfs ro",
    "34 29 0:31 / /tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw",
    "35 29 8:1 /docker/hosts /etc/hosts rw,relatime - xfs /dev/sda1 rw"
  ].join("\n");

  it("accepts only standard container infrastructure mounts", () => {
    expect(() => validateStatelessFallbackMountInfo(standardMounts)).not.toThrow();
  });

  it("rejects a workspace mount even when the API root is unset", () => {
    expect(() => validateStatelessFallbackMountInfo(
      `${standardMounts}\n36 29 8:1 /share/project /workspace rw,relatime - xfs /dev/sda1 rw`
    )).toThrow('unexpected mount "/workspace"');
  });

  it("rejects arbitrary data and secret mounts", () => {
    expect(() => validateStatelessFallbackMountInfo(
      `${standardMounts}\n36 29 8:1 /share/data /data rw,relatime - xfs /dev/sda1 rw`
    )).toThrow('unexpected mount "/data"');
    expect(() => validateStatelessFallbackMountInfo(
      `${standardMounts}\n36 29 0:40 / /run/secrets ro,relatime - tmpfs tmpfs ro`
    )).toThrow('unexpected mount "/run/secrets"');
  });

  it("allows one exact dedicated TeX package cache mount", () => {
    expect(() => validateStatelessFallbackMountInfo(
      `${standardMounts}\n41 25 0:40 / /var/lib/typr-texlive rw - ext4 /dev/sda1 rw`,
      "/var/lib/typr-texlive"
    )).not.toThrow();
  });

  it("rejects a host bind disguised as the scratch directory", () => {
    expect(() => validateStatelessFallbackMountInfo(
      `${standardMounts.replace("34 29 0:31 / /tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw", "")}\n` +
      "36 29 8:1 /host/tmp /tmp rw,relatime - xfs /dev/sda1 rw"
    )).toThrow('unexpected mount "/tmp"');
  });
});

describe("trusted workspace fallback mount policy", () => {
  const standardMounts = [
    "29 1 0:25 / / rw,relatime - overlay overlay rw",
    "30 29 0:27 / /proc rw,nosuid,nodev,noexec - proc proc rw",
    "31 29 0:28 / /dev rw,nosuid - tmpfs tmpfs rw",
    "32 31 0:29 / /dev/pts rw,nosuid,noexec - devpts devpts rw",
    "33 29 0:30 / /sys ro,nosuid,nodev,noexec - sysfs sysfs ro",
    "34 29 0:31 / /tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw",
    "35 29 8:1 /docker/hosts /etc/hosts rw,relatime - xfs /dev/sda1 rw"
  ].join("\n");

  it("accepts one exact dedicated workspace mount", () => {
    expect(() => validateTrustedWorkspaceFallbackMountInfo(
      `${standardMounts}\n36 29 8:1 /home/person/typr-workspace /workspace rw,relatime - xfs /dev/sda1 rw`,
      "/workspace"
    )).not.toThrow();
  });

  it("requires the configured workspace to be a real mount", () => {
    expect(() => validateTrustedWorkspaceFallbackMountInfo(standardMounts, "/workspace"))
      .toThrow(/dedicated mount/u);
  });

  it("rejects every additional host mount", () => {
    expect(() => validateTrustedWorkspaceFallbackMountInfo(
      `${standardMounts}\n` +
      "36 29 8:1 /home/person/typr-workspace /workspace rw,relatime - xfs /dev/sda1 rw\n" +
      "37 29 8:1 /home/person/secrets /secrets ro,relatime - xfs /dev/sda1 rw",
      "/workspace"
    )).toThrow('unexpected mount "/secrets"');
  });
});

describe("unsandboxed stateless opt-in parsing", () => {
  it("accepts only the exact explicit value", () => {
    expect(parseUnsandboxedStatelessOptIn(undefined)).toBe(false);
    expect(parseUnsandboxedStatelessOptIn(" ")).toBe(false);
    expect(parseUnsandboxedStatelessOptIn("1")).toBe(true);
    expect(() => parseUnsandboxedStatelessOptIn("true")).toThrow(/unset or exactly 1/u);
    expect(() => parseUnsandboxedStatelessOptIn("0")).toThrow(/unset or exactly 1/u);
  });
});

describe("unsandboxed workspace opt-in parsing", () => {
  it("accepts only the exact explicit value", () => {
    expect(parseUnsandboxedWorkspaceOptIn(undefined)).toBe(false);
    expect(parseUnsandboxedWorkspaceOptIn(" ")).toBe(false);
    expect(parseUnsandboxedWorkspaceOptIn("1")).toBe(true);
    expect(() => parseUnsandboxedWorkspaceOptIn("true")).toThrow(/unset or exactly 1/u);
    expect(() => parseUnsandboxedWorkspaceOptIn("0")).toThrow(/unset or exactly 1/u);
  });
});
