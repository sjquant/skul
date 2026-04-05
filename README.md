# Skul

Skul is a CLI for applying project-scoped AI bundles into tool-native folders without committing those files to Git.

It writes files where tools expect them, tracks what it owns, and hides them through `.git/info/exclude`.

## What It Does

- applies cached bundles with `skul add`
- lists cached bundles with `skul list`
- shows repo and worktree state with `skul status`
- removes only Skul-managed files with `skul reset`
- carries repo intent across linked Git worktrees
- prompts before removing managed files you changed yourself

## Supported Tools

- `claude-code`: `.claude/skills`, `.claude/commands`, `.claude/agents`
- `cursor`: `.cursor/skills`, `.cursor/commands`
- `opencode`: `.opencode/skills`, `.opencode/commands`, `.opencode/agents`
- `codex`: `.agents/skills`, `.codex/agents`

## Basic Flow

```bash
skul list
skul add react-expert
skul status
skul reset
```

You can also select a bundle by source:

```bash
skul add github.com/user/ai-vault react-expert
```

## How It Works

Skul keeps global state under `~/.skul/`:

- `library/`: cached bundles
- `registry.json`: repo intent plus per-worktree materialization state

The split matters:

- a repository remembers which bundle it wants
- each worktree remembers which files were actually written there

That means a linked worktree can see the desired bundle in `skul status` without pretending the files already exist.

## Safety Model

- stealth mode only: Skul writes ignore rules to `.git/info/exclude`
- no `.gitignore` edits, no Git config edits, no history changes
- cleanup and replacement use registry-owned paths, not filename guessing
- modified managed files require confirmation before removal
- missing bundles show available cached bundle names when possible
- corrupted registry files stop execution and ask for repair or removal

Current limitation:

- cross-tool replacement currently handles managed-file replacement and target directories only
- tool-specific content transforms are still pending for cases such as front matter changes, `disable-model-invocation`, and `agent.toml` generation

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run dev -- --help
```

In this repo, use `pnpm run dev -- ...` instead of a globally installed `skul`.
