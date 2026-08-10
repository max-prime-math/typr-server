import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TEXPRESSO_RENDER_DPI,
  MAX_TEXPRESSO_RENDER_DPI,
  TexpressoSession,
  type TexpressoTextFile
} from "./texpressoSession.ts";

const activeSessions = new Set<TexpressoSession>();
const outputRoot = process.env.TYPR_TEXPRESSO_RENDER_OUTPUT;

interface Timed<T> {
  value: T;
  elapsed: number;
}

interface PageMeasurement {
  page: number;
  dpi: number;
  width: number;
  height: number;
  bytes: number;
  renderMs: number;
}

async function main(): Promise<void> {
  installShutdownHandlers();
  const files = renderFixture();
  const root = await materialize(files);
  const temporaryOutput = outputRoot ? undefined : await mkdtemp(join(tmpdir(), "typr-texpresso-render-output-"));
  const destination = outputRoot ?? temporaryOutput!;
  let session: TexpressoSession | undefined;

  try {
    await mkdir(destination, { recursive: true });
    const initialStart = performance.now();
    session = await TexpressoSession.start({ projectRoot: root, mainFilePath: "main.tex", files, timeoutMs: 30_000 });
    activeSessions.add(session);
    const initialFirstPageMs = performance.now() - initialStart;
    const initialMemory = await residentMemoryKb(session.pid);
    const discoveredInitial = await timed(() => discoverPageCount(session!, 96));
    const initialPageCount = discoveredInitial.value;
    const initialFullDocumentMs = performance.now() - initialStart;
    assert.ok(initialPageCount >= 3, `Expected render fixture to have at least three pages; got ${initialPageCount}.`);

    console.log("TeXpresso page-render POC");
    console.log(`session PID: ${session.pid}`);
    console.log(`initial TeXpresso state (first page): ${formatMs(initialFirstPageMs)}; full-document discovery: ${formatMs(initialFullDocumentMs)} (${formatMs(discoveredInitial.elapsed)} after first page)`);
    console.log(`initial document: ${initialPageCount} pages; RSS ${formatKb(initialMemory)}`);

    const baselineDpi = 144;
    const preferredDpi = DEFAULT_TEXPRESSO_RENDER_DPI;
    const higherDpi = MAX_TEXPRESSO_RENDER_DPI;
    const baseline = await renderAll(session, initialPageCount, baselineDpi, destination, "initial-144");
    const preferred = await renderAll(session, initialPageCount, preferredDpi, destination, `initial-${preferredDpi}`);
    const higher = await renderAll(session, initialPageCount, higherDpi, destination, `initial-${higherDpi}`);
    printResolution("144 DPI", baseline);
    printResolution(`${preferredDpi} DPI`, preferred);
    printResolution(`${higherDpi} DPI`, higher);

    const initialPid = session.pid;
    const firstDigest = digest((await session.renderPage(0, preferredDpi)).data);
    const incremental: number[] = [];
    const raster: number[] = [];
    const totals: number[] = [];
    let token = "PAGEONETOKEN";
    for (const replacement of ["PAGEONEEDITA", "PAGEONEEDITB", "PAGEONEEDITC", "PAGEONEEDITD", "PAGEONEEDITE"]) {
      const edit = await timed(() => session!.replaceText("body.tex", token, replacement));
      assert.equal(edit.value.result, "success", `Ordinary edit failed: ${diagnostics(edit.value.output, edit.value.log)}`);
      const render = await timed(() => session!.renderPage(0, preferredDpi));
      assert.equal(session.pid, initialPid, "TeXpresso PID changed during an edit.");
      assert.equal(render.value.mimeType, "image/png");
      incremental.push(edit.elapsed);
      raster.push(render.elapsed);
      totals.push(edit.elapsed + render.elapsed);
      token = replacement;
    }
    assert.notEqual(digest((await session.renderPage(0, preferredDpi)).data), firstDigest, "A source edit did not change the exported first-page raster.");
    console.log(`word edits: update median ${formatMs(median(incremental))}; raster median ${formatMs(median(raster))}; edit-to-PNG median ${formatMs(median(totals))}`);

    const cached = await timed(() => session!.renderPage(0, preferredDpi));
    assert.ok(cached.elapsed < 5, `Expected cached render to avoid repeated rasterization; got ${formatMs(cached.elapsed)}.`);
    console.log(`same-revision cached page lookup: ${formatMs(cached.elapsed)}`);

    const layout = await timed(() => session!.replaceText("body.tex", "LAYOUTSHIFTTOKEN", layoutShiftText()));
    assert.equal(layout.value.result, "success", `Layout-shifting edit failed: ${diagnostics(layout.value.output, layout.value.log)}`);
    const shiftedCount = await discoverPageCount(session, 96);
    const shiftedRender = await timed(() => renderAll(session!, shiftedCount, preferredDpi, destination, "layout-shift"));
    console.log(`layout shift: ${initialPageCount} → ${shiftedCount} pages; update ${formatMs(layout.elapsed)}; all-page raster ${formatMs(shiftedRender.elapsed)}`);

    const crossReference = await timed(() => session!.replaceText("main.tex", "Reference marker: \\ref{page:three}.", "Reference marker revised: \\ref{page:three}."));
    assert.equal(crossReference.value.result, "success", `Cross-reference edit failed: ${diagnostics(crossReference.value.output, crossReference.value.log)}`);
    const crossReferencePageCount = await discoverPageCount(session, 96);
    const crossRender = await timed(() => renderAll(session!, crossReferencePageCount, preferredDpi, destination, "cross-reference"));
    console.log(`cross-reference edit: update ${formatMs(crossReference.elapsed)}; conservative all-page raster ${formatMs(crossRender.elapsed)}`);

    const validBeforeError = await session.renderPage(0, 110);
    const invalid = await timed(() => session!.replaceText("body.tex", token, "\\undefinedTyprRenderPocCommand"));
    assert.equal(invalid.value.result, "latex-error", "Invalid LaTeX did not produce a TeXpresso diagnostic.");
    const retained = session.getCachedPage(0, 110);
    assert.ok(retained, "The last successful page was not retained after an invalid edit.");
    assert.equal(digest(retained!.data), digest(validBeforeError.data));
    const invalidStateRender = await timed(() => session!.renderPage(0, 100));
    console.log(`invalid edit: diagnostic in ${formatMs(invalid.elapsed)}; cached last-good page retained; direct current-state render ${formatMs(invalidStateRender.elapsed)} (${digest(invalidStateRender.value.data) === digest(validBeforeError.data) ? "same last-good content" : "different content"})`);

    const recovery = await timed(() => session!.replaceText("body.tex", "\\undefinedTyprRenderPocCommand", "PAGEONERECOVERED"));
    assert.equal(recovery.value.result, "success", `Recovery failed: ${diagnostics(recovery.value.output, recovery.value.log)}`);
    const recoveredRender = await timed(() => session!.renderPage(0, preferredDpi));
    console.log(`recovery: update ${formatMs(recovery.elapsed)}; raster ${formatMs(recoveredRender.elapsed)}`);

    const finalMemory = await residentMemoryKb(session.pid);
    console.log(`RSS after repeated edits/renders: ${formatKb(finalMemory)}`);
    for (const pages of [baseline, preferred, higher]) {
      console.log(`PNG payload @ ${pages[0]!.dpi} DPI: average ${formatBytes(average(pages.map((page) => page.bytes)))}; largest ${formatBytes(Math.max(...pages.map((page) => page.bytes)))}; initial document ${formatBytes(sum(pages.map((page) => page.bytes)))}`);
    }
    console.log("WebP comparison: not emitted by the pinned MuPDF API and no image-processing dependency was added; PNG is the native low-complexity baseline.");
    console.log(`sample PNGs: ${destination}${outputRoot ? " (retained)" : " (temporary; removed after this run)"}`);
  } finally {
    if (session) {
      await session.close();
      activeSessions.delete(session);
    }
    await rm(root, { recursive: true, force: true });
    if (temporaryOutput) await rm(temporaryOutput, { recursive: true, force: true });
  }
}

