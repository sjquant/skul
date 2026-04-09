## Overview

Skul is a TypeScript CLI for managing project-scoped AI configuration bundles across multiple tools (Claude Code, Cursor, Codex, OpenCode). It handles bundle discovery, materialization, registry tracking, stealth mode, and cross-tool translation.

## Project Tree

```
src/
  index.ts                      # CLI entrypoint
  cli.ts                        # Command definitions (add, remove, apply, status, reset, list)
  registry.ts                   # Registry schema, parsing, and persistence (~/.skul/registry.json)
  state-layout.ts               # Global state paths (~/.skul/)
  git-context.ts                # Repo fingerprinting and worktree detection
  git-exclude.ts                # Stealth mode via .git/info/exclude
  tool-mapping.ts               # Tool definitions and native directory mappings
  bundle-manifest.ts            # Bundle manifest parsing and validation
  bundle-discovery.ts           # Bundle fetch from local cache and Git sources
  bundle-materialization.ts     # File injection into tool-native directories
  bundle-translation.ts         # Cross-tool content transforms (skills, commands, agents)
  conflict-resolution.ts        # User prompts for file conflicts
  *.test.ts                     # Vitest unit tests
```

## Commands

See [`package.json`](./package.json) for all scripts. Common ones:

```bash
pnpm install        # install dependencies
pnpm test           # run tests once
pnpm run typecheck  # type-check without emitting
pnpm run build      # compile to dist/
pnpm run dev        # run CLI via tsx
```
