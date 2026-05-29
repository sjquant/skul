## Overview

Skul is a TypeScript CLI for managing project-scoped AI configuration bundles across multiple tools (Claude Code, Cursor, Codex, OpenCode). It handles bundle discovery, materialization, registry tracking, stealth mode, and cross-tool translation.

Note: This CLI has not been shipped yet.

## Commands

Run `pnpm install` first — this installs dependencies and sets up the prek pre-commit hooks.

```bash
pnpm test           # run tests once
pnpm run typecheck  # type-check without emitting
pnpm run build      # compile to dist/
pnpm run dev        # run CLI via tsx
```

### CI checks

These three commands must pass before pushing — they're what `.github/workflows/ci.yml` runs:

```bash
pnpm run check:ci       # biome lint + format check (no autofix)
pnpm run typecheck      # tsc --noEmit
pnpm run test:coverage  # vitest run --coverage
```

To autofix lint and formatting issues locally before re-running `check:ci`, use `pnpm run check` (which runs `biome check --write .`).
