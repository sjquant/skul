## Overview

Skul is a TypeScript CLI for managing project-scoped AI configuration bundles. It writes AI tool configuration assets (skills, commands, agents) into tool-native directories (`.claude/`, `.cursor/`, `.opencode/`, `.agents/`) and hides them from Git via `.git/info/exclude`.

## Development Commands

```bash
# Install dependencies
pnpm install

# Type-check the project
pnpm run typecheck

# Run Vitest once
pnpm run test

# Build TypeScript output into dist/
pnpm run build

# Run the CLI entrypoint in development
pnpm run dev
```

---

## Agent Usage Guide

### Headless Mode

Set `SKUL_NO_TUI=1` before invoking skul to suppress all interactive prompts. In this mode:

- `skul add` requires an explicit bundle name (no interactive selection).
- File conflicts resolve automatically with the default prefix (`skul_`).
- Modified managed files block destructive operations and print an error with a recovery hint.

```sh
SKUL_NO_TUI=1 skul add react-expert
```

### Machine-Readable Output

Use `--json` on read-only commands to get structured output suitable for parsing.

#### `skul list --json`

```sh
skul list --json
```

Returns:
```json
{
  "bundles": [
    { "name": "react-expert", "tools": ["claude-code", "cursor"] },
    { "name": "repo-standards", "tools": ["codex"] }
  ]
}
```

#### `skul status --json`

```sh
skul status --json
```

Returns:
```json
{
  "repo": {
    "desired_state": [{ "bundle": "react-expert" }]
  },
  "worktree": {
    "path": "/path/to/repo",
    "materialized": true,
    "bundles": {
      "react-expert": {
        "tools": {
          "claude-code": { "files": [".claude/skills/react/SKILL.md"] }
        }
      }
    },
    "git_exclude_configured": true
  }
}
```

If bundles are configured but not yet materialized, a `suggested_action` field is included:

```json
{ "suggested_action": "skul apply" }
```

### Dry-Run Before Mutating

Use `--dry-run` to validate parameters and preview changes before writing or deleting files.

```sh
skul add react-expert --dry-run
# DRY RUN: Would apply react-expert for claude-code, cursor

skul remove react-expert --dry-run
# DRY RUN: Would remove react-expert (2 file(s))
#   .claude/skills/react/SKILL.md
#   .claude/commands/review.md

skul reset --dry-run
# DRY RUN: Would remove 3 file(s) from /path/to/repo
#   .claude/skills/react/SKILL.md
```

### Recommended Agent Workflow

```sh
# 1. Check what bundles are available
skul list --json

# 2. Inspect current state
skul status --json

# 3. Dry-run to validate parameters
SKUL_NO_TUI=1 skul add react-expert --dry-run

# 4. Apply if the dry-run output looks correct
SKUL_NO_TUI=1 skul add react-expert

# 5. Verify materialization succeeded
skul status --json
```

### Command Reference

| Command | Description | AX Flags |
|---------|-------------|----------|
| `skul add [source] <bundle>` | Add a bundle and materialize its files | `--dry-run`, `--tool` |
| `skul list` | List cached bundles | `--json` |
| `skul status` | Show desired and materialized state | `--json` |
| `skul apply` | Materialize all desired-state bundles | — |
| `skul remove <bundle>` | Remove a bundle and its files | `--dry-run` |
| `skul reset` | Remove all Skul-managed files | `--dry-run` |

### State Storage

- **Registry**: `~/.skul/registry.json` — tracks desired state per repo and materialized state per worktree.
- **Bundle library**: `~/.skul/library/` — local cache of fetched bundles.
- **Git exclude**: `.git/info/exclude` — stealth-mode exclusions (never modifies `.gitignore`).

### Error Recovery

Errors print actionable hints to `stderr`. Common cases:

| Error | Hint |
|-------|------|
| Bundle not found | Lists available bundles in the library |
| Registry corrupted | `repair or remove ~/.skul/registry.json and try again` |
| Not inside a Git repo | Run from inside a Git worktree |
| Modified managed file blocks operation | Use `skul status` to inspect, or run interactively to confirm |
