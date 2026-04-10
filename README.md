# Skul — CLI to Manage AI Configuration Bundles for Claude Code, Cursor, Codex & OpenCode

Skul is an open-source command-line tool that applies reusable **AI configuration bundles** — skills, slash commands, and agents — into the tool-native folders that Claude Code, Cursor, OpenCode, and Codex expect, without committing those files to Git.

It keeps your AI coding assistant configuration **portable across projects and Git worktrees** while staying completely invisible to version control.

[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-lightgrey)](LICENSE)

---

## Features

- **Remote-first** — point `skul add` at any public GitHub repo and bundles are fetched, cached, and applied in one step
- **One command to apply** — `skul add github.com/user/ai-vault react-expert` writes skills, commands, and agents to every supported tool at once
- **Git-invisible by design** — uses `.git/info/exclude`, never `.gitignore`; zero repo pollution
- **Multi-tool materialization** — a single bundle fans out to Claude Code, Cursor, OpenCode, and Codex simultaneously
- **Worktree-aware** — repo intent carries across linked worktrees; `skul apply` re-materializes after `git worktree add`
- **Safe removal** — registry-tracked paths, modified-file guard, and `--dry-run` on every mutating command
- **CI and agent ready** — `SKUL_NO_TUI=1` suppresses all prompts; `--json` output for scripting pipelines
- **No committed files** — nothing Skul writes ever needs to be staged or pushed

---

## The Problem

AI coding tools like Claude Code, Cursor, and Codex load context from project-local directories:

```
.claude/skills/       ← Claude Code skills
.claude/commands/     ← Claude Code slash commands
.cursor/rules/        ← Cursor rules
.codex/agents/        ← Codex agents
```

Managing these manually means one of two bad options:

| Approach | Problem |
|---|---|
| Commit the files | Pollutes the repo with personal AI config; causes conflicts across teammates |
| Add to `.gitignore` | Leaks into every fork and clone; requires manual re-applying on each new worktree |
| Copy-paste per project | No single source of truth; edits never sync back |

**Skul eliminates all three problems.** It keeps a local library of bundles, injects on demand, tracks what it owns, and hides everything through `.git/info/exclude`.

---

## Demo

Point `skul add` at a GitHub repository and a bundle name. Skul fetches the repo into its local cache and materializes the files immediately — no manual cloning, no local setup required.

```
$ skul add github.com/sjquant/ai-bundles react-expert

Applied react-expert for claude-code, cursor
```

Subsequent runs use the local cache, so subsequent `add` calls are instant:

```
$ skul add react-expert

Applied react-expert for claude-code, cursor
```

```
$ skul list

Available Bundles

react-expert (claude-code, cursor)   [github.com/sjquant/ai-bundles]
python-data  (claude-code, opencode, codex)   [github.com/sjquant/ai-bundles]
go-backend   (claude-code, cursor, codex)   [github.com/sjquant/ai-bundles]
```

```
$ skul status

Repository Desired State
Bundle: react-expert

Current Worktree
Path: /home/user/my-app
Materialized: yes

Files:
  Bundle: react-expert
    Tool: claude-code
      .claude/skills/react-patterns.md
      .claude/commands/gen-component.md
      .claude/agents/component-reviewer.md
    Tool: cursor
      .cursor/skills/react-patterns.md
      .cursor/commands/gen-component.md

Git Exclude:
  configured
```

```
$ git status
On branch main
nothing to commit, working tree clean
```

