import { describe, expect, it } from "vitest";
import { latexOutputDirectoryArgument } from "./latexProject.ts";

describe("native LaTeX project arguments", () => {
  it("keeps generated files beside a nested main document", () => {
    expect(latexOutputDirectoryArgument("Booklet 1/booklet_01.tex")).toBe(
      "-output-directory=Booklet 1"
    );
  });

  it("keeps root-document output at the project root", () => {
    expect(latexOutputDirectoryArgument("main.tex")).toBe("-output-directory=.");
  });
});
