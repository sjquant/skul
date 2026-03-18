## Tasks

- [DONE] Define the CLI surface and argument model for `use`, `list`, `status`, and `clean`.
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
- [DONE] Implement conflict handling for existing filenames with user choices for rename, prefix, or skip.
- [DONE] Implement `skul status` output for repository desired state, current worktree materialization, and exclude status.
- [DONE] Implement `skul clean` to remove only registry-owned files, remove Skul exclude blocks, and clear worktree state safely.
- [DONE] Track managed file fingerprints and prompt before deleting or replacing user-modified managed files.
- [DONE] Implement error handling for missing Git repositories, missing bundles, file conflicts, and registry corruption.
- [DONE] Add tests covering registry behavior, worktree propagation, stealth handling, conflict handling, and safe cleanup.
- [DONE] Document current behavior, lifecycle rules, and constraints around worktrees, stealth mode, and security boundaries.

## Handoff Notes

- `TASKS.template.md` was not present in the repository, so this file follows the template content provided in the request.
- Tasks are derived directly from `/Users/sjquant/dev/skul/SPEC.md` and prioritize the implementation sequence implied by the spec.
- Registry desired state no longer stores an installation `mode`; Skul is currently stealth-only, and alternative install semantics should be reconsidered from scratch if they return later.
- Managed file fingerprints now gate cleanup and replacement, so user-modified managed files require confirmation before removal.