The materialized files are present on disk but completely invisible to Git.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Supported AI Tools](#supported-ai-tools)
- [Bundle Structure](#bundle-structure)
- [How Skul Works](#how-skul-works)
- [Use Cases](#use-cases)
- [Use in AI Agents and CI Scripts](#use-in-ai-agents-and-ci-scripts)
- [Safety and Non-Destructive Design](#safety-and-non-destructive-design)
- [Development](#development)
- [Contributing](#contributing)
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

The recommended way to use Skul is to point it at a GitHub repository that hosts your bundle collection. Skul fetches and caches the source on first use.

```bash
# Apply a bundle directly from a GitHub repository (fetches automatically)
skul add github.com/sjquant/ai-bundles react-expert

# Subsequent adds use the local cache — no network required
skul add python-data

# See all cached bundles and their sources
skul list

# Check what has been materialized in the current worktree
skul status

# Remove all Skul-managed files from the current worktree
skul reset
```

---

## Commands

### `skul add` — Apply an AI configuration bundle

Adds a bundle to the project's active set and writes its files into tool-native directories.

Pass a GitHub (or any remote Git) source to fetch and cache the bundle in one step — no prior setup needed.

```bash
# Recommended: fetch from a remote source and apply
skul add github.com/user/ai-vault react-expert

# Re-apply from the local cache (source already fetched before)
skul add react-expert

# Apply to a single tool only
skul add github.com/user/ai-vault react-expert --tool claude-code

# Preview without writing any files
skul add github.com/user/ai-vault react-expert --dry-run
```

| Argument / Option | Description |
|---|---|
| `[source]` | Remote bundle source (e.g. `github.com/user/ai-vault`). Fetched and cached on first use. Defaults to local cache when omitted. |
| `[bundle]` | Bundle name within the source. Prompted interactively if omitted; required in headless mode. |
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

### `skul apply` — Re-materialize bundles into a new worktree

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

### `skul status` — Check current materialization state

Shows the project's desired bundle set and each bundle's materialization state for the current worktree.

```bash
skul status
skul status --json
```

---

### `skul reset` — Remove all managed AI config files

Removes every Skul-managed file from the current worktree and clears the worktree's materialization state.

```bash
skul reset
skul reset --dry-run
```

---

## Supported AI Tools

Skul materializes bundles for any combination of the following tools. Each tool has its own native directory layout that Skul resolves automatically.

| Tool | Skills | Commands | Agents |
|---|---|---|---|
| **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** | `.claude/skills` | `.claude/commands` | `.claude/agents` |
| **[Cursor](https://cursor.sh)** | `.cursor/skills` | `.cursor/commands` | `.cursor/agents` |
| **[OpenCode](https://opencode.ai)** | `.opencode/skills` | `.opencode/commands` | `.opencode/agents` |
| **[Codex](https://openai.com/index/openai-codex)** | `.agents/skills` | — | `.codex/agents` |

Use `--tool <name>` with `skul add` to target a single tool instead of all of them.

---

## Bundle Structure

### Recommended: Remote Git repository as a bundle registry

The simplest way to manage and share bundles is to keep them in a GitHub repository. Each subdirectory at the root of the repo is a bundle. Skul fetches and caches the entire repo when you first reference it.

```
github.com/sjquant/ai-bundles   ← the source (a GitHub repo)
├── react-expert/
│   ├── skills/
│   │   └── react-patterns.md
│   ├── commands/
│   │   └── gen-component.md
│   └── agents/
│       └── component-reviewer.md
├── python-data/
│   └── skills/
│       └── pandas-patterns.md
└── go-backend/
    └── skills/
        └── go-patterns.md
```

```bash
skul add github.com/sjquant/ai-bundles react-expert
skul add github.com/sjquant/ai-bundles python-data
```

The repo is cloned once into `~/.skul/library/github.com/sjquant/ai-bundles/` and reused for all subsequent `add` calls. Pass the source again to refresh from the remote.

---

Bundles (whether remote or local) are stored under `~/.skul/library/<source>/<bundle-name>/`. Three directory layouts are supported inside a bundle:

### Layout 1 — Canonical (recommended)

Top-level `skills/`, `commands/`, and/or `agents/` directories. Skul copies each to every tool that supports the target type — write once, deploy everywhere.

```
react-expert/
├── skills/
│   └── react-patterns.md
├── commands/
│   └── gen-component.md
└── agents/
    └── component-reviewer.md
```

### Layout 2 — Native

Tool-native dotdirs for content that should go to a specific tool only.

```
react-expert/
├── .claude/
│   └── skills/
│       └── react-patterns.md
└── .cursor/
    └── commands/
        └── gen-component.md
```

### Layout 3 — Explicit `manifest.json`

Override path resolution for any tool/target combination.

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

**`manifest.json` fields:**

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Bundle identifier (must match the directory name). |
| `tools` | `object` | Map of tool name → target name → `{ path }`. |
| `tools.<tool>.<target>.path` | `string` | Relative path inside the bundle directory. |

Valid tool names: `claude-code`, `cursor`, `opencode`, `codex`.  
Valid target names: `skills`, `commands`, `agents`.

---

## How Skul Works

Skul stores all state under `~/.skul/`:

```
~/.skul/
├── library/              # cached bundle sources
│   └── <source>/
│       └── <bundle>/
└── registry.json         # desired state + per-worktree materialization records
```

**Two-level registry** — the registry tracks two things independently:

- **Repo-level desired state** — which bundles this repository wants (shared across all worktrees).
- **Worktree-level materialization** — which files were actually written in each worktree.

A freshly-created linked worktree sees the desired bundles in `skul status` (the repo wants them) without claiming they're already materialized. Run `skul apply` to bring a new worktree up to date.

**Git stealth mode** — Skul appends rules to `.git/info/exclude`, the per-repo non-committed ignore file. Materialized AI config files stay invisible to Git without modifying `.gitignore` or leaving any trace in the repo history.

**Conflict handling** — if a target path already exists and is not Skul-managed, you choose: rename the incoming file, apply a prefix, or skip. In headless mode the default prefix (`_skul_`) is applied automatically.

---

## Use Cases

### Share a curated AI skill set across every project

Publish a `react-expert` bundle to a GitHub repo once — skills, commands, and agents all in one place. Run `skul add github.com/your-org/ai-bundles react-expert` in any repo on any machine. Every tool gets the right files; nothing touches Git. Update the GitHub repo and all teammates get the new version on their next `skul add`.

### Bootstrap a new Git worktree in one command

Add a worktree for a new feature branch with `git worktree add`. The new worktree sees your configured bundles in `skul status`. Run `skul apply` and all files are materialized immediately — no copy-paste, no re-adding anything.

### Run as part of an autonomous AI agent pipeline

An AI agent clones a repo, sets up the working environment, and runs `SKUL_NO_TUI=1 skul apply` to inject the project's configured AI context into the right tool directories. No user interaction needed. Exit codes and JSON output make it scriptable.

### Keep personal AI configuration out of shared repos

Teammates can commit their own code without your `.claude/skills/` and `.cursor/commands/` showing up in `git status`. Skul-managed files are per-developer, per-machine — never pushed, never conflicting.

### Quickly switch AI context between client projects

Maintain separate bundles for different domains — `python-data`, `go-backend`, `react-frontend`. Use `skul remove` and `skul add` to swap the active skill set when switching projects.

---

## Use in AI Agents and CI Scripts

Skul is designed for non-interactive use in autonomous AI agent pipelines and CI environments.

### Machine-readable JSON output

```bash
skul list --json
skul status --json
```

Example `skul status --json` output:

```json
{
  "repo": {
    "desired_state": [
      { "bundle": "react-expert" }
    ]
  },
  "worktree": {
    "path": "/home/user/my-app",
    "materialized": true,
    "bundles": {
      "react-expert": {
        "tools": {
          "claude-code": {
            "files": [
              ".claude/skills/react-patterns.md",
              ".claude/commands/gen-component.md"
            ]
          }
        }
      }
    },
    "git_exclude_configured": true
  }
}
```

### Dry-run before mutating

```bash
skul add react-expert --dry-run
skul remove react-expert --dry-run
skul reset --dry-run
```

### Headless mode (suppress all interactive prompts)

```bash
SKUL_NO_TUI=1 skul add react-expert
SKUL_NO_TUI=1 skul apply
SKUL_NO_TUI=1 skul reset
```

| Headless scenario | Behavior |
|---|---|
| Bundle name omitted | Exits with error — hint: pass `<bundle>` explicitly |
| File conflict on `add` | Auto-applies default prefix (`_skul_`) |
| Modified managed file blocks removal | Exits with error — hint: run interactively to confirm |

---

## Safety and Non-Destructive Design

- **No `.gitignore` edits** — ignore rules go to `.git/info/exclude` only; nothing touches the committed ignore file.
- **No Git config or history changes** — Skul never modifies commits, refs, branches, or Git config.
- **Registry-driven cleanup** — file removal uses registry-tracked absolute paths, not filename guessing.
- **Modified-file guard** — files you edit after materialization require explicit confirmation before removal, or fail fast in headless mode.
- **`--dry-run` on all mutating commands** — preview every change before it happens with `add`, `remove`, and `reset`.
- **Missing bundle recovery** — when a bundle isn't found, Skul lists the cached bundle names it can see.
- **Corrupt registry guard** — a malformed `~/.skul/registry.json` halts execution immediately and tells you how to repair or remove it.

**Current limitations:**
- Cross-tool content transforms (front matter, `disable-model-invocation`, `agent.toml` generation) are not yet applied during materialization.

---

## Development

```bash
pnpm install            # install dependencies
pnpm run typecheck      # type-check without emitting
pnpm run test           # run tests once
pnpm run build          # compile to dist/
pnpm run dev -- --help  # run CLI via tsx (use instead of a global `skul`)
```

### Source layout

```
src/
  index.ts                  # CLI entrypoint and command dispatch
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

## Contributing

1. Fork the repo and create a feature branch.
2. Run `pnpm run typecheck && pnpm run test` to verify your changes.
3. Keep each commit focused — one logical change per commit.
4. Open a pull request with a clear description of what changed and why.

Bug reports, feature requests, and bundle format proposals are welcome as GitHub Issues.

---

## FAQ

**Does Skul modify `.gitignore`?**  
No. Skul writes only to `.git/info/exclude`, which is never committed and never appears in `git diff` or `git status`.

**Will Skul files show up when I push to GitHub?**  
No. `.git/info/exclude` is a local, per-clone file. It is never pushed. No Skul-managed file will appear in a pull request or remote branch.

**What happens to materialized files after `git worktree remove`?**  
The registry tracks files per worktree path. Run `skul reset` in the worktree before removing it. If the worktree is removed externally the registry entry persists until manually cleared.

**Can I use Skul in a CI/CD pipeline or Docker build?**  
Yes. Set `SKUL_NO_TUI=1` for non-interactive operation and use `--json` to parse output programmatically.

**Can multiple worktrees use different bundles?**  
Repo-level desired state is shared across all worktrees for the same repo. Per-worktree materialization is tracked independently. Worktree-specific bundle overrides are not yet supported.

**How does Skul differ from committing `.claude/` or `.cursor/` to the repo?**  
Committed config files are shared with every teammate and every fork. Skul config is personal, per-machine, and per-developer. It never enters the repo's Git history.

**How does Skul differ from adding `.claude/` to `.gitignore`?**  
`.gitignore` is committed and cloned with the repo — it propagates to every fork and teammate. `.git/info/exclude` is local to the current clone only. Skul also tracks which files it owns, so cleanup is always one command.

**What file types can a bundle contain?**  
Any files — Skul copies them as-is. Typical content includes Markdown skill definitions, YAML agent configs, TOML configuration files, and slash-command Markdown files.

**How do I create and publish my own bundle library?**  
Create a GitHub repository with one subdirectory per bundle, each containing `skills/`, `commands/`, and/or `agents/` folders. Teammates (and you) can then apply bundles directly:
```bash
skul add github.com/your-org/ai-bundles react-expert
```
For local-only bundles during authoring, create a directory at `~/.skul/library/local/<bundle-name>/` and run `skul add <bundle-name>`.

**Can I share a bundle library with my team?**  
Yes — a GitHub repository is the recommended way. Any team member runs `skul add github.com/your-org/ai-bundles <bundle-name>`. Skul fetches the repo on first use and caches it locally.

**What happens if I edit a Skul-managed file?**  
Skul stores a SHA-256 fingerprint of each file at materialization time. If the file has changed, `skul remove` and `skul reset` prompt for confirmation before deleting it. In headless mode the operation fails with a clear error.

**Does Skul work with monorepos or workspaces?**  
Yes. Each directory that contains a `.git` folder (or is a linked worktree) is treated as an independent worktree. Run Skul commands from the root of the worktree you want to manage.

---

## License

[ISC](LICENSE)
