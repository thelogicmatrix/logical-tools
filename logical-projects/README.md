# logical-projects: basic project tracking

You have more going on than fits in one head: eight repos, three of them paused, one you have not opened in five weeks. `projects` keeps a generated index of all of it and one page per project for the prose, and checks both against reality so the table never quietly rots.

## What it is

A portfolio in `docs/projects/`, split into the bookkeeping a CLI owns and the narrative you write.

- **The index.** `INDEX.md`, a table of every project grouped by theme. The CLI rebuilds it on every change, so a hand-edit is lost.
- **One page per project.** `<slug>.md`, where you write what the project is and where it could go next, under a dated Current state block.
- **The CLI.** Owns every mechanical field: status, theme, where the project lives, its repo and the last-touched date. The skill runs it when you say "projects", "project status" or "portfolio".
- **A write-guard.** A hook that stops the agent hand-editing the index or the per-project records, and names the command to use instead.

Every project has one of four statuses and one of six themes. Both are deliberately few, because anything finer becomes a taxonomy you maintain instead of work you do.

| Status | In plain English             |
| ------ | ---------------------------- |
| active | being worked on              |
| ops    | running, not being worked on |
| paused | parked                       |
| done   | finished                     |

The themes are `work`, `job-search`, `tooling`, `homelab`, `worldbuilding` and `personal`. `register` refuses a project without one, and the only thing a theme decides is which section of the index and the list the project appears under.

## How it works

The narrative stays yours. The bookkeeping is never yours again.

Tables a model maintains rot quietly, because nothing compares them to the world. Here the index is rendered from one JSON record per project, and `projects sync` checks every row against reality: a page still holding its skeleton, a status older than the repo's last commit, a checkout that no longer exists. It reports and never fixes. A contradiction between a page and reality is a judgement call, and a tool that guessed would overwrite the one thing here a human wrote.

The repo checks only run on a row with a `repo` path. Leave it blank on a docs-only project, because a repo that commits many times a day for unrelated reasons makes the stale flag noise wearing the costume of a signal.

[gtg](../gtg), the session layer below this one, reads `INDEX.md` to group sub-projects into families. Either works alone.

## Install

Add the logical-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install logical-projects@logical-tools        # Claude Code
codex plugin add logical-projects@logical-tools       # Codex
```

You need Node 18 or later and git. It has no other dependencies. The write-guard hook is wired for Claude Code only.

## Where things live

`docs/projects/` at the top of the current git repo, created by the first `register`. Set `PROJECTS_ROOT` to keep one portfolio for many repos.

Add these lines to `.gitattributes` so merges and Windows line endings leave the store alone ([why](skills/logical-projects/references/store.md#gitattributes)):

```
docs/projects/INDEX.md -merge
docs/projects/entries/*.json -text
```

## Commands

`projects` below is `node <plugin>/skills/logical-projects/projects.mjs`, where `<plugin>` is the plugin's install folder.

```
projects                     list every project by theme, with its current state's first line
projects <theme>             list one theme
projects register <slug> --theme T [--name N --status S --where W --repo R]
projects set <slug> [--name N --where W --repo R --theme T]
projects current <slug>      replace that page's Current state from stdin
projects status <slug> <s>   active | paused | ops | done
projects sync                check every row against reality
projects log [slug]          what happened, read from git
projects rename <old> <new>  change a slug, moving its page with it
projects archive <slug>      move the page to archive/ and drop the row
projects render              re-render INDEX.md from the store
```

What each `sync` flag means is in [sync.md](skills/logical-projects/references/sync.md). The page `register` writes and what `current` does to it are in [page.md](skills/logical-projects/references/page.md). What `rename` refuses and leaves undone is in [rename.md](skills/logical-projects/references/rename.md).

## Extend it

No extension point yet, deliberately. A seam nothing needs would be speculative.

## Shared store across machines

Keep a dedicated private repository with the usual `docs/projects/` layout. Set `PROJECTS_ROOT`
to its checkout root, or write `{"root":"/absolute/checkout/path"}` to `~/.projects/store.json`.
The file works for a desktop process that was started before the variable was set. The variable
takes precedence. A `.projects-store.json` containing `{"version":1}` at the checkout root opts
into two-way synchronization with `origin/main`; an ordinary local portfolio keeps its behavior.

Every CLI invocation refreshes a shared checkout. Its own post-commit hook pushes committed
changes in the background. Run `node skills/logical-projects/store-sync.mjs <checkout-root>`
from this plugin for scheduled sync; this is separate from the existing `projects sync` reality check.
Sync merges disjoint edits, regenerates a conflicting generated index, and aborts real source
conflicts. Offline and uncommitted work stays local. Exceptions go to `.git/projects-sync.log`
and are reported by the CLI. Existing custom commit hooks are preserved; use the schedule for
those narrative commits. Checkouts must be on `main`, with an existing Git identity and credentials.

## Details

- The store is `docs/projects/entries/<slug>.json`, one file per project, so edits to unrelated projects never conflict. On an `INDEX.md` merge conflict, take either side and run any `projects` command, which regenerates it. The store format, the write-guard's file list and the upgrade path from the old packed `_projects.json` are in [store.md](skills/logical-projects/references/store.md).
- Tests: `cd logical-projects && npm test`.

MIT.
