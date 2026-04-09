# Skul

> Apply project-scoped AI configuration bundles into tool-native folders — without committing them to Git.

[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-lightgrey)](LICENSE)

Skul writes files exactly where AI tools expect them (`.claude/`, `.cursor/`, `.opencode/`, `.codex/`), tracks ownership through `.git/info/exclude`, and keeps everything invisible to Git — no `.gitignore` edits, no committed files.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Supported Tools](#supported-tools)
- [Bundle Structure](#bundle-structure)
- [How It Works](#how-it-works)
- [Agent and Scripting Use](#agent-and-scripting-use)
- [Safety Model](#safety-model)
- [Development](#development)

---

## Installation

```bash
# Install from source
git clone https://github.com/sjquant/skul
cd skul
pnpm install
pnpm run build
npm link            # makes `skul` available globally
```

> Requires **Node.js >=20** and **pnpm**.

---

## Quick Start

```bash
# See what bundles are available in your local library
skul list

# Apply a bundle to the current repo
skul add react-expert

# Check what Skul has materialized in this worktree
skul status

# Remove all Skul-managed files
skul reset
```

---

## Commands

### `skul add [source] [bundle]`

Add a bundle to the repo's active set and materialize its files into tool-native directories.

```bash
skul add react-expert                         # from local library
skul add github.com/user/ai-vault react-expert  # from a specific source
skul add react-expert --tool claude-code      # materialize for one tool only
skul add react-expert --dry-run               # preview without writing
```

| Argument / Option | Description |
|---|---|
| `[source]` | Bundle source (e.g. `github.com/user/repo`). Optional — defaults to local library. |
| `[bundle]` | Bundle name. Required in headless mode; prompted interactively otherwise. |
| `--tool <name>` | Limit materialization to a specific tool. Repeatable. |
| `--dry-run` | Preview writes without modifying the filesystem. |

---

### `skul remove <bundle>`

Remove a bundle from the repo's active set and delete its managed files from the current worktree.

```bash
skul remove react-expert
skul remove react-expert --dry-run
```

| Argument / Option | Description |
|---|---|
| `<bundle>` | Bundle name to remove (required). |
| `--dry-run` | Preview deletions without modifying the filesystem. |

---

### `skul apply`

Materialize all bundles in the repo's desired state into the current worktree. Useful after cloning a linked worktree or switching to a new machine.

```bash
skul apply
```

---

### `skul list`

List all bundles available in the local library (`~/.skul/library/`).

```bash
skul list
skul list --json
```

| Option | Description |
|---|---|
| `--json` | Emit JSON for scripting and agent pipelines. |

---

### `skul status`

Show the repo's desired bundle set alongside each bundle's materialization state in the current worktree.

```bash
skul status
skul status --json
```

| Option | Description |
|---|---|
| `--json` | Emit JSON for scripting and agent pipelines. |

---

### `skul reset`

Remove every Skul-managed file from the current worktree and clear the worktree's materialization state.

```bash
skul reset
skul reset --dry-run
```

| Option | Description |
|---|---|
| `--dry-run` | Preview deletions without modifying the filesystem. |

---

## Supported Tools

Skul resolves target paths per tool. Each tool can receive `skills`, `commands`, and/or `agents` depending on what the tool supports.

| Tool | `skills` | `commands` | `agents` |
|---|---|---|---|
| `claude-code` | `.claude/skills` | `.claude/commands` | `.claude/agents` |
| `cursor` | `.cursor/skills` | `.cursor/commands` | `.cursor/agents` |
| `opencode` | `.opencode/skills` | `.opencode/commands` | `.opencode/agents` |
| `codex` | `.agents/skills` | — | `.codex/agents` |

---

## Bundle Structure

A bundle lives under `~/.skul/library/<source>/<bundle-name>/` and must contain either:

- **Canonical layout** — top-level `skills/`, `commands/`, and/or `agents/` directories that apply to all tools supporting each target type.
- **Native layout** — tool-native dotdirs (`.claude/skills/`, `.cursor/commands/`, etc.) that apply only to the matching tool.
- **Manifest** — an explicit `manifest.json` that maps tool targets to paths within the bundle.

### `manifest.json` (optional)

When present, `manifest.json` overrides directory inference.

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

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Bundle identifier (must match the directory name). |
| `tools` | `object` | Map of tool name → target name → `{ path }`. |
| `tools.<tool>.<target>.path` | `string` | Relative path inside the bundle directory. |

Valid tool names: `claude-code`, `cursor`, `opencode`, `codex`.  
Valid target names: `skills`, `commands`, `agents`.

### Canonical directory layout (no manifest needed)

```
~/.skul/library/
└── local/
    └── react-expert/
        ├── skills/
        │   └── react-patterns.md
        ├── commands/
        │   └── gen-component.md
        └── agents/
            └── component-reviewer.md
```

---

## How It Works

```
~/.skul/
├── library/           # cached bundle sources
│   └── <source>/
│       └── <bundle>/
└── registry.json      # repo intent + per-worktree materialization state
```

**Registry split:** the registry records two things independently:

1. **Repo-level desired state** — which bundles the repo wants.
2. **Worktree-level materialization** — which files were actually written in each worktree.

This means a freshly-created linked worktree shows the desired bundles in `skul status` without pretending the files already exist — then `skul apply` materializes them.

**Stealth mode:** Skul appends ignore rules to `.git/info/exclude` (never `.gitignore`) so materialized files remain invisible to Git without dirtying the repository.

**Conflict handling:** if a target file already exists and is not Skul-managed, you are prompted to rename the incoming file, apply a prefix, or skip it. In headless mode the default prefix is applied automatically.

---

## Agent and Scripting Use

Skul is designed to work inside autonomous AI agent pipelines without requiring user interaction.

### JSON output

Pass `--json` to `list` or `status` to get machine-readable output:

```bash
skul list --json
skul status --json
```

### Dry-run preview

Preview mutating commands before executing them:

```bash
skul add react-expert --dry-run
skul remove react-expert --dry-run
skul reset --dry-run
```

### Headless mode

Set `SKUL_NO_TUI=1` to suppress all interactive prompts. Operations that would require a prompt either apply a safe default (file conflicts) or fail immediately with a recovery hint (missing bundle name, modified managed file):

```bash
SKUL_NO_TUI=1 skul add react-expert
SKUL_NO_TUI=1 skul reset
```

**Error behavior in headless mode:**

| Scenario | Behavior |
|---|---|
| Bundle name omitted | Exits with error and hint to pass `<bundle>` explicitly |
| File conflict on add | Auto-applies default prefix (`_skul_`) |
| Modified managed file blocks removal | Exits with error and hint to run interactively |

---

## Safety Model

- **Stealth-only:** writes ignore rules to `.git/info/exclude` — no `.gitignore` edits, no Git config changes, no history mutations.
- **Registry-driven cleanup:** file removal uses registry-tracked paths, not filename pattern guessing.
- **Modified-file guard:** files you edited after materialization require explicit confirmation before removal (or fail fast in headless mode).
- **Dry-run on all mutating commands:** `add`, `remove`, and `reset` all support `--dry-run`.
- **Missing bundle recovery:** when a bundle name is not found, Skul lists the cached bundles it can see.
- **Corrupt registry guard:** a malformed `registry.json` stops execution immediately and tells you how to repair or remove it.

**Current limitations:**

- Tool-specific content transforms (front matter changes, `disable-model-invocation`, `agent.toml` generation) are not yet applied during cross-tool materialization.

---

## Development

```bash
pnpm install          # install dependencies
pnpm run typecheck    # type-check without emitting
pnpm run test         # run tests once
pnpm run build        # compile to dist/
pnpm run dev -- --help  # run CLI via tsx (use instead of a global skul)
```

### Project layout

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

## License

[ISC](LICENSE)
