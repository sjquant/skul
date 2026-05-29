# Skul — Advanced Usage

This guide covers the commands and flags that aren't part of the day-to-day workflow. For first-touch usage (`add`, `list`, `status`, `remove`, `apply`) see the [README](../README.md).

---

## Advanced commands

| Command | Description |
|---|---|
| `skul check [bundle]` | Check remote-backed bundles for upstream updates |
| `skul update [bundle]` | Update remote-backed bundles to the latest upstream revision |
| `skul sync` | Run `git pull --ff-only` with tracked root-instruction shadow suspend/refresh |
| `skul shadow --suspend \| --refresh` | Restore or rebuild tracked root-instruction shadows |
| `skul reset` | Remove all Skul-managed files from the current worktree |

All mutating commands accept `--dry-run`. `skul check` accepts `--json`.

---

## `add` — power flags

The Quick Start in the README shows the simplest `add` invocations. These flags cover non-default cases.

```bash
# Track a specific branch or tag
skul add github.com/sjquant/ai-bundles react-expert --ref stable

# Pin a bundle to an exact commit
skul add github.com/sjquant/ai-bundles react-expert --pin 2813b88

# Install only selected bundle items
skul add react-expert --agent codex --include skills/diagnose
skul add react-expert --agent codex --include agents/reviewer
skul add react-expert --agent codex --include root-instruction

# Choose bundle items interactively
skul add react-expert --agent codex --select-items
```

`--include <item>` installs only specific bundle items. Repeat it for multiple items. Supported selectors are `skills/<name>`, `commands/<name>`, `agents/<name>`, and `root-instruction`; `AGENTS.md` and `CLAUDE.md` are accepted aliases for `root-instruction`. Use `--select-items` to open an interactive picker. If `--include` and `--select-items` are used together, the included items are preselected in the picker.

### Cloning: HTTPS vs SSH

By default Skul clones bundle sources over HTTPS. To use SSH, either pass `--ssh` or supply a `git@` URL — both are equivalent:

```bash
skul add --ssh github.com/sjquant/ai-bundles react-expert
skul add git@github.com:sjquant/ai-bundles react-expert
```

The protocol choice is stored in the registry alongside the bundle entry. When `skul apply` re-clones a source in a new worktree it uses the same protocol automatically — no need to repeat `--ssh`.

If SSH authentication fails (missing key, wrong host, etc.) Skul prints a hint pointing to the HTTPS equivalent command.

---

## Staying up to date: `check` and `update`

```bash
# See whether remote-backed bundles have updates
skul check

# Update remote-backed bundles to the latest upstream revision
skul update
```

`check` is read-only and accepts `--json` for scripting. `update` accepts `--dry-run`.

---

## Git Update Workflow

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

---

## Cleanup: `reset`

```bash
skul reset
```

Removes all Skul-managed files from the current worktree. Restores tracked root-instruction shadows to their committed `HEAD` version and clears `skip-worktree`. For untracked shared root instructions, restores the preserved local base content. Accepts `--dry-run` and `--global` (the latter resets globally managed tool config).

---

## FAQ — shadows and sync

**When should I use `skul shadow --suspend`, `skul shadow --refresh`, or `skul sync`?**
Use `skul shadow --suspend` before a manual Git update that touches tracked root instruction files. Use `skul shadow --refresh` after that update only when the root instruction file is still tracked in the new `HEAD` and the local shadow state is still intact. Use `skul sync` when a fast-forward pull is all you need, because it wraps both steps around `git pull --ff-only` and can retire shadows automatically if upstream stops tracking the file.

**What happens if I edit a tracked shadowed root instruction directly?**
Skul treats tracked root-instruction shadows as generated output. `skul status` will usually report `Manual edits: suspected`, and follow-up commands may refuse to refresh, remove, or reset that shadowed file once the rendered output no longer matches Skul's recorded fingerprint. This is a current limitation of tracked shadow mode, so the safe practice is to avoid manual edits to shadowed root instruction files.

**What happens to files after `git worktree remove`?**
Run `skul reset` before removing a worktree.
