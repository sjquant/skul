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

- apply AI configuration bundles into tool-native directories
- optionally exclude them from Git tracking (stealth mode)
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

## 2.2 Optional Stealth Mode

Two installation modes exist.

### Stealth Mode

Files are written into tool directories but excluded from Git.

Mechanism:

`.git/info/exclude`

Example:

```gitignore
# >>> SKUL START
.claude/skills/react.md
.claude/commands/review.md
# <<< SKUL END
```

### Tracked Mode

Files are written normally and tracked by Git.

Useful when teams intentionally want shared AI configs.

---

## 2.3 Deterministic Ownership

Skul must track exactly which files it manages.

Deletion, switching, and cleanup must rely on the registry.

Filename patterns alone must never determine ownership.

---

## 2.4 Context Minimalism

Only one active bundle per tool per project should exist by default.

This prevents:

- instruction context bloat
- conflicting AI instructions

---

## 2.5 Git-Friendly Behavior

Skul must not modify:

- `.gitignore`
- repository configuration
- tracked files

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

### Installed Files

Files injected normally and tracked by Git.

---

### Repository Desired State

The bundle that a repository intends to use.

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

Stores the desired bundle for the repository.

Example:

```json
{
  "repos": {
    "repo_fingerprint_abc123": {
      "repo_root": "/Users/dev/project",
      "remote_url": "git@github.com:org/repo.git",
      "desired_state": {
        "tool": "claude-code",
        "bundle": "react-expert",
        "mode": "stealth"
      }
    }
  }
}
```

---

## 5.2 Worktree State

Stores the actual files installed for a specific working tree.

Example:

```json
{
  "worktrees": {
    "worktree_xyz001": {
      "repo_fingerprint": "repo_fingerprint_abc123",
      "path": "/Users/dev/project",
      "materialized_state": {
        "tool": "claude-code",
        "bundle": "react-expert",
        "mode": "stealth",
        "files": [".claude/skills/react.md", ".claude/commands/review.md"],
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

# 8. File Naming Rules

## 8.1 Default Behavior

Skul does **not apply prefixes by default.**

Example:

```text
.claude/skills/react.md
.claude/commands/review.md
```

---

## 8.2 Conflict Handling

If a filename conflict occurs, Skul prompts the user.

Example:

```text
Conflict detected:
.claude/skills/react.md already exists

Options:
1) Rename incoming file
2) Apply prefix
3) Skip file
```

Suggested prefix:

```text
p-react.md
```

---

## 8.3 Ownership Tracking

File ownership is determined solely by registry records.

---

# 9. CLI Design

## Command Philosophy

CLI focuses on three main actions:

- discover bundles
- apply bundles
- inspect installed state

---

# 10. CLI Commands

| Command   | Purpose                            |
| --------- | ---------------------------------- |
| `use`     | Apply bundle in stealth mode       |
| `install` | Apply bundle with Git tracking     |
| `list`    | List cached bundles                |
| `status`  | Show repository and worktree state |
| `clean`   | Remove Skul-managed files          |

---

# 11. Command Specifications

---

# 11.1 `skul use`

Apply bundle in stealth mode.

Behavior:

1. update repository desired state
2. materialize bundle in current worktree
3. inject files
4. configure `.git/info/exclude`
5. update registry

Examples:

```bash
skul use react-expert
```

```bash
skul use github.com/user/ai-vault react-expert
```

---

### Interactive Mode

```bash
skul use
```

If cached bundles exist:

- show searchable bundle picker
- fuzzy search enabled
- allow preview of metadata

---

# 11.2 `skul install`

Install bundle without stealth.

Files remain tracked by Git.

Example:

```bash
skul install react-expert
```

---

# 11.3 `skul list`

Display cached bundles.

Example:

```bash
skul list
```

Output example:

```text
Available Bundles

react-expert
nextjs-minimal
go-backend
review-debug
```

---

# 11.4 `skul status`

Show both repository and worktree state.

Example output:

```text
Repository Desired State
Tool: claude-code
Bundle: react-expert
Mode: stealth

Current Worktree
Path: /Users/dev/project-feature-a
Materialized: yes

Files:
  .claude/skills/react.md
  .claude/commands/review.md

Git Exclude:
  configured
```

If a new worktree has not yet materialized files:

```text
Repository Desired State: react-expert

Current Worktree
Materialized: no
Suggested Action: run "skul use"
```

---

# 11.5 `skul clean`

Remove Skul-managed files from the current worktree.

Behavior:

1. read registry
2. delete tracked files
3. remove exclusion block
4. clear worktree state

Safety rule:

Only files recorded in the registry may be removed.

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

Applying a new bundle removes the previous one.

---

### Delete

Deletion must rely on registry entries.

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
- multi-tool installs
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
