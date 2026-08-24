# Skul — AI Configuration Bundle Manager for AI Coding Tools

Apply reusable AI bundles — skills, slash commands, agents, and root instructions — into tool-native directories without committing them to Git. Skul fetches bundles from a GitHub repository, writes files where each tool expects them, and hides everything via `.git/info/exclude`.

Including `AGENTS.md` and `CLAUDE.md`: Skul can layer your personal instructions on top of a team-committed `AGENTS.md` (or `CLAUDE.md`) without dirtying the working tree, and can materialize the equivalent file for every supported tool from a single bundle source.

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

# Overlay your personal AGENTS.md / CLAUDE.md on top of the repo's tracked
# version — without showing up in git status
skul add acme/personal-instructions --agent codex

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

All mutating commands accept `--dry-run`. `skul add <source> --all` installs every bundle from a source, and `skul remove --all` removes every active bundle. `skul add`, `skul remove`, `skul apply`, `skul update`, and `skul reset` accept `-y, --yes` to auto-approve overwrite/removal confirmations. `skul list` and `skul status` accept `--json`. Bare `owner/repo` sources default to `github.com/owner/repo`. For scripting and agent use, set `SKUL_NO_TUI=1` to suppress all interactive prompts.

See [docs/advanced.md](docs/advanced.md) for maintenance, recovery, and cleanup commands (`check`, `update`, `sync`, `shadow`, `reset`).

---

## `skul add`

```text
skul add [options] [source] [bundle]
```

`source` is a GitHub registry like `github.com/owner/repo`, the `owner/repo` shorthand, or a `git@github.com:owner/repo` SSH URL. `bundle` is the bundle name; omit it when the source is a single-bundle repo or when you want the interactive picker.

| Option | Description |
|---|---|
| `-a, --agent <name>` | Materialize for one tool only. Repeat to target multiple tools. Defaults to every tool the bundle ships content for. |
| `--ref <selector>` | Track a specific branch, tag, or commit instead of remote `HEAD`. Persisted in the registry and reused by `skul apply`. |
| `--include <item>` | Install only a specific bundle item. Repeat for multiple. Selectors: `skills/<name>`, `commands/<name>`, `agents/<name>`, `root-instruction` (`AGENTS.md` / `CLAUDE.md` also accepted), `mcp`. |
| `--select-items` | Open an interactive picker for bundle items. When combined with `--include`, the included items are preselected. |
| `--all` | Install every bundle from the source. Requires a source and cannot be combined with a bundle name. |
| `-s, --ssh` | Clone the source via SSH instead of HTTPS. `git@host:owner/repo` URLs are auto-detected as SSH. Protocol is persisted and reused by `skul apply`. |
| `-g, --global` | Install to global tool config under `~/` instead of the current worktree. |
| `--root-instruction-mode <mode>` | Choose how root instructions are composed: `append` (default) or `replace`. Applies in project and global modes. |
| `-y, --yes` | Install without interactive confirmation prompts. Selects all available agents and auto-approves overwrite/replacement confirmations. Also available on `remove`, `apply`, `update`, and `reset` for confirmation prompts. |
| `-n, --dry-run` | Preview what would be written without making any changes. |

### Examples

```bash
# Track a branch or tag instead of HEAD
skul add github.com/sjquant/ai-bundles react-expert --ref stable

# Track an exact commit
skul add github.com/sjquant/ai-bundles react-expert --ref 2813b88

# Install only the diagnose skill, for Codex only
skul add react-expert --agent codex --include skills/diagnose

# Install only the bundle's root instruction
skul add react-expert --agent codex --include root-instruction

# Pick items interactively
skul add react-expert --agent codex --select-items

# Clone over SSH
skul add --ssh github.com/sjquant/ai-bundles react-expert
skul add git@github.com:sjquant/ai-bundles react-expert
```

If SSH authentication fails, Skul prints a hint with the HTTPS equivalent command.

---

## Supported Tools

