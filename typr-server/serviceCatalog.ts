import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ManagedServiceDescriptor } from "./managementServer.ts";
import { nativeTool } from "./nativeTools.ts";

const execFileAsync = promisify(execFile);

export interface CompanionRuntimeSnapshot {
  serverVersion: string;
  activeRequests: number;
  activeCompilations: number;
  activeLiveSessions: number;
  workspace?: { id: string; writable: boolean };
}

interface CommandProbe {
  available: boolean;
  executable: string;
  version?: string;
  source: "embedded" | "configured" | "path" | "not-found";
}

/** Discovers host providers and combines them with the services the Companion actually advertises. */
export class ServiceCatalog {
  private readonly getRuntime: () => CompanionRuntimeSnapshot;
  private probes: Promise<Map<string, CommandProbe>> | undefined;

  constructor(getRuntime: () => CompanionRuntimeSnapshot) {
    this.getRuntime = getRuntime;
  }

  async snapshot(forceRefresh = false): Promise<ManagedServiceDescriptor[]> {
    if (forceRefresh) this.probes = undefined;
    this.probes ??= this.probeProviders();
    const probes = await this.probes;
    const runtime = this.getRuntime();
    const pdflatex = probes.get("pdflatex")!;
    const latexmk = probes.get("latexmk")!;
    const compilerActive = runtime.activeCompilations;
    const liveActive = runtime.activeLiveSessions;
    return [
      {
        id: "companion-api",
        name: "Companion API",
        kind: "api",
        status: runtime.activeRequests > 0 ? "busy" : "ready",
        advertised: true,
        active: runtime.activeRequests,
        description: `Protocol service ${runtime.serverVersion} on the dedicated service port.`,
        capabilities: ["status", "compile", "workspace", "live-preview"]
      },
      {
        id: "latex",
        name: "LaTeX compiler",
        kind: "compiler",
        status: !pdflatex.available ? "unavailable" : compilerActive > 0 ? "busy" : "ready",
        advertised: pdflatex.available,
        active: compilerActive,
        description: pdflatex.available
          ? `Native PDF builds${latexmk.available ? " with latexmk orchestration" : " using direct pdflatex passes"}.`
          : "No usable pdflatex provider was detected.",
        capabilities: pdflatex.available ? ["pdflatex", ...(latexmk.available ? ["latexmk"] : [])] : [],
        provider: publicProbe(pdflatex)
      },
      {
        id: "live-preview",
        name: "Live preview",
        kind: "live-preview",
        status: !pdflatex.available ? "degraded" : liveActive > 0 ? "busy" : "ready",
        advertised: pdflatex.available,
        active: liveActive,
        description: "WebSocket document revisions rendered to local PNG pages.",
        capabilities: ["incremental-revisions", "png-pages", "full-build-fallback"]
      },
      {
        id: "workspace",
        name: "Workspace storage",
        kind: "workspace",
        status: runtime.workspace ? "ready" : "unavailable",
        advertised: Boolean(runtime.workspace),
        active: 0,
        description: runtime.workspace ? `Writable workspace ${runtime.workspace.id}.` : "No mapped or per-user workspace is configured.",
        capabilities: runtime.workspace ? ["list", "read", "conditional-write", "delete"] : []
      },
      lspDescriptor("texlab", "TexLab", "latex", probes.get("texlab")!),
      lspDescriptor("tinymist", "Tinymist", "typst", probes.get("tinymist")!)
    ];
  }

  private async probeProviders(): Promise<Map<string, CommandProbe>> {
    const definitions = [
      ["pdflatex", nativeTool("pdflatex"), ["--version"]],
      ["latexmk", nativeTool("latexmk"), ["-v"]],
      ["texlab", process.env.TYPR_COMPANION_TEXLAB_EXECUTABLE?.trim() || "texlab", ["--version"]],
      ["tinymist", process.env.TYPR_COMPANION_TINYMIST_EXECUTABLE?.trim() || "tinymist", ["--version"]]
    ] as const;
    const results = await Promise.all(definitions.map(async ([id, executable, args]) => [id, await probeCommand(executable, [...args], providerSource(id, executable))] as const));
    return new Map(results);
  }
}

function lspDescriptor(id: string, name: string, language: string, probe: CommandProbe): ManagedServiceDescriptor {
  return {
    id: `lsp-${id}`,
    name,
    kind: "lsp",
    status: probe.available ? "detected" : "unavailable",
    advertised: false,
    active: 0,
    description: probe.available
      ? `${name} is installed; Companion LSP routing can be enabled in a future provider profile.`
      : `${name} was not found on the configured path.`,
    capabilities: probe.available ? [language, "provider-detected"] : [],
    provider: publicProbe(probe)
  };
}

async function probeCommand(
  executable: string,
  args: string[],
  source: CommandProbe["source"]
): Promise<CommandProbe> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      windowsHide: true,
      timeout: 4_000,
      maxBuffer: 32 * 1024,
      env: process.env.TYPR_COMPANION_NATIVE_PATH
        ? { ...process.env, PATH: process.env.TYPR_COMPANION_NATIVE_PATH }
        : process.env
    });
    const version = `${stdout}\n${stderr}`.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
    return { available: true, executable, ...(version ? { version } : {}), source };
  } catch {
    return { available: false, executable, source: "not-found" };
  }
}

function providerSource(id: string, executable: string): CommandProbe["source"] {
  const configured = id === "pdflatex"
    ? process.env.TYPR_COMPANION_PDFLATEX_EXECUTABLE
    : id === "latexmk"
      ? process.env.TYPR_COMPANION_LATEXMK_EXECUTABLE
      : id === "texlab"
        ? process.env.TYPR_COMPANION_TEXLAB_EXECUTABLE
        : process.env.TYPR_COMPANION_TINYMIST_EXECUTABLE;
  if (configured?.trim()) {
    return process.platform === "win32" && executable.toLowerCase().includes("typr companion") ? "embedded" : "configured";
  }
  return "path";
}

function publicProbe(probe: CommandProbe): ManagedServiceDescriptor["provider"] {
  return {
    executable: probe.executable,
    ...(probe.version ? { version: probe.version } : {}),
    source: probe.source
  };
}
