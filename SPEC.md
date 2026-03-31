# 1. Overview

AI coding tools rely on configuration assets such as:

- skills
- commands
- agents

These assets are frequently:

- highly **personalized**
- **project-specific**
- unsuitable for team-wide sharing

However, AI tools require these files to exist in **tool-specific directories** such as:

- `.claude/skills`
- `.cursor/commands`
- `.opencode/commands`
- `.agents/skills`

Skul provides a CLI that allows developers to:

- apply AI configuration bundles into tool-native directories in stealth mode
- switch bundles per project
- maintain a cached bundle catalog
- prevent context bloat
- support Git worktree environments cleanly

---

# 2. Core Design Principles

## 2.1 Tool-Native Placement

AI configuration assets must exist in tool-native directories.

Examples:

| Tool        | Directory / Entry Point |
| ----------- | ----------------------- |
| Claude Code | `.claude/` |
| Cursor      | `.cursor/` |
| OpenCode    | `.opencode/` |
| Codex       | `.agents/skills` |

Skul writes files directly into these locations.

Skul **never requires tools to read from `.skul/` directories.**

---

## 2.2 Stealth Mode

### Stealth Mode

Files are written into tool directories but excluded from Git.

Mechanism:

`.git/info/exclude`

Example:

```gitignore
# >>> SKUL START
.claude/skills/react/SKILL.md
.claude/commands/review.md
# <<< SKUL END
```

## 2.3 Deterministic Ownership

Skul must track exactly which files it manages.

Deletion, switching, and cleanup must rely on the registry.

Filename patterns alone must never determine ownership.

If a managed file has been modified since Skul wrote it, cleanup and replacement must not delete it silently.

Skul must detect that mismatch from registry-tracked file metadata and require user confirmation before removing the file.

---

## 2.4 Context Minimalism

Multiple bundles may be active in a project simultaneously, but each tool may be served by at most one active bundle at a time.

This prevents:

- instruction context bloat
- conflicting AI instructions
- ambiguous file ownership between bundles

---

## 2.5 Git-Friendly Behavior

Skul must not modify:

- `.gitignore`
- repository configuration

Stealth behavior relies solely on `.git/info/exclude`.

---

## 2.6 Worktree Compatibility

Git worktrees introduce multiple working directories for the same repository.

Skul must support this by separating:

### Repository Intent

What bundle the repository should use.

### Worktree Materialization

Actual files injected into the current working directory.

This model allows new worktrees to **reconstruct the desired configuration automatically.**

---

# 3. Terminology

### Asset

Single Markdown instruction file used by AI tools.

Examples:

- skill
- command
- agent

---

### Bundle

Named collection of assets.

Examples:

- `react-expert`
- `go-backend`
- `nextjs-minimal`

---

### Stealth Files

Files injected by Skul but excluded from Git tracking.

---

### Repository Desired State

The set of bundles a repository intends to use.

---

### Worktree Materialization

The actual files installed inside a specific working tree.

---

### Library Cache

Local cache of discovered bundles.

Location:

```text
~/.skul/library/
```

---

# 4. Architecture

## 4.1 System Layout

Global state:

```text
~/.skul/
  registry.json
  library/
  config.json
```

Repository structure:

```text
repo/
  .claude/
  .cursor/
```

---

# 5. Registry Model

Registry separates **repository-level intent** from **worktree-level realization**.

Location:

```text
~/.skul/registry.json
```

---

## 5.1 Repository State

Stores the set of desired bundles for the repository.

Example:

```json
{
  "repos": {
    "repo_fingerprint_abc123": {
      "repo_root": "/Users/dev/project",
      "remote_url": "git@github.com:org/repo.git",
      "desired_state": [
        { "bundle": "react-expert", "source": "github.com/user/ai-vault" },
        { "bundle": "debugging-tools" }
      ]
    }
  }
}
```

Rules:

- `desired_state` is an ordered array of bundle entries
- each entry must include a `bundle` name; `source` is optional if the bundle name is unambiguous in the library
- a tool may appear in at most one entry; Skul rejects configurations where two entries claim the same tool

---

## 5.2 Worktree State

Stores the actual files installed for a specific working tree, grouped by bundle and then by tool.

Example:

