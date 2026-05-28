# Skul — AI Configuration Bundle Manager for AI Coding Tools

Apply reusable AI bundles — skills, slash commands, agents, and root instructions — into tool-native directories without committing them to Git. Skul fetches bundles from a GitHub repository, writes files where each tool expects them, and hides everything via `.git/info/exclude`.

[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-lightgrey)](LICENSE)

---

## Quick Start

```bash
# Fetch from a GitHub registry and materialize a bundle (first use clones the repo)
skul add github.com/sjquant/ai-bundles react-expert

# GitHub is the default registry — owner/repo shorthand works too
skul add acme/shared-bundles core --agent codex

# Re-apply from cache, no network needed
skul add react-expert

# See what's cached
skul list

# Check materialization state
skul status

# Remove a bundle and its managed files
skul remove react-expert

# Re-materialize all desired bundles (e.g. after cloning a fresh worktree)
skul apply
```

---

## Commands

| Command | Description |
|---|---|
| `skul add <source> [bundle]` | Fetch (when needed) and materialize a bundle from a source |
| `skul add <bundle>` | Materialize a uniquely named cached bundle |
| `skul list` | List cached bundles |
| `skul status` | Show desired state and materialization status |
| `skul remove <bundle>` | Remove a bundle and delete its managed files |
| `skul apply` | Re-materialize all desired bundles in the current worktree |

All mutating commands accept `--dry-run`. `skul list` and `skul status` accept `--json`. Bare `owner/repo` sources default to `github.com/owner/repo`. For scripting and agent use, set `SKUL_NO_TUI=1` to suppress all interactive prompts.

See [docs/advanced.md](docs/advanced.md) for maintenance, recovery, and cleanup commands (`check`, `update`, `sync`, `shadow`, `reset`, `clear-cache`, `prune`) and `add` power flags (`--ref`, `--pin`, `--ssh`, `--include`, `--select-items`).

---

## Supported Tools