| Tool | Skills | Commands | Agents | Root Instructions | MCP Servers |
|---|---|---|---|---|---|
| **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** | `.claude/skills` | `.claude/commands` | `.claude/agents` | `CLAUDE.md` | `.mcp.json` |
| **[Cursor](https://cursor.sh)** | `.cursor/skills` | `.cursor/commands` | `.cursor/agents` | `AGENTS.md` | `.cursor/mcp.json` |
| **[OpenCode](https://opencode.ai)** | `.opencode/skills` | `.opencode/commands` | `.opencode/agents` | `AGENTS.md` | `opencode.json` |
| **[Codex](https://openai.com/index/openai-codex)** | `.agents/skills` | — | `.codex/agents` | `AGENTS.md` | `.codex/config.toml` |
| **[GitHub Copilot](https://github.com/features/copilot)** | `.github/skills` | — | `.github/agents` | `.github/copilot-instructions.md` | `.vscode/mcp.json` |
| **[Kiro](https://kiro.dev)** | `.kiro/skills` | — | `.kiro/agents` | `AGENTS.md` | `.kiro/settings/mcp.json` |
| **[Antigravity CLI](https://antigravity.google/)** | `.agents/skills` | `.agent/workflows` | `.agents/agents` | `AGENTS.md` | `.agents/mcp_config.json` |

Use `--agent <name>` to target a single tool. Repeat the flag to target multiple tools.

For global Antigravity CLI materialization, Skul uses `~/.gemini/antigravity-cli/skills`, `~/.gemini/config/agents`, and `~/.gemini/GEMINI.md`. Globally, MCP servers go to each tool's own user-scope configuration: `~/.claude.json`, `~/.cursor/mcp.json`, `~/.config/opencode/opencode.json`, `~/.codex/config.toml`, `~/.kiro/settings/mcp.json`, and `~/.gemini/config/mcp_config.json`. Copilot is skipped with a note: VS Code keeps its user `mcp.json` in the profile folder, which has no home-relative path.

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

An optional `manifest.json` can add metadata without repeating inferred tool targets. For example:

```json
{
  "root_instruction_mode": "replace"
}
```

When `tools` is present, declared tools are the selection boundary: inferred non-root targets for those tools are retained, while explicit targets override them. Root-instruction targets must be declared explicitly in that mode so stale filesystem files cannot reappear after an update. In a multi-bundle repository, a bundle directory manifest takes precedence over repository-root metadata. Bundle identity remains the directory name (or repository slug for repo-as-bundle); `name` is display metadata only.

In a multi-bundle repository, the repository-root manifest supplies metadata defaults such as `root_instruction_mode` to child bundles, and a child manifest overrides those defaults. Repository-root `tools` declarations are used for repo-as-bundle layouts; child directories define their own tool targets in multi-bundle layouts.

In a multi-bundle repository, root-level `AGENTS.md` and `CLAUDE.md` are not treated as bundle content. Skul emits one warning with guidance to move shared instructions into `bundles/common/`; child bundle instructions continue to be discovered and composed normally. A repository with no named child bundles remains a repo-as-bundle, so its root instruction files are preserved and inferred as bundle content.

Inside a bundle, two content layouts are supported:

**Canonical** — `skills/`, `commands/`, `agents/`, `AGENTS.md`, and `CLAUDE.md` at the top level. Skul copies each directory to every tool that supports it, and treats root instruction files as generic cross-tool sources.

**Native** — tool-specific dotdirs (`.claude/skills/`, `.cursor/commands/`, `.github/agents/`, `.kiro/skills/`, etc.) for content targeting a single tool only.

### MCP Servers

A bundle can declare MCP servers in an `mcp.json` at the bundle root, using the [Agent Plugins](https://agent-plugins.org/specification) schema:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "docs": {
      "type": "stdio",
      "command": "docs-server",
      "args": ["--root", "${PLUGIN_ROOT}/reference"],
      "env": { "CACHE_DIR": "${PLUGIN_DATA}/cache" }
    },
    "remote": {
      "type": "streamable-http",
      "url": "https://example.com/mcp"
    }
  }
}
```

Skul translates this into each tool's own MCP configuration file and dialect — the top-level key (`mcpServers`, `servers`, or `mcp`) and the transport spelling. `streamable-http` becomes `http` for Claude Code and Copilot; Cursor and Kiro infer the transport from `url` and get no `type`; Antigravity infers it too but names the endpoint `serverUrl`, the only spelling it accepts; OpenCode uses `local`/`remote` and folds `command` and `args` into one array; Codex uses TOML `[mcp_servers.<name>]` tables with `http_headers`. Select it as a bundle item with `--include mcp`.

`${PLUGIN_ROOT}` expands to the bundle's directory in `~/.skul/library/`, and `${PLUGIN_DATA}` to a per-bundle directory under `~/.skul/data/`. Both are substituted in `args`, `env` values, and `cwd`; `command` is left verbatim so it stays a single executable token. Skul resolves the data directory but does not create it.

Skul merges into these files rather than owning them. It tracks the server names it wrote, so anything else in the file survives — your own hand-written servers, another bundle's servers, and unrelated settings sharing the document such as OpenCode's `model` and `theme`. `skul remove` subtracts only the names that bundle added, and deletes the file only if Skul created it and nothing else is left in it; a file that was already there is kept.

A server name Skul does not own is never replaced: if the file already declares one the bundle also declares, `skul add` refuses and names the file. All of a bundle's MCP files are resolved before the first one is written, so a refusal for one tool leaves none of the others behind.

While a bundle's servers are merged into a file, that path is added to the Git exclude block even when Skul did not create the file, because it now carries absolute paths from the machine it was materialized on. Removing the bundle takes the servers back out and the path leaves the block with them.

Codex's `.codex/config.toml` is edited as a marker-delimited block appended at the end, because re-serializing TOML would discard the comments and formatting of a hand-maintained config. Everything outside the block stays byte-for-byte identical:

```toml
# your own settings, untouched
model = "gpt-5"   # inline comment

# >>> SKUL:MCP BEGIN — managed by skul, do not edit
[mcp_servers.docs]
command = "docs-server"
# <<< SKUL:MCP END
```

Because two TOML tables of the same name make the whole config unparseable, Skul refuses rather than writing a `[mcp_servers.<name>]` that you already declare elsewhere in the file, however it is spelled — `[mcp_servers.docs]`, `[mcp_servers."docs"]`, or a sub-table such as `[mcp_servers.docs.env]`.

If the target file is **tracked by Git** — as `opencode.json` or `.codex/config.toml` often are — Skul creates a tracked shadow instead of a visible diff, the same mechanism root instructions use. The servers are on disk for the tool to read, `git status` stays clean, and `skul shadow --suspend` / `--refresh` bracket Git operations that move `HEAD`. A refresh replays the bundle's servers onto the new committed content, so an upstream change to the file is picked up rather than overwritten.

Only one bundle may shadow a given tracked file — a shadow renders that bundle's servers onto the committed content, so a second bundle would silently replace the first's, and Skul refuses instead. (Untracked files have no such limit; any number of bundles merge into them.)

`skul add --global` merges MCP servers into each tool's user-scope configuration — `~/.claude.json` (Claude Code), `~/.cursor/mcp.json`, `~/.config/opencode/opencode.json`, `~/.codex/config.toml`, `~/.kiro/settings/mcp.json`, and `~/.gemini/config/mcp_config.json` (Antigravity) — using the same dialect and merge rules as a project install. Copilot has no such path. VS Code — the surface Skul's `copilot` targets, via `.vscode/mcp.json` — keeps its user `mcp.json` in the profile folder, whose location differs per platform and per profile. The home-relative `~/.copilot/mcp-config.json` that VS Code also documents belongs to the Copilot CLI's Agent Host, a separate product Skul does not model, so a global install drops Copilot's servers and says so rather than writing them somewhere the user did not ask for.

`~/.claude.json` is one Claude Code rewrites while it runs. Skul reads it, merges, and replaces it in one atomic rename, so it never leaves a half-written file — but a running session that writes between the read and the rename loses that write. Run `skul add --global`, `skul remove --global`, and `skul reset --global` with Claude Code closed.

As with other content, a bundle can instead pre-author a single tool's MCP file natively (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.kiro/settings/mcp.json`, `.agents/mcp_config.json`, `opencode.json`, `.codex/config.toml`), which scopes those servers to that tool alone.

### Cross-Repo Bundle Item References

Instead of copying an item from another repository into your bundle, you can reference it. Add `skul.refs.json` at the bundle root:

```json
{
  "refs": [
    {
      "target": "skills",
      "name": "insane-search",
      "source": "fivetaku/insane-search"
    },
    {
      "target": "root-instruction",
      "path": "AGENTS.md",
      "source": "fivetaku/standards"
    }
  ]
}
```

| Ref field | Required | Description |
|---|---|---|
| `target` | yes | Local item target: `skills`, `agents`, `commands`, or `root-instruction`. |
| `name` | for `skills`, `agents`, `commands` | Local item name materialized from this ref. |
| `path` | no | Root instruction refs only. Optional local root instruction path, such as `AGENTS.md`. |
| `source` | yes | The referenced repo, in any form `skul add` accepts. |
| `bundle` | when ambiguous | The bundle name inside `source`. When omitted, Skul selects the only bundle containing the referenced item; set it when multiple bundles contain that item. |
| `item` | no | The external item selector, e.g. `skills/other-name`, `agents/reviewer`, `commands/review`, or `root-instruction`. Defaults from local `target` / `name`, or to `root-instruction`. |
| `description` | no | Override the materialized description for referenced skills, commands, and agents. Ignored for root-instruction refs. Must be a single line. |
| `ref` | no | Branch, tag, or commit to fetch. |
| `disable-model-invocation` | no | Skill refs only. When `true`, forces the referenced skill to materialize with model invocation disabled. |

Skul fetches the referenced source into `~/.skul/library/` (same cache used for regular bundles) and materializes the referenced item as if it were local. When `ref` is set, Skul aligns the referenced source cache to that branch, tag, or commit before materializing the item; without `ref`, the referenced source follows its cached default-branch checkout.

Repositories with a `.claude-plugin/marketplace.json` can expose local plugin sources as bundles. Skul resolves items from the canonical plugin source instead of tool-specific symlink facades. If multiple plugins expose the same referenced item, use the plugin's declared `name` as the `bundle` value.

### Root Instruction Targets

Skul supports three root instruction target files:

| Target file | Native tools |
|---|---|
| `CLAUDE.md` | `claude-code`, `cursor`, `opencode` |
| `AGENTS.md` | `codex`, `kiro`, `antigravity` |
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
- If the file already existed locally, Skul preserves that pre-existing content as the base and appends bundle content inside compact `SKUL:BUNDLE` markers.
- `--root-instruction-mode replace` explicitly discards the existing base from the effective file after warning, while preserving it for `remove`/`reset` restoration.
- Multiple bundles can share the same untracked root instruction file. Skul recomposes the file in desired-state order and restores the preserved base content when the last contributing bundle is removed or `skul reset` runs.
- Mode precedence is CLI option, then bundle manifest, then `append`. Bundles sharing one root instruction file must use the same mode; mixed `append`/`replace` composition is rejected before files are changed.

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
- `--root-instruction-mode replace` is also supported for tracked shadows. It replaces the committed base in the effective worktree file and records the strategy for later refresh and restoration.

Example:

```bash
# Team policy is already committed in CLAUDE.md
skul add github.com/sjquant/ai-bundles claude-standards --agent claude-code

# Result: tracked CLAUDE.md
# - rendered as committed team base + SKUL shadow block
# - hidden from git status with skip-worktree
# - recorded in the worktree registry as a shadowed file
```

For tracked shadow lifecycle (`shadow --suspend`/`--refresh`, `sync`), safety limits, recovery flows, and SSH cloning, see [docs/advanced.md](docs/advanced.md).

---

## Installation

```bash
npm install --global @solaqua/skul
```

**Requirements:** Node.js >=20, git

### Local development install

```bash
git clone https://github.com/sjquant/skul
cd skul
pnpm install && pnpm run build
pnpm link --global
```

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
See [docs/advanced.md](docs/advanced.md) for `check`/`update`, tracked-shadow lifecycle (`shadow`, `sync`), SSH cloning, and `skul reset`.

---

## License

[ISC](LICENSE)