```json
{
  "worktrees": {
    "worktree_xyz001": {
      "repo_fingerprint": "repo_fingerprint_abc123",
      "path": "/Users/dev/project",
      "materialized_state": {
        "bundles": {
          "react-expert": {
            "source": "github.com/user/ai-vault",
            "tools": {
              "claude-code": {
                "files": [".claude/skills/react/SKILL.md", ".claude/commands/review.md"],
                "file_fingerprints": {
                  ".claude/skills/react/SKILL.md": "abc123...",
                  ".claude/commands/review.md": "def456..."
                },
                "directories": [".claude/skills/react"]
              },
              "cursor": {
                "files": [".cursor/commands/review.md"],
                "file_fingerprints": {
                  ".cursor/commands/review.md": "ghi789..."
                },
                "directories": []
              }
            }
          },
          "debugging-tools": {
            "tools": {
              "claude-code": {
                "files": [".claude/skills/debug/SKILL.md"],
                "file_fingerprints": {
                  ".claude/skills/debug/SKILL.md": "jkl012..."
                },
                "directories": [".claude/skills/debug"]
              }
            }
          }
        },
        "exclude_configured": true
      }
    }
  }
}
```

---

# 6. Tool Integration

Skul integrates with AI tools using **tool mapping definitions**.

Example:

```yaml
name: claude-code
targets:
  skills:
    path: ".claude/skills"
  commands:
    path: ".claude/commands"
  agents:
    path: ".claude/agents"
```

Example:

```yaml
name: cursor
targets:
  skills:
    path: ".cursor/skills"
  commands:
    path: ".cursor/commands"
```

Example:

```yaml
name: opencode
targets:
  skills:
    path: ".opencode/skills"
  commands:
    path: ".opencode/commands"
  agents:
    path: ".opencode/agents"
```

Example:

```yaml
name: codex
targets:
  skills:
    path: ".agents/skills"
```

Rules:

- follow tool directory conventions exactly
- do not normalize tool structures
- defer deprecated or non-project-scoped tool surfaces until Skul defines explicit support for them

---

# 7. Bundle Sources

Bundles are typically sourced from Git repositories.

Example repository:

```text
ai-vault/
  react-expert/
    manifest.json
    skills/
    commands/
  go-backend/
    manifest.json
    skills/
```

Bundles are cached locally:

```text
~/.skul/library/
```

The cache is an implementation detail.

---

# 7.1 Bundle Manifest Format

Each bundle contains a `manifest.json` that declares which tools it supports and the target paths for each tool's assets.

A bundle may support one or more tools.

Single-tool example:

```json
{
  "name": "go-backend",
  "tools": {
    "claude-code": {
      "targets": {
        "skills": { "path": "skills" }
      }
    }
  }
}
```

Multi-tool example:

```json
{
  "name": "react-expert",
  "tools": {
    "claude-code": {
      "targets": {
        "skills": { "path": "skills" },
        "commands": { "path": "commands" }
      }
    },
    "cursor": {
      "targets": {
        "commands": { "path": "commands" }
      }
    },
    "opencode": {
      "targets": {
        "skills": { "path": "skills" },
        "commands": { "path": "commands" }
      }
    }
  }
}
```

Different tools may reference the same asset path within the bundle when the content is compatible across tools.

Rules:

- `tools` must contain at least one entry
- each key in `tools` must be a supported tool name
- each tool entry must declare at least one target
- target names must be supported by the corresponding tool
- target paths must be relative and must not traverse outside the bundle directory
- different tools may share the same asset path if the assets are compatible

---

# 8. File Naming Rules

## 8.1 Default Behavior

Skul does **not apply prefixes by default.**

Example:

```text
.claude/skills/react/SKILL.md
.claude/commands/review.md
```

---

## 8.2 Conflict Handling

If a filename conflict occurs, Skul prompts the user.

Example:

```text
Conflict detected:
.claude/skills/react/SKILL.md already exists

Options:
1) Rename incoming file
2) Apply prefix
3) Skip file
```

Suggested prefix:

```text
.claude/skills/p-react/SKILL.md
```

---

## 8.3 Ownership Tracking

File ownership is determined solely by registry records.

For managed files, the registry must eventually store enough metadata to detect whether the current file still matches what Skul originally wrote.

If the content no longer matches, the file is treated as user-modified and requires confirmation before deletion or replacement.

---

# 9. CLI Design

## Command Philosophy

CLI focuses on three main actions:

- discover bundles
- apply bundles
- inspect installed state

---

# 10. CLI Commands

| Command    | Purpose                                      |
| ---------- | -------------------------------------------- |
| `use`     | Set the active bundle set to a single bundle |
| `add`     | Add a bundle to the active set               |
| `remove`  | Remove a bundle from the active set          |
| `list`    | List cached bundles                          |
| `status`  | Show repository and worktree state           |
| `clean`   | Remove Skul-managed files                    |

---

# 11. Command Specifications

---

# 11.1 `skul use`

Replace the entire active bundle set with a single bundle.

This is the primary entry point for applying a configuration. It replaces all previously active bundles and their managed files before materializing the new bundle.

Behavior:

1. remove all previously materialized bundles from the worktree (with confirmation for user-modified files)
2. set desired_state to `[{ bundle }]`
3. materialize the new bundle for all tools declared in its manifest
4. configure `.git/info/exclude`
5. update registry

