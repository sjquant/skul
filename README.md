<p align="center">
  <img src="assets/brand/skul-icon.svg" width="72" alt="" />
</p>

<h1 align="center">skul</h1>

<p align="center">
  <strong>Your AI setup, kept out of Git.</strong><br />
  Apply shared skills, subagents, instructions, and MCP servers to any coding tool — without a single line in <code>git status</code>.
</p>

---

Every AI coding tool wants its own dotdir: `.claude/`, `.cursor/`, `.codex/`, `.kiro/`… Committing them pollutes the repo and your teammates' tool choices. Copying them between projects drifts.

Skul keeps one bundle in a Git repo (or npm package), writes it where each tool expects it, and hides the result with `.git/info/exclude`.

```bash
npm install --global @solaqua/skul

skul add acme/ai-bundles react-expert    # fetch, write, hide
skul status                              # what's applied, where
skul apply                               # same setup in a new worktree
skul remove react-expert                 # gone, as if it never happened
```

## Why

**Not just skills.** Skills, subagents, commands, `AGENTS.md` / `CLAUDE.md`, and MCP servers: write them once in a bundle and Skul translates each into the layout and dialect of every supported tool. Install per project, or globally with `--global`.

**Invisible to Git.** Ignore rules go to `.git/info/exclude`, never `.gitignore`. Even a team-committed `AGENTS.md` can carry your personal layer on top without showing a diff.

**Fully reversible.** Skul fingerprints what it writes. Remove a bundle, or `skul reset`, and your original files come back.

## Works with

Claude Code · Cursor · Codex · OpenCode · GitHub Copilot · Kiro · Antigravity · Grok Build · Qwen Code · Cline · Kimi Code CLI · ZCode

## Learn more

- [Getting started](https://skul.solaqua.dev/docs/intro) — first bundle in two minutes
- [How it stays out of Git](https://skul.solaqua.dev/docs/how-it-works) — exclude, shadows, and the registry
- [Writing a bundle](https://skul.solaqua.dev/docs/bundles) — layout, manifest, MCP servers, cross-repo references
- [Commands](https://skul.solaqua.dev/docs/commands) and [supported tools](https://skul.solaqua.dev/docs/tools)

Requires Node.js 20+ and Git. [ISC licensed](LICENSE).
