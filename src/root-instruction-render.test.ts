import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { renderTrackedRootInstructionShadow } from "./root-instruction-render";

describe("tracked root-instruction shadow rendering", () => {
  it("renders append shadows deterministically for normalized inputs", () => {
    // Given
    const firstRender = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules\n",
      overlayContent: "# Personal rules\n",
      bundleName: "personal-rules",
      toolName: "codex",
      strategy: "append",
    });

    // When
    const secondRender = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules\n\n",
      overlayContent: "# Personal rules\n\n",
      bundleName: "personal-rules",
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(secondRender).toEqual(firstRender);
    expect(firstRender.rendered).toBe(
      "# Team rules\n\n<!-- SKUL SHADOW START bundle=personal-rules -->\n# Personal rules\n<!-- SKUL SHADOW END -->\n",
    );
  });

  it("renders prepend shadows with one trailing newline", () => {
    // Given
    const options = {
      baseContent: "# Team rules\n",
      overlayContent: "# Personal rules\n\n",
      bundleName: "personal-rules",
      toolName: "codex" as const,
      strategy: "prepend" as const,
    };

    // When
    const render = renderTrackedRootInstructionShadow(options);

    // Then
    expect(render.rendered).toBe(
      "<!-- SKUL SHADOW START bundle=personal-rules -->\n# Personal rules\n<!-- SKUL SHADOW END -->\n\n# Team rules\n",
    );
  });

  it("formats tracked shadow markers deterministically", () => {
    // Given
    const render = renderTrackedRootInstructionShadow({
      bundleName: "personal-rules",
      baseContent: "# Team rules\n",
      overlayContent: "# Personal rules\nUse local overrides.\n",
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(render.overlay).toBe(
      "<!-- SKUL SHADOW START bundle=personal-rules -->\n# Personal rules\nUse local overrides.\n<!-- SKUL SHADOW END -->",
    );
  });

  it("omits tracked shadow markers when the overlay normalizes to empty", () => {
    // Given
    const baseContent = "# Team rules\n";

    // When
    const render = renderTrackedRootInstructionShadow({
      baseContent,
      overlayContent: " \n\n",
      bundleName: "personal-rules",
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(render.overlay).toBe("");
    expect(render.rendered).toBe(baseContent);
  });

  it("preserves tracked base content verbatim when appending shadows", () => {
    // Given
    const baseContent = "# Team rules  \n\n\n";

    // When
    const render = renderTrackedRootInstructionShadow({
      baseContent,
      overlayContent: "# Personal rules\n",
      bundleName: "personal-rules",
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(render.rendered).toBe(
      `${baseContent}<!-- SKUL SHADOW START bundle=personal-rules -->\n# Personal rules\n<!-- SKUL SHADOW END -->\n`,
    );
  });

  it("keeps overlay fingerprints stable when only the tracked base changes", () => {
    // Given
    const initialRender = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules v1\n",
      overlayContent: "# Personal rules\n",
      bundleName: "personal-rules",
      toolName: "codex",
      strategy: "append",
    });

    // When
    const refreshedRender = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules v2\n",
      overlayContent: "# Personal rules\n",
      bundleName: "personal-rules",
      toolName: "codex",
      strategy: "append",
    });

    // Then
    expect(refreshedRender.overlayFingerprint).toBe(initialRender.overlayFingerprint);
    expect(refreshedRender.renderedFingerprint).not.toBe(initialRender.renderedFingerprint);
  });

  it("produces rendered fingerprints that expose manual edits", () => {
    // Given
    const render = renderTrackedRootInstructionShadow({
      baseContent: "# Team rules\n",
      overlayContent: "# Personal rules\n",
      bundleName: "personal-rules",
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
      overlayContent: "# Personal rules\n",
      bundleName: "personal-rules",
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
    ).toBe("# Personal rules\n");
  });
});
