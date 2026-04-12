# Skul — AI Configuration Bundle Manager for Claude Code, Cursor, Codex & OpenCode

Apply reusable AI bundles — skills, slash commands, and agents — into tool-native directories without committing them to Git. Skul fetches bundles from a GitHub repository, writes files where each tool expects them, and hides everything via `.git/info/exclude`.

[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-lightgrey)](LICENSE)

---

## Quick Start

```bash
# Fetch from a GitHub registry and apply (first use clones the repo)
skul add github.com/sjquant/ai-bundles react-expert

# Re-apply from cache — no network needed
skul add react-expert

# See what's cached
skul list

# Check materialization state
skul status

# Remove all Skul-managed files
skul reset
```

---

## Commands

| Command | Description |
|---|---|
| `skul add [source] <bundle>` | Fetch source (if remote) and materialize a bundle |
| `skul remove <bundle>` | Remove a bundle and delete its managed files |
| `skul apply` | Re-materialize all desired bundles in the current worktree |
| `skul list` | List cached bundles |
| `skul status` | Show desired state and materialization status |
| `skul reset` | Remove all Skul-managed files from the current worktree |

All mutating commands accept `--dry-run`. `skul list` and `skul status` accept `--json`.

For scripting and agent use, set `SKUL_NO_TUI=1` to suppress all interactive prompts.

---

## Supported Tools

| Tool | Skills | Commands | Agents |
|---|---|---|---|
| **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** | `.claude/skills` | `.claude/commands` | `.claude/agents` |
| **[Cursor](https://cursor.sh)** | `.cursor/skills` | `.cursor/commands` | `.cursor/agents` |
| **[OpenCode](https://opencode.ai)** | `.opencode/skills` | `.opencode/commands` | `.opencode/agents` |
| **[Codex](https://openai.com/index/openai-codex)** | `.agents/skills` | — | `.codex/agents` |

Use `--tool <name>` to target a single tool.

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

**Canonical** — `skills/`, `commands/`, `agents/` at the top level. Skul copies each directory to every tool that supports it.

**Native** — tool-specific dotdirs (`.claude/skills/`, `.cursor/commands/`, etc.) for content targeting a single tool only.

---

## How It Works

- **`~/.skul/library/`** — cached bundle sources (cloned Git repos or local directories)
- **`~/.skul/registry.json`** — repo-level desired state + per-worktree materialization records

The registry tracks two things separately: which bundles a repo *wants*, and which files were actually *written* in each worktree. A new linked worktree inherits the desired state immediately — run `skul apply` to materialize.

Skul writes ignore rules to `.git/info/exclude` only — never `.gitignore`, never Git history.

---

## Installation

```bash
git clone https://github.com/sjquant/skul
cd skul
pnpm install && pnpm run build
npm link
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
Two options: (1) create a GitHub repo with one subdirectory per bundle, each containing `skills/`, `commands/`, and/or `agents/` — users run `skul add github.com/your-org/ai-bundles <bundle>`; or (2) place `skills/`, `commands/`, and/or `agents/` directly at the repository root — users run `skul add github.com/your-org/my-bundle` (the bundle name is inferred from the repo slug). No `manifest.json` required.

**What happens if I edit a Skul-managed file?**
Skul fingerprints files on write. Edited files require explicit confirmation before removal, or fail fast with `SKUL_NO_TUI=1`.

**What happens to files after `git worktree remove`?**
Run `skul reset` before removing a worktree. If removed externally, the registry entry persists until cleared manually.

---

## License

[ISC](LICENSE)
