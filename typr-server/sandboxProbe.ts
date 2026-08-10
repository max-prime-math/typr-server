import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Proves the configured launcher can actually enforce its policy before readiness. */
export async function probeNativeSandbox(executable: string): Promise<void> {
  const projectRoot = await mkdtemp(join(tmpdir(), "typr-sandbox-probe-"));
  try {
    await execFileAsync(executable, [projectRoot, "--", "/bin/true"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Native compiler sandbox probe failed; refusing readiness: ${detail}`);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}
