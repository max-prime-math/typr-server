#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const image = process.env.TYPR_COMPANION_IMAGE || "typr-server:stage3";
const configOnly = process.argv.includes("--config-only");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    env: { ...process.env, ...options.env }
  });
  if (result.error?.code === "ETIMEDOUT") throw new Error(`${command} ${args.join(" ")} timed out.`);
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function files(workspace = false) {
  return workspace
    ? ["-f", "compose.yaml", "-f", "compose.workspace.yaml"]
    : ["-f", "compose.yaml"];
}

function config({ workspace = false, workspaceDir = "/tmp/typr-companion-workspace-contract" } = {}) {
  const result = run("docker", ["compose", ...files(workspace), "config", "--format", "json"], {
    env: {
      TYPR_COMPANION_IMAGE: image,
      TYPR_COMPANION_WORKSPACE_DIR: workspaceDir
    }
  });
  return JSON.parse(result.stdout);
}

function assertBaseConfig(parsed) {
  const service = parsed.services["typr-server"];
  assert.equal(service.image, image);
  assert.equal(service.build, undefined);
  assert.equal(service.user, "1000:1000");
  assert.equal(service.read_only, true);
  assert.deepEqual(service.cap_drop, ["ALL"]);
  assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
  assert.ok(service.tmpfs.includes("/tmp:rw,nosuid,nodev,noexec,size=536870912"));
  assert.equal(service.pids_limit, 256);
  assert.equal(service.mem_limit, "2147483648");
  assert.equal(service.memswap_limit, "2147483648");
  assert.equal(service.cpus, 2);
  assert.equal(service.stop_grace_period, "15s");
  assert.deepEqual(service.ports, [{
    mode: "ingress",
    host_ip: "127.0.0.1",
    target: 8484,
    published: "8484",
    protocol: "tcp"
  }]);
}

const statelessConfig = config();
assertBaseConfig(statelessConfig);
assert.equal(statelessConfig.services["typr-server"].volumes, undefined);
assert.equal(statelessConfig.services["typr-server"].environment.TYPR_COMPANION_WORKSPACE_ROOT, undefined);

const workspaceConfig = config({ workspace: true });
assertBaseConfig(workspaceConfig);
assert.equal(workspaceConfig.services["typr-server"].environment.TYPR_COMPANION_WORKSPACE_ROOT, "/workspace");
assert.equal(workspaceConfig.services["typr-server"].environment.TYPR_COMPANION_WORKSPACE_ID, "home-workspace");
const [workspaceMount] = workspaceConfig.services["typr-server"].volumes;
assert.equal(workspaceMount.type, "bind");
assert.equal(workspaceMount.source, "/tmp/typr-companion-workspace-contract");
assert.equal(workspaceMount.target, "/workspace");
if (Object.hasOwn(workspaceMount.bind, "create_host_path")) {
  assert.equal(workspaceMount.bind.create_host_path, false);
}
assert.match(
  await readFile(path.join(projectRoot, "compose.workspace.yaml"), "utf8"),
  /create_host_path:\s*false/,
  "workspace override must explicitly disable host-path creation"
);

const missingWorkspace = run("docker", ["compose", ...files(true), "config", "--quiet"], {
  allowFailure: true,
  env: { TYPR_COMPANION_WORKSPACE_DIR: "" }
});
assert.notEqual(missingWorkspace.status, 0, "workspace Compose must reject an unset host directory");

if (configOnly) {
  console.log("Typr Companion Compose configuration validation passed.");
  process.exit(0);
}

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "typr-companion-compose-"));
// CI runners are not guaranteed to use the container's UID 1000. This directory
// is an isolated throwaway fixture, so make only that fixture traversable/writable.
await chmod(workspaceDir, 0o777);

