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

Multiple bundles may be active in a project simultaneously. File-level conflict detection prevents two bundles from writing the same file path. Each file may be owned by at most one active bundle at a time.

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

The registry file includes a `version` field to enable future schema migrations:

```json
{
  "version": 1,
  "repos": {},
  "worktrees": {}
}
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
        { "bundle": "react-expert", "source": "github.com/user/ai-vault", "tools": ["cursor"] },
        { "bundle": "debugging-tools" }
      ]
    }
  }
}
```

Rules:

- `desired_state` is an ordered array of bundle entries
- each entry must include a `bundle` name; `source` is optional if the bundle name is unambiguous in the library
- `tools` is optional; if present it restricts which tools from the bundle manifest are materialized; if absent all tools declared in the manifest are used
- `tools` values must be a non-empty subset of tool names declared in the bundle's manifest
- if two entries would write the same file path, Skul detects the conflict at materialization time and prompts for resolution

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
- manage the active bundle set
- inspect installed state

---

# 10. CLI Commands

| Command   | Purpose                                              |
| --------- | ---------------------------------------------------- |
| `add`    | Add a bundle to the active set                       |
| `remove` | Remove a bundle from the active set                  |
| `apply`  | Materialize the repository desired state in this worktree |
| `list`   | List cached bundles                                  |
| `status` | Show repository and worktree state                   |
| `clean`  | Remove Skul-managed files                            |

---

# 11. Command Specifications

---

# 11.1 `skul add`

Add a bundle to the active set, or re-materialize it if already active.

Behavior:

1. if the bundle is already in `desired_state`, skip the desired state update and go straight to materialization (idempotent)
2. materialize the bundle into tool-native directories
3. if a file conflict occurs with a file owned by another active bundle, prompt for resolution (rename, prefix, or skip)
4. if the bundle is new, append the entry to `desired_state`
5. update registry

Examples:

```bash
skul add react-expert
skul add github.com/user/ai-vault react-expert
skul add react-expert --tool cursor
skul add react-expert --tool claude-code --tool cursor
```

`--tool` restricts which tools are materialized from the bundle. The selected tools are persisted in the `desired_state` entry so all worktrees see the same subset. Without `--tool`, all tools declared in the manifest are used.

### Interactive Mode

```bash
skul add
```

If cached bundles exist, show a searchable bundle picker. Already-active bundles are shown as such but remain selectable for re-materialization.

---

# 11.2 `skul remove`

Remove a bundle from the active set.

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

# 11.3 `skul apply`

Materialize the repository desired state in the current worktree.

This command is intended for new worktrees where the repository already has a configured desired state but no files have been materialized yet. It does not modify the desired state — it only writes files.

Behavior:

1. read `desired_state` from the registry for this repository
2. if desired state is empty, print a message and exit
3. materialize all bundles in the desired state into the current worktree
4. configure `.git/info/exclude`
5. update worktree materialized state in registry

Example:

```bash
# new worktree, desired state already set from another worktree
skul apply
```

If the worktree is already fully materialized, `skul apply` is a no-op and reports that everything is up to date.

---

# 11.5 `skul list`

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

# 11.6 `skul status`

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
Suggested Action: run "skul apply"
```

---

# 11.7 `skul clean`

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

Running `skul status` will show the unmaterialized desired state and suggest running `skul apply`.

Running `skul apply` in the new worktree will materialize all bundles recorded in the repository desired state without modifying the desired state itself.

This ensures bundle configuration propagates across worktrees.

---

# 13. Lifecycle Rules

### Add

1. detect repository
2. detect worktree
3. validate bundle
4. inject files; prompt on file-level conflict with existing managed files
5. update registry
6. configure git exclusion

---

### Remove

`skul remove` removes one bundle from the active set without affecting others.

If a managed file was modified after materialization, removal must require confirmation before deleting it.

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