async function renderAll(session: TexpressoSession, pageCount: number, dpi: number, destination: string, prefix: string): Promise<PageMeasurement[]> {
  const pages: PageMeasurement[] = [];
  for (let page = 0; page < pageCount; page += 1) {
    const rendered = await timed(() => session.renderPage(page, dpi));
    const output = rendered.value;
    await writeFile(join(destination, `${prefix}-page-${page + 1}.png`), output.data);
    pages.push({ page, dpi, width: output.width, height: output.height, bytes: output.data.byteLength, renderMs: rendered.elapsed });
  }
  return pages;
}

/**
 * TeXpresso is viewer-driven: page_count grows as a page is requested. Asking
 * for the first unavailable page makes the small upstream patch advance to
 * EOF and return page-image-error, after which page-count is final.
 */
async function discoverPageCount(session: TexpressoSession, dpi: number): Promise<number> {
  for (let page = 0; page < 64; page += 1) {
    try {
      await session.renderPage(page, dpi);
    } catch {
      return session.getPageCount();
    }
  }
  throw new Error("Render POC refuses documents with more than 64 pages.");
}

function printResolution(label: string, pages: readonly PageMeasurement[]): void {
  console.log(`${label}: ${pages.map((page) => `${page.width}×${page.height}, ${formatBytes(page.bytes)}, ${formatMs(page.renderMs)}`).join(" | ")}`);
}

function renderFixture(): TexpressoTextFile[] {
  return [
    {
      path: "main.tex",
      content: String.raw`\documentclass{article}
\usepackage{amsmath}
\title{Typr TeXpresso render export POC}
\begin{document}
\maketitle
\input{body.tex}
Reference marker: \ref{page:three}.
\end{document}
`
    },
    {
      path: "body.tex",
      content: String.raw`\section{First page}
PAGEONETOKEN

This page exercises a text-only edit that should not require an SDL window.
LAYOUTSHIFTTOKEN
\newpage
\section{Second page}
This is the second explicit page. Its position identifies document stability.
\newpage
\section{Third page}\label{page:three}
This is the final page with a label used by the main-file cross reference.
`
    }
  ];
}

function layoutShiftText(): string {
  return Array.from({ length: 90 }, (_, index) => `Inserted layout line ${index + 1}: TeXpresso must conservatively invalidate later pages.\n`).join("");
}

async function materialize(files: readonly TexpressoTextFile[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "typr-texpresso-render-poc-"));
  await Promise.all(files.map(async (file) => {
    const destination = join(root, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }));
  return root;
}

async function residentMemoryKb(pid: number): Promise<number | undefined> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

async function timed<T>(task: () => Promise<T>): Promise<Timed<T>> {
  const start = performance.now();
  const value = await task();
  return { value, elapsed: performance.now() - start };
}

function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)]!;
}

function average(values: readonly number[]): number {
  return sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function formatMs(value: number): string {
  return `${Math.round(value)} ms`;
}

function formatBytes(value: number): string {
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
}

function formatKb(value: number | undefined): string {
  return value === undefined ? "unavailable" : `${Math.round(value / 1024)} MB`;
}

function diagnostics(output: string, log: string): string {
  return `${output}\n${log}`.slice(-2_000);
}

function installShutdownHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void Promise.allSettled([...activeSessions].map((session) => session.close())).then(() => process.exit(0));
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