async function assertMissingHostPathFailsClosed() {
  const missingDir = path.join(os.tmpdir(), `typr-companion-missing-${process.pid}-${Date.now()}`);
  const projectName = `companion-compose-missing-${process.pid}-${Date.now()}`.toLowerCase();
  const baseArgs = ["compose", "--project-name", projectName, ...files(true)];
  const env = {
    TYPR_COMPANION_IMAGE: image,
    TYPR_COMPANION_PORT: "0",
    TYPR_COMPANION_WORKSPACE_DIR: missingDir
  };
  let created = false;
  try {
    const result = run("docker", [...baseArgs, "up", "-d", "--no-build", "--pull", "never"], {
      allowFailure: true,
      env,
      timeout: 60_000
    });
    assert.notEqual(result.status, 0, "Compose unexpectedly accepted a missing workspace host path");
    try {
      await lstat(missingDir);
      created = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } finally {
    run("docker", [...baseArgs, "down", "--remove-orphans", "--volumes", "--timeout", "15"], {
      allowFailure: true,
      env,
      timeout: 60_000
    });
    await rm(missingDir, { recursive: true, force: true });
  }
  assert.equal(created, false, "Compose created the missing workspace host path");
}

function assertRuntime(containerId, { workspace }) {
  const inspected = JSON.parse(run("docker", ["inspect", containerId]).stdout)[0];
  assert.equal(inspected.Config.User, "1000:1000");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspected.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(inspected.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
  assert.equal(inspected.HostConfig.PidsLimit, 256);
  assert.equal(inspected.HostConfig.Memory, 2 * 1024 * 1024 * 1024);
  assert.equal(inspected.HostConfig.MemorySwap, 2 * 1024 * 1024 * 1024);
  assert.equal(inspected.HostConfig.NanoCpus, 2_000_000_000);
  assert.equal(inspected.NetworkSettings.Ports["8484/tcp"][0].HostIp, "127.0.0.1");
  const mount = inspected.Mounts.find((candidate) => candidate.Destination === "/workspace");
  if (workspace) {
    assert.ok(mount);
    assert.equal(mount.RW, true);
    assert.equal(path.resolve(mount.Source), path.resolve(workspaceDir));
  } else {
    assert.equal(mount, undefined);
  }
}

function smoke({ label, workspace = false }) {
  const projectName = `companion-compose-${label}-${process.pid}-${Date.now()}`.toLowerCase();
  const composeFiles = files(workspace);
  const env = {
    TYPR_COMPANION_IMAGE: image,
    TYPR_COMPANION_PORT: "0",
    TYPR_COMPANION_ALLOWED_ORIGINS: "https://typr.example"
  };
  if (workspace) {
    env.TYPR_COMPANION_WORKSPACE_DIR = workspaceDir;
    env.TYPR_COMPANION_WORKSPACE_ID = "compose-workspace";
  }
  const baseArgs = ["compose", "--project-name", projectName, ...composeFiles];
  try {
    run("docker", [...baseArgs, "up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120"], {
      env,
      timeout: 180_000
    });
    const containerId = run("docker", [...baseArgs, "ps", "-q", "typr-server"], { env }).stdout.trim();
    assert.ok(containerId);
    assertRuntime(containerId, { workspace });
    const statusResult = JSON.parse(run("docker", [...baseArgs, "exec", "-T", "typr-server", "node", "-e",
      "fetch('http://127.0.0.1:8484/api/v1/status',{headers:{Origin:'https://typr.example'}}).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(JSON.stringify({body:await r.json(),acao:r.headers.get('access-control-allow-origin'),vary:r.headers.get('vary')}))})"
    ], { env }).stdout);
    assert.equal(statusResult.body.protocolVersion, 1);
    assert.equal(statusResult.body.capabilities.filesystem.projectStorage, workspace);
    assert.equal(statusResult.acao, "https://typr.example");
    assert.equal(statusResult.vary, "Origin, Access-Control-Request-Private-Network");
    if (workspace) {
      assert.equal(statusResult.body.capabilities.filesystem.workspaceId, "compose-workspace");
      const rejectedOrigin = run("docker", [...baseArgs, "exec", "-T", "typr-server", "node", "-e",
        "fetch('http://127.0.0.1:8484/api/v1/workspace/file?path=compose.txt',{method:'OPTIONS',headers:{Origin:'https://attacker.example','Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'content-type, if-none-match, x-typr-workspace-mutation'}}).then(r=>process.stdout.write(String(r.status)))"
      ], { env }).stdout.trim();
      assert.equal(rejectedOrigin, "403");
      const writeScript = [
        "const body=JSON.stringify({encoding:'base64',content:Buffer.from('compose smoke\\n').toString('base64')})",
        "fetch('http://127.0.0.1:8484/api/v1/workspace/file?path=compose.txt',{method:'PUT',headers:{'Content-Type':'application/json','If-None-Match':'*','X-Typr-Workspace-Mutation':'1'},body}).then(async r=>{if(!r.ok){console.error(await r.text());process.exit(1)}})"
      ].join(";");
      run("docker", [...baseArgs, "exec", "-T", "typr-server", "node", "-e", writeScript], { env });
    }
  } finally {
    run("docker", [...baseArgs, "down", "--remove-orphans", "--volumes", "--timeout", "15"], {
      allowFailure: true,
      env,
      timeout: 60_000
    });
  }
}

try {
  await assertMissingHostPathFailsClosed();
  smoke({ label: "stateless" });
  smoke({ label: "workspace", workspace: true });
  assert.equal(await readFile(path.join(workspaceDir, "compose.txt"), "utf8"), "compose smoke\n");
} finally {
  await rm(workspaceDir, { recursive: true, force: true });
}

console.log("Typr Companion Compose validation passed for stateless and mapped-workspace modes.");
