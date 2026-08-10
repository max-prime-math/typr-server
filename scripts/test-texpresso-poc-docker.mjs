import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.TYPR_COMPANION_DOCKER_IMAGE ?? "typr-server:texpresso-poc-test";

if (process.env.TYPR_COMPANION_DOCKER_SKIP_BUILD !== "1") {
  await run("docker", ["build", "--file", "docker/typr-server.Dockerfile", "--tag", image, "."]);
}
await run("docker", [
  "run",
  "--rm",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges:true",
  "--read-only",
  "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=536870912",
  "--pids-limit", "256",
  "--memory", "2g",
  "--cpus", "2",
  "--entrypoint", "node",
  image,
  "--experimental-strip-types",
  "typr-server/texpresso-poc.ts"
]);

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(" ")} exited with status ${code}.`));
    });
  });
}
