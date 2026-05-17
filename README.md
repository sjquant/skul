# Skul — AI Configuration Bundle Manager for AI Coding Tools

Apply reusable AI bundles — skills, slash commands, agents, and root instructions — into tool-native directories without committing them to Git. Skul fetches bundles from a GitHub repository, writes files where each tool expects them, and hides everything via `.git/info/exclude`.

[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-lightgrey)](LICENSE)

---

## Quick Start

```bash
# Fetch from a GitHub registry and apply (first use clones the repo)
skul add github.com/sjquant/ai-bundles react-expert

# GitHub is also the default registry for owner/repo shorthand
skul add acme/shared-bundles core --agent codex

# Track a specific branch or tag
skul add github.com/sjquant/ai-bundles react-expert --ref stable

# Pin a bundle to an exact commit
skul add github.com/sjquant/ai-bundles react-expert --pin 2813b88

# Clone via SSH instead of HTTPS
skul add --ssh github.com/sjquant/ai-bundles react-expert

# git@ URLs are auto-detected as SSH
skul add git@github.com:sjquant/ai-bundles react-expert

# Re-apply from cache — no network needed
skul add react-expert

# Install only selected bundle items
skul add react-expert --agent codex --include skills/diagnose
skul add react-expert --agent codex --include agents/reviewer
skul add react-expert --agent codex --include root-instruction

# Choose bundle items interactively
skul add react-expert --agent codex --select-items

# See what's cached
skul list

# Limit the cache view to one source
skul list --source github.com/sjquant/ai-bundles

# Check materialization state
skul status

# Suspend tracked root-instruction shadows before a manual git update
skul shadow --suspend
git pull --ff-only
skul shadow --refresh

# Or let Skul wrap the fast-forward pull for tracked root instructions
skul sync

# See whether remote-backed bundles have updates
skul check

# Update remote-backed bundles to the latest upstream revision
skul update

# Remove all Skul-managed files
skul reset

# Clear a stale cached remote source so the next add reclones it
skul clear-cache acme/shared-bundles

# Clear all cached remote sources
skul clear-cache --all

# Remove stale registry entries for deleted worktrees or repos
skul prune
```

---

## Commands

| Command | Description |
|---|---|
| `skul add <bundle>` | Materialize a uniquely named cached bundle |
| `skul add <source>` | Fetch source when needed and select one of its bundles |
| `skul add <source> <bundle>` | Fetch source when needed and materialize a specific bundle |
| `skul remove <bundle>` | Remove a bundle and delete its managed files |
| `skul apply` | Re-materialize all desired bundles in the current worktree |
| `skul list` | List cached bundles |
| `skul status` | Show desired state and materialization status |
| `skul check [bundle]` | Check remote-backed bundles for upstream updates |
| `skul update [bundle]` | Update remote-backed bundles to the latest upstream revision |
| `skul prune` | Remove stale registry entries for deleted worktrees and orphaned repos |
| `skul shadow --suspend \| --refresh` | Restore or rebuild tracked root-instruction shadows |
| `skul sync` | Run `git pull --ff-only` with tracked root-instruction shadow suspend/refresh |
| `skul reset` | Remove all Skul-managed files from the current worktree |
| `skul clear-cache [source] --all` | Remove one cached source or all cached remote sources from the global library |

All mutating commands accept `--dry-run`. `skul list`, `skul status`, and `skul check` accept `--json`.

`skul add` accepts `--ssh` to clone via SSH. `git@host:owner/repo` URLs are auto-detected as SSH. Bare `owner/repo` sources default to `github.com/owner/repo`. Use `--ref` to follow a non-default branch or tag, or `--pin` to lock a bundle to one commit. The chosen protocol is persisted in the registry and reused by `skul apply`.

`skul add` accepts `--include <item>` to install only specific bundle items. Repeat it to include multiple items. Supported selectors are `skills/<name>`, `commands/<name>`, `agents/<name>`, and `root-instruction`; `AGENTS.md` and `CLAUDE.md` are accepted aliases for `root-instruction`. Use `--select-items` to open an interactive bundle-item picker. If `--include` and `--select-items` are used together, the included items are preselected in the picker.

For scripting and agent use, set `SKUL_NO_TUI=1` to suppress all interactive prompts.

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

### Git Update Workflow

Tracked root-instruction shadows need an explicit suspend/refresh cycle around Git updates, because `skip-worktree` does not make upstream changes disappear.

Use `skul shadow --suspend` when you want to run your own Git command:

```bash
skul shadow --suspend
git pull --ff-only
skul shadow --refresh
```

