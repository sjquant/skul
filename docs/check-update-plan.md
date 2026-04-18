# Check And Update Plan

## Goal

Add `skul check` and `skul update` without breaking Skul's repo-scoped desired state or its worktree-aware materialization model.

The current cache layout is the main constraint: `~/.skul/library/<host>/<owner>/<repo>` is a single working tree per source, so it cannot safely represent multiple desired revisions of the same source at once. `check` and `update` therefore need a small source-tracking model first, followed by a cache refactor before the command handlers are exposed.

## Proposed CLI Surface

### `skul check`

Purpose: compare the repo's desired remote-backed bundles against their latest upstream state without changing files.

```bash
skul check
skul check <bundle>
skul check --json
skul check <bundle> --json
```

Behavior:

- checks only desired-state bundles in the active repo
- skips local-only bundles that have no `source`
- resolves the comparison target from `ref` when present, otherwise from remote HEAD
- reports one of `up-to-date`, `update-available`, `pinned`, `local-only`, or `missing-source`
- includes current resolved commit, latest remote commit, and whether the current worktree is stale relative to repo intent

### `skul update`

Purpose: advance repo intent to a newer upstream revision and rematerialize the current worktree when needed.

```bash
skul update
skul update <bundle>
skul update --dry-run
skul update <bundle> --dry-run
```

Behavior:

- updates one bundle or all remote-backed desired-state bundles
- preserves the existing desired agent selection for each bundle
- uses the same remote resolution rules as `check`
- `--dry-run` previews which bundles would move and which files would change
- without `--dry-run`, updates repo desired state first, then rematerializes only bundles already materialized in the current worktree
- leaves non-materialized linked worktrees untouched; they pick up the new desired revision on the next `skul apply`

## Registry Changes

### Repo desired state

Extend `DesiredBundleEntry` with remote tracking metadata:

- `ref?: string`
  - optional user-selected branch, tag, or commit selector
  - omitted means "follow remote HEAD"
- `resolved_ref?: string`
  - branch or tag name that was actually resolved during the last successful add or update
- `resolved_commit?: string`
  - commit SHA that repo intent currently points to

### Worktree materialization state

Extend `MaterializedBundleState` with:

- `resolved_commit?: string`
  - commit SHA the current worktree last materialized for that bundle

This lets `check` distinguish repo intent freshness from worktree freshness.

## Remote Comparison Rules

- no `ref`: use `git ls-remote --symref <remote> HEAD` and compare the remote HEAD tip against `resolved_commit`
- branch or tag `ref`: compare that remote ref tip against `resolved_commit`
- commit SHA `ref`: treat as pinned; `check` reports `pinned` and `update` is a no-op unless the selector changes later

Preview only the requested bundle directory:

- subdirectory bundle: diff `<bundle>/...`
- repo-as-bundle: diff repo root bundle content only

Preview output should show bundle name, source, current commit, candidate commit, and the added/changed/removed managed files.

## Source Cache Refactor Required Before Command Rollout

Current problem:

- one shared working tree per source cannot safely hold multiple revisions for different repos or worktrees

Required change:

- keep a bare or mirror-style source cache per remote
- materialize bundle contents from commit-specific snapshots

Proposed layout:

- `~/.skul/library/sources/<host>/<owner>/<repo>.git`
- `~/.skul/library/snapshots/<host>/<owner>/<repo>/<commit>/`

This allows non-destructive remote checks, repeatable re-apply from a pinned commit, and multiple repos to depend on different commits of the same source safely.

## Build Slices

1. Add registry support for tracked source metadata.
2. Introduce source mirror and commit snapshot helpers.
3. Add remote probe utilities for HEAD, explicit refs, and commit selectors.
4. Ship `skul check`.
5. Ship `skul update --dry-run`.
6. Ship `skul update` with rematerialization of current worktree bundles.

## First Slice In This Change

This change only does slice 1:

- adds registry fields needed by `check` and `update`
- keeps runtime behavior unchanged for existing commands
- avoids exposing a partial CLI before the source cache can support pinned revisions safely