| Tool | Skills | Commands | Agents | Root Instructions |
|---|---|---|---|---|
| **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** | `.claude/skills` | `.claude/commands` | `.claude/agents` | `CLAUDE.md` |
| **[Cursor](https://cursor.sh)** | `.cursor/skills` | `.cursor/commands` | `.cursor/agents` | `CLAUDE.md` |
| **[OpenCode](https://opencode.ai)** | `.opencode/skills` | `.opencode/commands` | `.opencode/agents` | `CLAUDE.md` |
| **[Codex](https://openai.com/index/openai-codex)** | `.agents/skills` | — | `.codex/agents` | `AGENTS.md` |
| **[GitHub Copilot](https://github.com/features/copilot)** | `.github/skills` | — | `.github/agents` | `.github/copilot-instructions.md` |
| **[Kiro](https://kiro.dev)** | `.kiro/skills` | — | `.kiro/agents` | `AGENTS.md` |

Use `--agent <name>` to target a single tool. Repeat the flag to target multiple tools.

---

## Bundle Structure

A bundle source is a GitHub repository. Skul clones it once into `~/.skul/library/` and reuses the cache for subsequent `add` calls. Two repository layouts are supported:

**Multi-bundle** — each subdirectory is its own bundle, identified by the directory name:

```
github.com/sjquant/ai-bundles
├── react-expert/
│   ├── skills/
│   ├── commands/
│   └── agents/
└── python-data/
    └── skills/
```

**Repo-as-bundle** — the repository root is a single bundle. No `manifest.json` is needed; Skul infers the tool targets from the directory structure. The bundle name defaults to the repository slug:

```
github.com/sjquant/react-bundle
├── skills/
└── commands/
```

Inside a bundle, two content layouts are supported:

**Canonical** — `skills/`, `commands/`, `agents/`, `AGENTS.md`, and `CLAUDE.md` at the top level. Skul copies each directory to every tool that supports it, and treats root instruction files as generic cross-tool sources.

**Native** — tool-specific dotdirs (`.claude/skills/`, `.cursor/commands/`, `.github/agents/`, `.kiro/skills/`, etc.) for content targeting a single tool only.

### Root Instruction Targets

Skul supports three root instruction target files:

| Target file | Native tools |
|---|---|
| `CLAUDE.md` | `claude-code`, `cursor`, `opencode` |
| `AGENTS.md` | `codex`, `kiro` |
| `.github/copilot-instructions.md` | `copilot` |

Root instruction bundles are compatible across those targets. If a bundle only ships `CLAUDE.md`, Skul can still materialize `AGENTS.md` for Codex or Kiro and `.github/copilot-instructions.md` for GitHub Copilot. If a bundle only ships `AGENTS.md` or `.github/copilot-instructions.md`, Skul can still materialize the equivalent target file for the other tools, as long as the instruction body can be reused as-is.

Examples:

```bash
# Bundle only provides CLAUDE.md, but Codex and Kiro still get AGENTS.md
skul add github.com/sjquant/ai-bundles repo-standards --agent codex
skul add github.com/sjquant/ai-bundles repo-standards --agent kiro

# Bundle only provides AGENTS.md, but Claude Code still gets CLAUDE.md
skul add github.com/sjquant/ai-bundles repo-standards --agent claude-code

# Bundle only provides AGENTS.md or CLAUDE.md, but Copilot still gets its native target
skul add github.com/sjquant/ai-bundles repo-standards --agent copilot
```

---

## How It Works

- **`~/.skul/library/`** — cached bundle sources (cloned Git repos or local directories)
- **`~/.skul/registry.json`** — repo-level desired state + per-worktree materialization records

The registry tracks two things separately: which bundles a repo *wants*, and which files were actually *written* in each worktree. A new linked worktree inherits the desired state immediately — run `skul apply` to materialize.

Skul writes ignore rules to `.git/info/exclude` only — never `.gitignore`, never Git history.

### Root Instruction Behavior

Skul uses two different workflows for root instruction files, depending on whether the target file is already tracked by Git.

**Untracked stealth**

- If the target root instruction file is not tracked, Skul materializes it like any other managed file and hides it through `.git/info/exclude`.
- If the file already existed locally, Skul preserves that pre-existing content as the base and appends bundle content inside explicit `BEGIN/END SKUL BUNDLE` markers.
- Multiple bundles can share the same untracked root instruction file. Skul recomposes the file in desired-state order and restores the preserved base content when the last contributing bundle is removed or `skul reset` runs.

Example:

```bash
skul add github.com/sjquant/ai-bundles repo-standards --agent codex

# Result: untracked AGENTS.md
# - hidden through .git/info/exclude
# - existing local AGENTS.md content preserved at the top, if present
# - bundle content appended inside SKUL bundle markers
```

**Tracked shadow**

- If the repo already tracks the target root instruction file, Skul does not use `.git/info/exclude`.
- Instead, Skul treats the worktree copy as generated output: it renders `HEAD:<path>` plus the bundle overlay, writes the effective file, and sets `git update-index --skip-worktree`.
- `skul status` reports tracked root instructions in a separate `Shadowed Instructions` section, including whether the base blob is current, whether the overlay still matches, whether `skip-worktree` is set, and whether manual edits are suspected.
- A tracked root instruction target has one active shadow owner at a time. Multi-bundle composition is supported for untracked root files, not for tracked shadows.

Example:

```bash
# Team policy is already committed in CLAUDE.md
skul add github.com/sjquant/ai-bundles claude-standards --agent claude-code

# Result: tracked CLAUDE.md
# - rendered as committed team base + SKUL shadow block
# - hidden from git status with skip-worktree
# - recorded in the worktree registry as a shadowed file
```

For tracked shadow lifecycle (`shadow --suspend`/`--refresh`, `sync`), safety limits, recovery flows, SSH cloning, and cache management, see [docs/advanced.md](docs/advanced.md).

---

## Installation

```bash
git clone https://github.com/sjquant/skul
cd skul
pnpm install && pnpm run build
pnpm link --global
```

**Requirements:** Node.js >=20, pnpm

---

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run dev -- --help
```

---

## FAQ

**Does Skul modify `.gitignore`?**
No. Ignore rules go to `.git/info/exclude` — a local, per-clone file that is never committed or pushed.

**How do I publish a bundle?**
Two options: (1) create a GitHub repo with one subdirectory per bundle, each containing `skills/`, `commands/`, and/or `agents/` — users run `skul add github.com/your-org/ai-bundles <bundle>`; or (2) place `skills/`, `commands/`, and/or `agents/` directly at the repository root — users run `skul add github.com/your-org/my-bundle`, and Skul uses the repo slug as the bundle name. No `manifest.json` required.

**What happens if I edit a Skul-managed file?**
Skul fingerprints files on write. Edited files require explicit confirmation before removal, or fail fast with `SKUL_NO_TUI=1`.

**How do I keep bundles up to date, customize cloning, or clean up?**
See [docs/advanced.md](docs/advanced.md) for `check`/`update`, tracked-shadow lifecycle (`shadow`, `sync`), SSH cloning, and cleanup commands (`reset`, `clear-cache`, `prune`).

---

## License

[ISC](LICENSE)
