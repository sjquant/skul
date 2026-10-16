# Bundle item dependencies (`requires`)

Status: implemented. Usage is in the README ("Bundle Structure"); this note records the decisions behind it.

## Why

A skill often calls another skill by name, so installing it without that skill leaves it broken. Several bundles also tend to need the same shared skill. `skul.refs.json` cannot express this: a referenced item becomes part of the referencing bundle, so two bundles referencing one skill own the same path, and what the source bundle itself requires is not followed.

## Declaration

`requires` in `manifest.json` maps an item (`skills/…`, `commands/…`, `agents/…`) to what it needs: another item of the same bundle (a string), or an item of another source (`{ source, item, bundle?, ref? }`). It lives in the manifest rather than in `SKILL.md` frontmatter because skul rewrites frontmatter per tool and the same rule has to cover commands and agents.

## Behavior

- **Same bundle.** Selecting an item installs everything it requires, transitively, at the materialization entry points (`withRequiredItems`, `resolveBundleItemRefs`). The registry keeps only the user's selection, so a later change to `requires` applies on the next `apply` or `update`. A requirement on an item the bundle does not ship is an error when a selected item reaches it.
- **Other sources.** After `add`, `remove`, `apply` and `update`, `syncBundleDependencies` recomputes every dependency from the manifests of the bundles the user chose, installs what is new and removes what nothing requires any more. A dependency installs only the required items, for the requirers' tools that it supports (a warning names the rest), in the requirer's scope (project or `--global`).
- **Stored as implicit entries.** Dependencies are `desired_state` entries with `implicit`, `required_by` and `required_items`. Storing them, rather than deriving them on read, keeps `apply`, `update` and `check` on the ordinary path and lets `apply` in another worktree install them. Because they are recomputed each time, nothing is reference-counted. A bundle that is both chosen and required keeps its own `items`; it installs the union (`effectiveDesiredItems`).
- **Shared and removed with the last requirer.** One install per `(source, bundle)` however many bundles require it. A dependency cannot be removed on its own. Adding it explicitly turns it into a regular bundle.
- **Refs.** A `ref` is an exact branch, tag or commit. Two requirements on different refs of one source fail before anything is fetched. The installed ref and commit are recorded like any other entry.
- **Trust.** A dependency is code the user never named, and an upstream manifest can add one at any update. Sources no installed bundle came from are confirmed before they are fetched. `--yes` does not approve them; `--allow-new-sources` does, and the output lists what it allowed. Without a terminal and without the flag the command fails.
- **Failure.** The sync runs after the command, so a refused source, a ref conflict or a fetch failure leaves the command applied without its dependencies. The error says so and names the `skul apply` that finishes the job.

## Identity and ownership

Dependencies make several bundles share names and paths, which the registry used to mishandle, so two changes came first:

- Bundles are identified by `(source, bundle)`: registry records are keyed `name@source` and carry `bundle`; shadow overlays carry `source`. Same-named bundles from different sources coexist; a bare name that matches several must be qualified (`skul remove <source> <bundle>`). Registries in the older format are upgraded when read.
- A write onto a path another bundle manages is refused before anything is written, for `add`, `apply` and `update`, project and global. Root-instruction and MCP configuration files are exempt because bundles compose into them.

## Not done

- Version ranges, satisfying a requirement by name rather than by source, satisfying a project install from a global one, MCP servers and root instructions as dependencies, and a lockfile.
- Following `requires` declared by the source bundle of a referenced item (#133), showing dependencies in `--dry-run` and the picker (#134), widening the tools of a narrowly scoped direct bundle that is also a dependency (#135).
- Resolving and confirming dependencies before the command writes, which would remove the partial-apply case above.