Examples:

```bash
skul use react-expert
skul use github.com/user/ai-vault react-expert
skul use react-expert --tool cursor
```

`--tool` restricts which tools are materialized from the bundle. Without it, all tools declared in the manifest are used.

---

### Interactive Mode

```bash
skul use
```

If cached bundles exist, show a searchable single-select bundle picker with supported tools visible in the preview.

---

# 11.2 `skul add`

Add a bundle to the active set without replacing existing ones.

Behavior:

1. validate that no tool claimed by the new bundle is already claimed by an active bundle
2. if a conflict exists, list the conflicting tools and the bundle that owns them, then abort
3. materialize the new bundle into tool-native directories
4. append the bundle entry to `desired_state`
5. update registry

Examples:

```bash
skul add debugging-tools
skul add github.com/user/ai-vault debugging-tools
skul add debugging-tools --tool claude-code
```

---

# 11.3 `skul remove`

Remove a specific bundle from the active set.

Behavior:

1. look up the bundle in the worktree's materialized state
2. delete managed files for that bundle (with confirmation for user-modified files)
3. remove the bundle entry from `desired_state`
4. update registry and `.git/info/exclude`

Examples:

```bash
skul remove debugging-tools
```

---

# 11.4 `skul list`

Display cached bundles with their supported tools.

Example:

```bash
skul list
```

Output example:

```text
Available Bundles

react-expert       claude-code, cursor, opencode
nextjs-minimal     claude-code
go-backend         claude-code, cursor
debugging-tools    claude-code
```

---

# 11.5 `skul status`

Show both repository and worktree state.

Example output:

```text
Repository Desired State
  react-expert     claude-code, cursor
  debugging-tools  claude-code

Current Worktree
Path: /Users/dev/project-feature-a

react-expert
  claude-code: materialized
    .claude/skills/react/SKILL.md
    .claude/commands/review.md
  cursor: materialized
    .cursor/commands/review.md

debugging-tools
  claude-code: materialized
    .claude/skills/debug/SKILL.md

Git Exclude:
  configured
```

If a new worktree has not yet materialized files:

```text
Repository Desired State
  react-expert     claude-code, cursor

Current Worktree
Path: /Users/dev/project-feature-a
Materialized: no
Suggested Action: run "skul use"
```

---

# 11.6 `skul clean`

Remove Skul-managed files from the current worktree.

Behavior:

1. read registry
2. delete managed files for all bundles (or the specified bundle/tool)
3. remove exclusion block entries for deleted files
4. clear worktree state for removed entries

Examples:

```bash
skul clean
```

Removes all managed files across all bundles and tools.

```bash
skul clean --bundle debugging-tools
```

Removes managed files for the specified bundle only.

Safety rule:

Only files recorded in the registry may be removed.

If a recorded file has been modified since materialization, Skul must prompt before deleting it.

---

# 12. Worktree Behavior

When a new Git worktree is created:

- repository desired state already exists
- worktree materialization may be missing

Running:

```bash
skul status
```

or

```bash
skul use
```

will automatically materialize the configuration.

This ensures bundle configuration propagates across worktrees.

---

# 13. Lifecycle Rules

### Apply

1. detect repository
2. detect worktree
3. validate bundle
4. remove previous files
5. inject new files
6. update registry
7. configure git exclusion

---

### Replace

`skul use` replaces the entire active bundle set with a single new bundle.

`skul add` appends a bundle to the active set without affecting other bundles.

`skul remove` removes one bundle from the active set without affecting others.

If a previously managed file was modified after materialization, replacement or removal must require confirmation before removing it.

---

### Delete

Deletion must rely on registry entries.

Modified managed files must require confirmation before deletion.

---

# 14. Error Handling

### Missing Git Repository

If `.git` does not exist:

- stealth mode unavailable
- user confirmation required

---

### Bundle Not Found

Error message must list available bundles.

---

### File Conflict

User must choose rename, prefix, or skip.

---

### Registry Corruption

Skul must:

- warn user
- avoid destructive actions
- suggest repair

---

# 15. Security

Skul must never store:

- API keys
- tokens
- credentials

All configuration remains local.

---

# 16. Future Extensions

Potential enhancements:

- automatic bundle recommendation
- bundle version pinning
- bundle inheritance
- remote bundle registry
- AI model configuration bundles

### Shell Hook Integration

Future versions may integrate with shell hooks or environment managers.

Examples:

- zsh hooks
- direnv
- mise
- devbox

This would allow automatic reconciliation when entering a repository or worktree.

Example workflow:

```text
cd project-feature-a
→ hook detects repo
→ skul reconcile
→ bundle automatically materialized
```
