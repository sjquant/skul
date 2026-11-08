<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/skul-mark-dark.svg" />
    <img src="assets/brand/skul-mark.svg" width="60" alt="" />
  </picture>
</p>

<h1 align="center">skul</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <strong>Your AI setup, kept out of Git.</strong><br />
  Bring your skills and instructions to each project, without asking the team to adopt your coding tool.
</p>

Every coding tool wants its own dotdir: `.claude/`, `.cursor/`, `.codex/`… If you switch tools or work across repos, copies of your setup soon fall out of sync. Committing it makes your personal setup everyone's business.

Skul is a CLI that keeps reusable AI configuration in a **bundle** — a Git repo or npm package — and writes it into each tool's supported layout. Local Git exclude rules keep new, untracked files out of `git status`, without changing `.gitignore`.

## Try one skill

You need **Node.js 20+**, **Git**, and a supported coding tool. This example targets **Claude Code** and needs network access to npm and GitHub. Run it inside a Git project:

```bash
npm install --global @solaqua/skul
skul add sjquant/ghosts writing --agent claude-code --include skills/rewrite
skul status
git status --short
```

This fetches the public [`writing` bundle](https://github.com/sjquant/ghosts/tree/main/writing) and installs only its prompt-rewriting skill under `.claude/skills/`. `skul status` shows what was installed. New, untracked skill files stay out of `git status --short`; other project changes remain visible. Overwriting an already tracked skill can produce a diff.

Open Claude Code in the project and try:

```text
/ghosts:rewrite Please rewrite this prompt: Explain this function. Keep it short. Use one example.
```

For another tool, change `--agent` using the [supported tools guide](https://skul.solaqua.dev/docs/tools); skill invocation depends on the tool.

Only install bundles you trust: skills and instructions influence your coding agent, and MCP configurations can tell it to launch commands or connect to servers.

## Keep the setup, skip the copying

- **One source across tools.** Bundle skills, subagents, commands, instructions, and MCP servers together. Skul maps them to supported tool formats; [capabilities vary by tool](https://skul.solaqua.dev/docs/tools).
- **Your setup stays local.** Share the bundle with people who want it, without committing generated configuration to every project. Use `--global` when you want user-wide configuration.
- **New worktree, same setup.** Skul remembers the repository's selected bundles. Run `skul apply` inside a new linked worktree to materialize them there.

```bash
skul update           # fetch and apply newer revisions of your selected bundles
skul remove writing   # remove the example bundle from this worktree
```

`skul remove` also removes the bundle from this repository's saved selection; files already installed in other worktrees stay there. `skul reset` cleans Skul-managed files from this worktree but keeps the saved selection for a later `skul apply`.

Removing a bundle restores preserved originals. If a managed file has been edited, removal asks for confirmation; in headless mode it refuses. Passing `--yes` skips that confirmation.

## Before applying a full bundle

A bundle can also layer instructions onto tracked `AGENTS.md` / `CLAUDE.md` files or merge MCP settings. Tracked files use `skip-worktree` shadows: use `skul sync` to pull, suspend and refresh shadows around other Git commands that move `HEAD`, and don't edit shadowed files by hand. Only one bundle can own a tracked file's shadow at a time. Read [how tracked files work](https://skul.solaqua.dev/docs/how-it-works#root-instructions) before using this mode.

## Works with

Claude Code · Cursor · Codex · OpenCode · GitHub Copilot · Kiro · Antigravity · Grok Build · Qwen Code · Cline · Kimi Code CLI · ZCode

## Make it yours

- [Getting started](https://skul.solaqua.dev/docs/intro) — installation and first use
- [Write a bundle](https://skul.solaqua.dev/docs/bundles) — your own skills, instructions, and MCP servers
- [Commands](https://skul.solaqua.dev/docs/commands) — selection, updates, removal, and global installs
- [How it stays out of Git](https://skul.solaqua.dev/docs/how-it-works) — excludes, state, and tracked-file shadows

[ISC licensed](LICENSE).
