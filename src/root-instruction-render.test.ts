import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { renderTrackedRootInstructionShadow } from "./root-instruction-render";

const PREAMBLE =
  "Follow the instructions in this section; SKUL markers are metadata used to manage the content.";

describe("tracked root-instruction shadow rendering", () => {
  it("renders append shadows deterministically for normalized inputs", () => {
    // Given
    const firstRender = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules\n",
      overlays: [
        { bundleName: "personal-rules", content: "# Personal rules\n" },
      ],
      toolName: "codex",
      strategy: "append",
    });

    // When
    const secondRender = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules\n\n",
      overlays: [
        { bundleName: "personal-rules", content: "# Personal rules\n\n" },
      ],
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(secondRender).toEqual(firstRender);
    expect(firstRender.rendered).toBe(
      `# Team rules\n\n<!-- SKUL:INSTRUCTIONS START -->\n\n${PREAMBLE}\n\n<!-- SKUL SHADOW START bundle=personal-rules -->\n# Personal rules\n<!-- SKUL SHADOW END -->\n\n<!-- SKUL:INSTRUCTIONS END -->\n`,
    );
  });

  it("renders prepend shadows with one trailing newline", () => {
    // Given
    const options = {
      baseContent: "# Team rules\n",
      overlays: [
        { bundleName: "personal-rules", content: "# Personal rules\n\n" },
      ],
      toolName: "codex" as const,
      strategy: "prepend" as const,
    };

    // When
    const render = renderTrackedRootInstructionShadow(options);

    // Then
    expect(render.rendered).toBe(
      `<!-- SKUL:INSTRUCTIONS START -->\n\n${PREAMBLE}\n\n<!-- SKUL SHADOW START bundle=personal-rules -->\n# Personal rules\n<!-- SKUL SHADOW END -->\n\n<!-- SKUL:INSTRUCTIONS END -->\n\n# Team rules\n`,
    );
  });

  it("formats tracked shadow markers deterministically", () => {
    // Given
    const render = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules\n",
      overlays: [
        {
          bundleName: "personal-rules",
          content: "# Personal rules\nUse local overrides.\n",
        },
      ],
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(render.blocks).toEqual([
      "<!-- SKUL SHADOW START bundle=personal-rules -->\n# Personal rules\nUse local overrides.\n<!-- SKUL SHADOW END -->",
    ]);
  });

  it("folds several bundles onto one committed base in overlay order", () => {
    // Given
    const overlays = [
      {
        bundleName: "repo-standards",
        content: "Use consistent conventions.\n",
      },
      { bundleName: "security-standards", content: "Never commit secrets.\n" },
    ];

    // When
    const render = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules\n",
      overlays,
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(render.rendered).toBe(
      `# Team rules\n\n<!-- SKUL:INSTRUCTIONS START -->\n\n${PREAMBLE}\n\n<!-- SKUL SHADOW START bundle=repo-standards -->\nUse consistent conventions.\n<!-- SKUL SHADOW END -->\n\n<!-- SKUL SHADOW START bundle=security-standards -->\nNever commit secrets.\n<!-- SKUL SHADOW END -->\n\n<!-- SKUL:INSTRUCTIONS END -->\n`,
    );
    expect(render.blocks).toHaveLength(2);
  });

  it("keeps each bundle's block fingerprint independent of the bundles beside it", () => {
    // Given
    const soloRender = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules\n",
      overlays: [
        {
          bundleName: "repo-standards",
          content: "Use consistent conventions.",
        },
      ],
      toolName: "codex",
      strategy: "append",
    });

    // When
    const sharedRender = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules\n",
      overlays: [
        {
          bundleName: "repo-standards",
          content: "Use consistent conventions.",
        },
        { bundleName: "security-standards", content: "Never commit secrets." },
      ],
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(sharedRender.blocks[0]).toBe(soloRender.blocks[0]);
    expect(sharedRender.renderedFingerprint).not.toBe(
      soloRender.renderedFingerprint,
    );
  });

  it("omits tracked shadow markers when the overlay normalizes to empty", () => {
    // Given
    const baseContent = "# Team rules\n";

    // When
    const render = renderTrackedRootInstructionShadow({
      baseContent,
      overlays: [{ bundleName: "personal-rules", content: " \n\n" }],
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(render.blocks).toEqual([""]);
    expect(render.rendered).toBe(baseContent);
  });

  it("preserves tracked base content verbatim when appending shadows", () => {
    // Given
    const baseContent = "# Team rules  \n\n\n";

    // When
    const render = renderTrackedRootInstructionShadow({
      baseContent,
      overlays: [
        { bundleName: "personal-rules", content: "# Personal rules\n" },
      ],
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(render.rendered).toBe(
      `${baseContent}<!-- SKUL:INSTRUCTIONS START -->\n\n${PREAMBLE}\n\n<!-- SKUL SHADOW START bundle=personal-rules -->\n# Personal rules\n<!-- SKUL SHADOW END -->\n\n<!-- SKUL:INSTRUCTIONS END -->\n`,
    );
  });

  it("keeps overlay blocks stable when only the tracked base changes", () => {
    // Given
    const initialRender = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules v1\n",
      overlays: [
        { bundleName: "personal-rules", content: "# Personal rules\n" },
      ],
      toolName: "codex",
      strategy: "append",
    });

    // When
    const refreshedRender = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules v2\n",
      overlays: [
        { bundleName: "personal-rules", content: "# Personal rules\n" },
      ],
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(refreshedRender.blocks).toEqual(initialRender.blocks);
    expect(refreshedRender.renderedFingerprint).not.toBe(
      initialRender.renderedFingerprint,
    );
  });

  it("produces rendered fingerprints that expose manual edits", () => {
    // Given
    const render = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules\n",
      overlays: [
        { bundleName: "personal-rules", content: "# Personal rules\n" },
      ],
      toolName: "codex",
      strategy: "append",
    });

    // When
    const manualEditFingerprint = createHash("sha256")
      .update(`${render.rendered}\n# Manual change\n`)
      .digest("hex");

    // Then
    expect(createHash("sha256").update(render.rendered).digest("hex")).toBe(
      render.renderedFingerprint,
    );
    expect(manualEditFingerprint).not.toBe(render.renderedFingerprint);
  });

  it("guards replace rendering behind explicit confirmation", () => {
    // Given
    const options = {
      baseContent: "# Team rules\n",
      overlays: [
        { bundleName: "personal-rules", content: "# Personal rules\n" },
      ],
      toolName: "codex" as const,
      strategy: "replace" as const,
    };

    // When / Then
    expect(() => renderTrackedRootInstructionShadow(options)).toThrowError(
      /requires explicit confirmation/i,
    );
    expect(
      renderTrackedRootInstructionShadow({
        ...options,
        allowReplace: true,
      }).rendered,
    ).toBe(
      `<!-- SKUL:INSTRUCTIONS START -->\n\n${PREAMBLE}\n\n<!-- SKUL SHADOW START bundle=personal-rules -->\n# Personal rules\n<!-- SKUL SHADOW END -->\n\n<!-- SKUL:INSTRUCTIONS END -->\n`,
    );
  });

  it("drops the committed base once for several replace overlays", () => {
    // Given
    const overlays = [
      { bundleName: "repo-standards", content: "Use consistent conventions." },
      { bundleName: "security-standards", content: "Never commit secrets." },
    ];

    // When
    const render = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules\n",
      overlays,
      toolName: "codex",
      strategy: "replace",
      allowReplace: true,
    });

    // Then
    expect(render.rendered).not.toContain("# Team rules");
    expect(render.rendered).toBe(
      `<!-- SKUL:INSTRUCTIONS START -->\n\n${PREAMBLE}\n\n<!-- SKUL SHADOW START bundle=repo-standards -->\nUse consistent conventions.\n<!-- SKUL SHADOW END -->\n\n<!-- SKUL SHADOW START bundle=security-standards -->\nNever commit secrets.\n<!-- SKUL SHADOW END -->\n\n<!-- SKUL:INSTRUCTIONS END -->\n`,
    );
  });
});
