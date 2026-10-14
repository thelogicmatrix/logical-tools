---
name: logical-projects
description: 'Use when the user says "projects", "project status", "portfolio", "projects sync", "projects log", "register <project>", or "triage critiques", when a new project needs a portfolio row, or when a critique or future-direction note needs a home. The portfolio layer above gtg and living-docs, over the projects CLI.'
---

# projects: the portfolio layer

`docs/projects/` is cold-resume memory across more projects than fit in one head, plus
steering via each page's Future Directions. It is deliberately *not* a
what-should-I-do-today dashboard.

`projects` below is `node "${CLAUDE_PLUGIN_ROOT}/skills/logical-projects/projects.mjs"`. Store:
`docs/projects/` in the current git repo, or `$PROJECTS_ROOT` when set. A persisted
`~/.projects/store.json` supplies its `root` when the variable is unset. Narrative edits use
that configured root's `docs/projects/`, too. The CLI owns every
mechanic: it renders `INDEX.md` from `docs/projects/entries/<slug>.json`, one file per project,
on every mutating verb (a hand-edit is overwritten), a write-guard hook denies `Write` and `Edit`
on both, and each mutating verb commits only the files it touched.

| Trigger | Do this |
|---|---|
| "projects" / "project status" / "portfolio" | `projects`, relay verbatim. `projects <theme>` lists one section. **Stop.** |
| status prose changed for a project | `echo "<body>" \| projects current <slug>`. **Stop.** |
| a project started, paused, went background or finished | `projects status <slug> active\|paused\|ops\|done`. **Stop.** |
| a new project needs a row | `projects register <slug> --theme <t> --name "<N>" --status <s> --where "<W>" --repo <R>`, then write the narrative into the page. `--theme` is required and never guessed: ask which of work, job-search, tooling, homelab, worldbuilding, personal. Page rules and when to set `--repo`: [references/page.md](references/page.md). |
| "projects sync" | `projects sync`, then act on the flags per [references/sync.md](references/sync.md). The user arbitrates concept-level truth, never rewrite a narrative to match reality without asking. |
| a project is done | Confirm with the user, then `projects archive <slug>`. `status done` leaves the row; `archive` moves the page into `archive/` and drops the row. |
| a project moved worktree, got a repo, or changed name or theme | `projects set <slug> --where "<W>" --repo <R> --name "<N>" --theme <t>`, only what changed. `--repo ""` clears it; `--theme ""` is refused with exit 2, every row has a theme. |
| a slug is wrong, ugly or disagrees with gtg's | `projects rename <old> <new>`. Relay its `NOTE:` lines. Never rename by hand. Details: [references/rename.md](references/rename.md). |
| "what happened to X" / "when did I last touch X" | `projects log [slug]`, relay it. **Stop.** |
| `INDEX.md` disagrees with the store | `projects render`. Never fix the table by hand. |
| a critique or a stray idea needs a home | `CRITIQUES.md`, or the project page's Future Directions. **Stop.** |

**Zero-model rule:** shell out, relay the output, never re-derive a number the CLI printed.
Every mutation takes the **slug**, never a list number, because list numbers re-sort. The
slug is the bracketed token on the list row. Never read the store files for it, and never
take it from a page filename, which diverges the moment either is renamed:

```
Tooling:
  1. Demo Project [demo] (active): Registered 2026-08-04. No status written yet.
```

`Migrate it first` means `INDEX.md` still holds a hand-typed table never migrated into the
store. Every verb refuses on purpose. Stop and tell the user; do not hand-write the store and
do not touch the table.

A merge conflict in `INDEX.md` is noise: it is a rendered file with no meaningful merge. Take
either side and run any `projects` command, which regenerates it from the store.

**You own** the narrative, Future Directions, and the body text passed to `current`.
Everything else is the CLI's.

**Seams.** A gtg wrap distils its handoff into `projects current` and `projects status`;
resume flips status back to `active`. A living-docs project keeps its session entries in
its own `docs/`. `CRITIQUES.md` is a drop point only.

**Do not read a reference file unless its row fired.**
