# Skul — AI Configuration Bundle Manager for Claude Code, Cursor, Codex & OpenCode

Skul is an open-source CLI that applies project-scoped AI configuration bundles into tool-native folders without committing them to Git. It writes skills, commands, and agents exactly where Claude Code, Cursor, OpenCode, and Codex expect them — then hides those files from version control using `.git/info/exclude`.

No `.gitignore` edits. No committed AI config files. No manual copy-paste between projects.

[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-lightgrey)](LICENSE)

---

## Why Use Skul?

AI coding tools like Claude Code, Cursor, and Codex rely on project-local configuration directories (`.claude/`, `.cursor/`, `.opencode/`, `.codex/`) to load skills, slash commands, and agents. Managing these files manually means:

- Duplicating config across every project and worktree
- Either committing AI-specific files (polluting the repo) or maintaining messy `.gitignore` rules
- Re-applying everything by hand after a fresh `git worktree add`

Skul solves all three. It keeps a local library of reusable bundles, injects them on demand, and tracks what it owns — so cleanup and re-application are one command each.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Supported AI Tools](#supported-ai-tools)
- [Bundle Structure](#bundle-structure)
- [How Skul Works](#how-skul-works)
- [Use in AI Agents and CI Scripts](#use-in-ai-agents-and-ci-scripts)
- [Safety and Non-Destructive Design](#safety-and-non-destructive-design)
- [Development](#development)
- [FAQ](#faq)

---

## Installation

```bash
git clone https://github.com/sjquant/skul
cd skul
pnpm install
pnpm run build
npm link            # makes `skul` available globally
```

**Requirements:** Node.js >=20, pnpm

---

## Quick Start

```bash
# List AI configuration bundles in your local library
skul list

# Apply a bundle to the current project
skul add react-expert

# See what Skul has materialized in the current worktree
skul status

# Remove all Skul-managed AI config files
skul reset
```

---

## Commands

### `skul add` — Apply an AI configuration bundle

Adds a bundle to the project's active set and writes its files into tool-native directories.

```bash
skul add react-expert                             # apply from local library
skul add github.com/user/ai-vault react-expert    # apply from a specific source
skul add react-expert --tool claude-code          # apply to one tool only
skul add react-expert --dry-run                   # preview without writing any files
```

| Argument / Option | Description |
|---|---|
| `[source]` | Bundle source (e.g. `github.com/user/repo`). Defaults to local library. |
| `[bundle]` | Bundle name. Prompted interactively if omitted; required in headless mode. |
| `--tool <name>` | Limit materialization to a specific tool. Repeatable. |
| `--dry-run` | Preview what would be written without touching the filesystem. |

---

### `skul remove` — Remove a specific bundle

Removes a bundle from the project's active set and deletes its managed files from the current worktree.

```bash
skul remove react-expert
skul remove react-expert --dry-run
```

| Argument / Option | Description |
|---|---|
| `<bundle>` | Bundle name to remove (required). |
| `--dry-run` | Preview deletions without removing any files. |

---

### `skul apply` — Re-materialize bundles after a new worktree

Re-materializes every bundle in the project's desired state into the current worktree. Run this after `git worktree add` or cloning onto a new machine.

```bash
skul apply
```

---

### `skul list` — List available bundles

Lists all AI configuration bundles cached in the local library (`~/.skul/library/`).

```bash
skul list
skul list --json
```

---

### `skul status` — Check materialization state

Shows the project's desired bundle set and each bundle's materialization state in the current worktree.

```bash
skul status
skul status --json
```

---

### `skul reset` — Clean up all managed files

Removes every Skul-managed file from the current worktree and clears the worktree's materialization state.

```bash
skul reset
skul reset --dry-run
```

---

## Supported AI Tools

Skul materializes bundles for any combination of the following tools. Each tool has its own native directory layout that Skul resolves automatically.

| Tool | Skills directory | Commands directory | Agents directory |
|---|---|---|---|
| **Claude Code** | `.claude/skills` | `.claude/commands` | `.claude/agents` |
| **Cursor** | `.cursor/skills` | `.cursor/commands` | `.cursor/agents` |
| **OpenCode** | `.opencode/skills` | `.opencode/commands` | `.opencode/agents` |
| **Codex** | `.agents/skills` | — | `.codex/agents` |

Use `--tool <name>` with `skul add` to target a single tool instead of all of them.

---

## Bundle Structure

Bundles are stored under `~/.skul/library/<source>/<bundle-name>/`. Skul supports two layouts and an optional manifest file.

### Option 1 — Canonical layout (recommended)

Create top-level `skills/`, `commands/`, and/or `agents/` directories. Skul copies them to every tool that supports each target type.

```
~/.skul/library/local/react-expert/
├── skills/
│   └── react-patterns.md
├── commands/
│   └── gen-component.md
└── agents/
    └── component-reviewer.md
```

### Option 2 — Native layout

Use tool-native dotdirs to pre-author content for a specific tool only.

```
~/.skul/library/local/react-expert/
├── .claude/
│   └── skills/
│       └── react-patterns.md
└── .cursor/
    └── commands/
        └── gen-component.md
```

### Option 3 — Explicit manifest

Add a `manifest.json` to override path resolution for any tool/target combination.

```json
{
  "name": "react-expert",
  "tools": {
    "claude-code": {
      "skills": { "path": "claude/skills" },
      "commands": { "path": "claude/commands" }
    },
    "cursor": {
      "skills": { "path": "cursor/skills" }
    }
  }
}
```

**`manifest.json` field reference:**

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Bundle identifier (must match the directory name). |
| `tools` | `object` | Map of tool name → target name → `{ path }`. |
| `tools.<tool>.<target>.path` | `string` | Relative path inside the bundle directory. |

Valid tool names: `claude-code`, `cursor`, `opencode`, `codex`.  
Valid target names: `skills`, `commands`, `agents`.

---

## How Skul Works

Skul keeps all state under `~/.skul/`:

```
~/.skul/
├── library/              # cached bundle sources
│   └── <source>/
│       └── <bundle>/
└── registry.json         # desired state + per-worktree materialization records
```

**Two-level registry:** the registry records two things separately:

- **Repo-level desired state** — which bundles this repo wants.
- **Worktree-level materialization** — which files were actually written in each worktree.

This means a freshly-created linked worktree sees the desired bundles in `skul status` (because the repo wants them) without pretending the files are already there. Running `skul apply` then materializes them.

**Git stealth mode:** Skul appends ignore rules to `.git/info/exclude` — the per-repo, non-committed ignore file — so materialized AI config files stay invisible to Git without touching `.gitignore`.

**Conflict handling:** if a target file already exists and is not Skul-managed, you are prompted to rename the incoming file, apply a prefix, or skip it. In headless mode the default prefix is applied automatically.

---

## Use in AI Agents and CI Scripts

Skul is built for non-interactive use in autonomous AI agent pipelines and CI environments.

### Machine-readable JSON output

```bash
skul list --json
skul status --json
```

### Dry-run before mutating

```bash
skul add react-expert --dry-run
skul remove react-expert --dry-run
skul reset --dry-run
```

### Headless mode (no interactive prompts)

Set `SKUL_NO_TUI=1` to suppress all prompts. Conflicts auto-resolve with a safe default; operations that require confirmation fail immediately with a clear error and recovery hint.

```bash
SKUL_NO_TUI=1 skul add react-expert
SKUL_NO_TUI=1 skul reset
```

| Headless scenario | Behavior |
|---|---|
| Bundle name omitted | Exits with error — hint: pass `<bundle>` explicitly |
| File conflict on `add` | Auto-applies default prefix (`_skul_`) |
| Modified managed file blocks removal | Exits with error — hint: run interactively to confirm |

---

## Safety and Non-Destructive Design

- **No `.gitignore` edits** — ignore rules go to `.git/info/exclude` only.
- **No Git config or history changes** — Skul never touches commits, refs, or config.
- **Registry-driven cleanup** — file removal uses tracked paths, not filename guessing.
- **Modified-file guard** — files edited after materialization require explicit confirmation before removal (or fail fast in headless mode).
- **`--dry-run` on all mutating commands** — inspect any change before it happens.
- **Missing bundle recovery** — Skul lists available cached bundle names when a requested bundle is not found.
- **Corrupt registry guard** — a malformed `registry.json` halts execution and explains how to repair or remove it.

**Current limitations:**
- Cross-tool content transforms (front matter changes, `disable-model-invocation`, `agent.toml` generation) are not yet applied during materialization.

---

## Development

```bash
pnpm install            # install dependencies
pnpm run typecheck      # type-check without emitting
pnpm run test           # run tests once
pnpm run build          # compile to dist/
pnpm run dev -- --help  # run CLI via tsx (use instead of a global skul)
```

### Source layout

```
src/
  index.ts                  # CLI entrypoint
  cli.ts                    # Command parsing and prompt clients
  registry.ts               # Registry schema, parsing, persistence
  state-layout.ts           # Global state paths (~/.skul/)
  git-context.ts            # Repo fingerprinting and worktree detection
  git-exclude.ts            # Stealth mode via .git/info/exclude
  tool-mapping.ts           # Tool definitions and native directory mappings
  bundle-manifest.ts        # Manifest parsing, validation, and inference
  bundle-discovery.ts       # Bundle fetch from local cache and Git sources
  bundle-materialization.ts # File injection into tool-native directories
  bundle-translation.ts     # Cross-tool content transforms
  conflict-resolution.ts    # Conflict resolution prompts and defaults
  *.test.ts                 # Vitest unit tests
```

---

## FAQ

**Does Skul modify `.gitignore`?**  
No. Skul writes only to `.git/info/exclude`, which is never committed and does not appear in `git status`.

**What happens to materialized files after `git worktree remove`?**  
The registry tracks files per worktree path. If the worktree is removed externally, use `skul reset` in that directory beforehand, or the registry entry will remain until manually cleared.

**Can I use Skul in a CI/CD pipeline?**  
Yes. Set `SKUL_NO_TUI=1` for non-interactive operation and pass `--json` to parse output programmatically.

**Can multiple worktrees use different bundles?**  
Repo-level desired state is shared across worktrees. Per-worktree materialization is tracked independently, so `skul apply` in each worktree brings it up to date. Worktree-specific overrides are not yet supported.

**What file types can a bundle contain?**  
Any files — Skul copies them as-is. Typical content includes Markdown skill definitions, YAML agent configs, and slash-command files.

**How do I create my own bundle?**  
Create a directory under `~/.skul/library/local/<bundle-name>/`, add `skills/`, `commands/`, and/or `agents/` subdirectories with your files, and run `skul add <bundle-name>`.

---

## License

[ISC](LICENSE)