- `skul shadow --suspend` restores tracked root instruction files from `HEAD` and clears `skip-worktree`.
- `skul shadow --refresh` rebuilds the effective files from the latest `HEAD` content plus the stored overlay and then re-enables `skip-worktree`.
- The manual suspend/refresh flow assumes the root instruction file is still tracked after your Git update. If upstream removed the target file, plain `skul shadow --refresh` will fail because there is no longer any `HEAD` content to rebuild from. For `git pull --ff-only`, prefer `skul sync`, because it can retire shadow entries automatically when upstream stops tracking the file. Manual suspend/pull/refresh does not currently provide the same retirement path.

Use `skul sync` when `git pull --ff-only` is the update you want:

```bash
skul sync
```

- `skul sync` runs the same suspend/refresh lifecycle automatically around `git pull --ff-only`.
- If the pull fails, Skul restores the tracked shadows before returning the error.
- If upstream stops tracking a shadowed root instruction file, Skul retires that shadow and removes the local generated file.

### Safety Limits And Recovery

- Skul refuses to create or refresh a tracked shadow if the target root instruction file has staged changes, unstaged changes, unmerged index entries, or incompatible index flags such as `assume-unchanged`.
- Skul treats tracked shadow output as disposable generated content. Manual edits inside the effective file are not source of truth, and today they are a real safety limitation: follow-up commands such as `skul shadow --refresh`, `skul update`, `skul remove`, or `skul reset` may intentionally refuse to proceed once the rendered file no longer matches Skul's recorded fingerprint.
- `skul reset` is the cleanup command for intact Skul-managed state. For tracked root instructions whose local shadow file still exists and still matches Skul's recorded render, it restores the committed `HEAD` version and clears `skip-worktree`. For untracked shared root instructions it restores the preserved local base content.
- `skul status` is the inspection command. When it reports stale base or overlay state or missing `skip-worktree`, use `skul shadow --suspend` before your Git update and `skul shadow --refresh` after it, as long as the root instruction file still exists in `HEAD`. When a fast-forward pull might stop tracking the file upstream, prefer `skul sync`, because it can retire the shadow automatically. Treat `Manual edits: suspected` as a limitation warning, not as a supported suspend/refresh recovery workflow.

### Cloning: HTTPS vs SSH

By default Skul clones bundle sources over HTTPS. To use SSH, either pass `--ssh` or supply a `git@` URL — both are equivalent:

```bash
skul add --ssh github.com/sjquant/ai-bundles react-expert
skul add git@github.com:sjquant/ai-bundles react-expert
```

The protocol choice is stored in the registry alongside the bundle entry. When `skul apply` re-clones a source in a new worktree it uses the same protocol automatically — no need to repeat `--ssh`.

If SSH authentication fails (missing key, wrong host, etc.) Skul prints a hint pointing to the HTTPS equivalent command.

### Clearing a Cached Source

If a cached remote source becomes stale or corrupted, remove it from `~/.skul/library` and let the next `skul add` re-clone it:

```bash
skul clear-cache acme/shared-bundles
skul add acme/shared-bundles core --agent codex
```

To wipe the entire cache:

```bash
skul clear-cache --all
```

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

**What happens if I edit a tracked shadowed root instruction directly?**
Skul treats tracked root-instruction shadows as generated output. `skul status` will usually report `Manual edits: suspected`, and follow-up commands may refuse to refresh, remove, or reset that shadowed file once the rendered output no longer matches Skul's recorded fingerprint. This is a current limitation of tracked shadow mode, so the safe practice is to avoid manual edits to shadowed root instruction files.

**When should I use `skul shadow --suspend`, `skul shadow --refresh`, or `skul sync`?**
Use `skul shadow --suspend` before a manual Git update that touches tracked root instruction files. Use `skul shadow --refresh` after that update only when the root instruction file is still tracked in the new `HEAD` and the local shadow state is still intact. Use `skul sync` when a fast-forward pull is all you need, because it wraps both steps around `git pull --ff-only` and can retire shadows automatically if upstream stops tracking the file.

**Can I use SSH to clone bundle sources?**
Yes. Pass `--ssh` to `skul add`, or use a `git@host:owner/repo` URL — Skul auto-detects it as SSH. The protocol is saved in the registry and reused by `skul apply`. If SSH auth fails, Skul shows a hint with the HTTPS equivalent.

**What happens to files after `git worktree remove`?**
Run `skul reset` before removing a worktree. If removed externally, the registry entry persists until cleared manually.

---

## License

[ISC](LICENSE)
