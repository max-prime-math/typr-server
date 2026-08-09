import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { TexpressoSession, type TexpressoSnapshot, type TexpressoTextFile } from "./texpressoSession.ts";

const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/texpresso/", import.meta.url));
const activeSessions = new Set<TexpressoSession>();

interface TimingReport {
  fixture: string;
  conventionalColdMs: number;
  conventionalWarmMs: number[];
  texpressoInitialMs: number;
  texpressoIncrementalMs: number[];
  pid: number;
  generatedFiles: string[];
}

async function main(): Promise<void> {
  installShutdownHandlers();
  console.log("TeXpresso POC");
  console.log("Provider: TeX Live (-texlive); rendering: SDL dummy driver");

  const reports: TimingReport[] = [];
  try {
    reports.push(await exerciseFixture("simple", "chapter.tex"));
    reports.push(await exerciseFixture("realistic", "sections/introduction.tex"));
  } finally {
    await Promise.allSettled([...activeSessions].map((session) => session.close()));
  }

  console.log("\nBenchmark summary (milliseconds)");
  for (const report of reports) {
    const medianIncremental = median(report.texpressoIncrementalMs);
    const medianWarm = median(report.conventionalWarmMs);
    const speedup = medianWarm / medianIncremental;
    console.log(`\n${report.fixture}`);
    console.log(`  latexmk cold: ${formatMs(report.conventionalColdMs)}`);
    console.log(`  latexmk warm edits: ${report.conventionalWarmMs.map(formatMs).join(", ")} (median ${formatMs(medianWarm)})`);
    console.log(`  TeXpresso initial: ${formatMs(report.texpressoInitialMs)}`);
    console.log(`  TeXpresso incremental edits: ${report.texpressoIncrementalMs.map(formatMs).join(", ")} (median ${formatMs(medianIncremental)})`);
    console.log(`  warm-path speedup: ${speedup.toFixed(1)}x`);
    console.log(`  session PID: ${report.pid} (unchanged across all edits)`);
    console.log(`  generated project files: ${report.generatedFiles.length ? report.generatedFiles.join(", ") : "none (no PDF emitted to the project directory)"}`);
  }
}

