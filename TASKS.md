## Tasks

- [DONE] Define the CLI surface and argument model for `use`, `list`, `status`, and `clean`. (superseded: `use` removed; `add` and `remove` replace it)
- [DONE] Design the global state layout under `~/.skul/` for `registry.json`, `library/`, and `config.json`.
- [DONE] Implement repository and worktree detection, including stable repository fingerprinting and worktree identification.
- [DONE] Define and validate the registry schema for repository desired state and worktree materialized state.
- [DONE] Implement tool mapping definitions for supported AI tools such as Claude Code, Cursor, OpenCode, and Codex.
- [DONE] Define the bundle manifest format and local cache layout for bundles stored under `~/.skul/library/`.
- [DONE] Implement bundle discovery and retrieval from local cache and Git-based sources.
- [DONE] Implement bundle materialization into tool-native directories without requiring tools to read from `.skul/`.
- [DONE] Implement stealth mode using `.git/info/exclude` blocks without modifying `.gitignore` or repository configuration.
- [DONE] Implement deterministic ownership tracking so cleanup and replacement rely only on registry records.
- [DONE] Implement bundle replacement flow that removes the previous bundle before applying the new one for the same tool.
- [DONE] Implement directory-level cross-tool replacement so `skul add` can replace one tool's managed files with another tool's bundle in the same worktree.
- [DONE] Define a tool-surface translation matrix for skills, commands, and agents across Claude Code, Cursor, Codex, and OpenCode, including required metadata transforms.
- [DONE] Implement conflict handling for existing filenames with user choices for rename, prefix, or skip.
- [DONE] Implement `skul status` output for repository desired state, current worktree materialization, and exclude status.
- [DONE] Implement `skul clean` to remove only registry-owned files, remove Skul exclude blocks, and clear worktree state safely.
- [DONE] Track managed file fingerprints and prompt before deleting or replacing user-modified managed files.
- [DONE] Implement error handling for missing Git repositories, missing bundles, file conflicts, and registry corruption.
- [DONE] Add tests covering registry behavior, worktree propagation, stealth handling, conflict handling, and safe cleanup.
- [DONE] Add tests covering directory-level cross-tool replacement, including modified managed files and exclude block updates.
- [REVIEW] Implement content transforms for cross-tool replacement, including front matter, `disable-model-invocation`, `agent.toml`, and OpenCode-specific command/agent config generation where required.
- [REVIEW] Add tests covering tool-specific cross-tool transforms for skills, commands, and agents, including OpenCode compatibility paths.
- [REVIEW] Document the tool-specific behavior differences and source references used for cross-tool transforms, including OpenCode.
- [DONE] Document current behavior, lifecycle rules, and constraints around worktrees, stealth mode, and security boundaries.

## Multi-Tool Bundle Support

- [TODO] Update bundle manifest format: replace single `tool` + `targets` fields with a `tools` map where each key is a tool name and each value declares that tool's targets.
- [TODO] Update `parseBundleManifest` in `bundle-manifest.ts` to parse and validate the new multi-tool manifest schema, including per-tool target validation.
- [TODO] Update `skul add` to accept optional `--tool <name>` flag (repeatable) for selecting a subset of tools to materialize from the bundle.
- [TODO] Update bundle materialization logic to iterate over selected tools and inject files into each tool's native directories independently.
- [TODO] Update `skul list` to show supported tools for each bundle.
- [TODO] Add tests covering multi-tool bundle parsing, materialization across multiple tools, and partial tool selection via `--tool`.

## Multi-Bundle Support

- [TODO] Add `version: 1` field to registry schema; update `parseRegistry` to validate version and error clearly on version mismatch to enable future migrations.
- [TODO] Update registry schema: replace `desired_state` (single bundle object) with an ordered array of `{ bundle, source?, tools? }` entries where `tools` is an optional subset of tool names to materialize.
- [TODO] Update registry schema: replace `materialized_state` (single bundle + flat tool map) with `{ bundles: { [bundleName]: { source?, tools: { [toolName]: { files, file_fingerprints, directories } } } }, exclude_configured }`.
- [TODO] Implement `skul add` command: appends bundle to desired state and materializes; if bundle already in desired state, re-materializes without modifying desired state (idempotent); file-level conflicts with other bundles prompt for resolution.
- [TODO] Persist `--tool` selection in the desired state entry so all worktrees materialize the same tool subset.
- [TODO] Implement `skul remove` command: removes a named bundle from the active set, deletes its managed files (with confirmation for user-modified files), and updates the registry.
- [TODO] Remove `skul use` command from CLI; update existing `use` implementation to become `add`.
- [TODO] Update `skul clean` to accept optional `--bundle <name>` flag; when specified, clean only that bundle's managed files.
- [TODO] Update `skul status` output to show materialized state grouped by bundle, then by tool.
- [TODO] Implement `skul apply` command: materializes all bundles in the repository desired state into the current worktree without modifying desired state; no-op if already fully materialized.
- [TODO] Add tests covering multi-bundle desired state parsing, `skul add` idempotency, file-level conflict between bundles, `--tool` persistence, `skul remove`, per-bundle cleanup, and worktree re-materialization via `skul apply`.
- [TODO] Update documentation and spec examples to reflect the new multi-bundle manifest format and registry schema.

## Handoff Notes

- `TASKS.template.md` was not present in the repository, so this file follows the template content provided in the request.
- Tasks are derived directly from `/Users/sjquant/dev/skul/SPEC.md` and prioritize the implementation sequence implied by the spec.
- Registry desired state no longer stores an installation `mode`; Skul is currently stealth-only, and alternative install semantics should be reconsidered from scratch if they return later.
- Managed file fingerprints now gate cleanup and replacement, so user-modified managed files require confirmation before removal.
- Directory-level cross-tool replacement is now supported for managed files in the current worktree, with the same modified-file confirmation gate used by same-tool replacement.
- Tool-specific translation helpers now exist for Claude, Cursor, Codex, and OpenCode skills, commands, and agents, but they are not yet wired into the bundle application path.
- The source-reference matrix lives in `docs/tool-surface-matrix.md` and is intentionally kept out of Git via `.git/info/exclude` because it is a volatile planning artifact, not stable public documentation.
