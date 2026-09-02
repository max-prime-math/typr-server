import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { latexProjectExecutionLocation } from "./latexProject.ts";

describe("native LaTeX project execution location", () => {
  it("runs a nested main document from its own directory", () => {
    expect(latexProjectExecutionLocation("/compile", "Booklet 1/booklet_01.tex")).toEqual({
      workingDirectory: resolve("/compile/Booklet 1"),
      mainFileArgument: "booklet_01.tex",
      outputDirectoryArgument: "-output-directory=."
    });
  });

  it("keeps a root main document at the project root", () => {
    expect(latexProjectExecutionLocation("/compile", "main.tex")).toEqual({
      workingDirectory: resolve("/compile"),
      mainFileArgument: "main.tex",
      outputDirectoryArgument: "-output-directory=."
    });
  });
});