async function exerciseFixture(name: "simple" | "realistic", editPath: string): Promise<TimingReport> {
  const files = await loadFixture(name);
  const root = await materialize(files);
  const conventionalRoot = await materialize(files);
  let session: TexpressoSession | undefined;
  try {
    const coldRoot = await materialize(files);
    const conventionalColdMs = await measure(() => runLatexmk(coldRoot));
    await rm(coldRoot, { recursive: true, force: true });

    const warmMs: number[] = [];
    const original = textFile(files, editPath);
    let conventionalText = original;
    for (const replacement of ["The conventional edit one.", "The conventional edit two.", "The conventional edit three."]) {
      conventionalText = conventionalText.replace("The original sentence.", replacement).replace(/The conventional edit \w+\./, replacement);
      await writeFile(join(conventionalRoot, editPath), conventionalText);
      warmMs.push(await measure(() => runLatexmk(conventionalRoot)));
    }
    const initialStart = performance.now();
    session = await TexpressoSession.start({ projectRoot: root, mainFilePath: "main.tex", files });
    activeSessions.add(session);
    const texpressoInitialMs = performance.now() - initialStart;
    const pid = session.pid;
    console.log(`\n${name}: session started (PID ${pid}), initial ${formatMs(texpressoInitialMs)}`);

    const incrementalMs: number[] = [];
    let current = "The original sentence.";
    for (const replacement of ["The changed sentence.", "The changed sentence again.", "The changed sentence finally."]) {
      const { value: snapshot, elapsed } = await measureWithValue(() => session!.replaceText(editPath, current, replacement));
      assert.equal(snapshot.result, "success", `${name}: an ordinary in-memory edit unexpectedly reported a TeX error.\n${diagnosticTail(snapshot)}`);
      incrementalMs.push(elapsed);
      current = replacement;
      assert.equal(session.pid, pid, `${name}: TeXpresso restarted during an incremental edit.`);
      console.log(`${name}: ${editPath} → success in ${formatMs(elapsed)}`);
    }
    assert.equal(await readFile(join(root, editPath), "utf8"), original, `${name}: TeXpresso modified the saved source instead of using its VFS overlay.`);

    const mainEdit = await measureWithValue(() => session!.replaceText("main.tex", "\\end{document}", "\\par Main source update.\n\\end{document}"));
    assert.equal(mainEdit.value.result, "success", `${name}: main.tex incremental edit failed.\n${diagnosticTail(mainEdit.value)}`);
    assert.equal(session.pid, pid, `${name}: TeXpresso restarted during a main-file edit.`);
    console.log(`${name}: main.tex → success in ${formatMs(mainEdit.elapsed)}`);

    const invalid = await measureWithValue(() => session!.replaceText(editPath, current, "\\undefinedTyprPocCommand"));
    assert.equal(invalid.value.result, "latex-error", `${name}: invalid TeX did not surface in TeXpresso output.\n${diagnosticTail(invalid.value)}`);
    console.log(`${name}: invalid edit → LaTeX error in ${formatMs(invalid.elapsed)}`);

    const recovery = await measureWithValue(() => session!.replaceText(editPath, "\\undefinedTyprPocCommand", "The recovered sentence."));
    assert.equal(recovery.value.result, "success", `${name}: TeXpresso did not recover in the same session.\n${diagnosticTail(recovery.value)}`);
    assert.equal(session.pid, pid, `${name}: TeXpresso restarted while recovering from invalid TeX.`);
    console.log(`${name}: recovery → success in ${formatMs(recovery.elapsed)}`);

    const generatedFiles = await listGeneratedFiles(root);
    await session.close();
    activeSessions.delete(session);
    session = undefined;
    return { fixture: name, conventionalColdMs, conventionalWarmMs: warmMs, texpressoInitialMs, texpressoIncrementalMs: incrementalMs, pid, generatedFiles };
  } finally {
    if (session) {
      await session.close();
      activeSessions.delete(session);
    }
    await rm(root, { recursive: true, force: true });
    await rm(conventionalRoot, { recursive: true, force: true });
  }
}

async function loadFixture(name: "simple" | "realistic"): Promise<TexpressoTextFile[]> {
  const fixtureRoot = join(FIXTURE_ROOT, name);
  const paths = await collectTexFiles(fixtureRoot);
  return Promise.all(paths.map(async (absolute) => ({
    path: relative(fixtureRoot, absolute).replaceAll("\\", "/"),
    content: await readFile(absolute, "utf8")
  })));
}

async function collectTexFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectTexFiles(path) : entry.name.endsWith(".tex") ? [path] : [];
  }));
  return nested.flat();
}

async function materialize(files: readonly TexpressoTextFile[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "typr-texpresso-poc-"));
  await Promise.all(files.map(async (file) => {
    const destination = join(root, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }));
  return root;
}

async function runLatexmk(cwd: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn("latexmk", ["-pdf", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "main.tex"], { cwd, stdio: "ignore" });
    child.on("error", rejectRun);
    child.on("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`latexmk exited with ${code}.`)));
  });
}

async function listGeneratedFiles(root: string): Promise<string[]> {
  const all = await collectAllFiles(root);
  return all.map((path) => relative(root, path)).filter((path) => !path.endsWith(".tex")).sort();
}

async function collectAllFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectAllFiles(path) : [path];
  }));
  return nested.flat();
}

function textFile(files: readonly TexpressoTextFile[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Fixture does not include ${path}.`);
  return file.content;
}

async function measure(task: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await task();
  return performance.now() - start;
}

async function measureWithValue<T>(task: () => Promise<T>): Promise<{ value: T; elapsed: number }> {
  const start = performance.now();
  const value = await task();
  return { value, elapsed: performance.now() - start };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)]!;
}

function formatMs(value: number): string {
  return `${Math.round(value)} ms`;
}

function diagnosticTail(snapshot: TexpressoSnapshot): string {
  return `${snapshot.output}\n${snapshot.log}`.slice(-4_000);
}

function installShutdownHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void Promise.allSettled([...activeSessions].map((session) => session.close())).then(() => {
        process.exit(0);
      });
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
