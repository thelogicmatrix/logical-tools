---
name: runbooks
description: 'Use when writing, retyping, merging, retiring or linting a runbook, when gating a purpose line before it lands, when the runbooks lint or router check fails, or when setting up runbooks in a repo. The written standard for typed runbooks the router injects per prompt. Extend it with your own standard files in .runbooks/standard/.'
---

# runbooks: the written standard

A runbook is a markdown file in the runbooks folder with a typed header. Two hooks read the
folder. The router runs on every prompt and injects the runbooks whose purpose line matches
the task. The index runs at session start and names the files a prompt cannot route. This
skill is the standard those files are written to.

`<plugin>` below is the plugin root. It is `../..` from this skill's base directory, which is
shown when the skill loads.

## Read the standard first

The rules live in four references. Read the one the task needs.

| Task | Read |
|---|---|
| Header fields, genres, `## Steps`, gotchas, the lint's rules | [references/format.md](references/format.md) |
| Creating, retyping, merging, retiring, the health check | [references/lifecycle.md](references/lifecycle.md) |
| Writing or fixing a purpose line, the 0.85 gate | [references/purpose-lines.md](references/purpose-lines.md) |
| Setting up runbooks in a repo, `.runbooks/` config, nudges, lint rules, standard files | [references/extending.md](references/extending.md) |

**Your standard files come too.** Find `.runbooks/` (the git top of the working directory
first, then the working directory, then `~/.runbooks/`, first found wins) and read every
`standard/*.md` in it alongside `references/`. A file there with the same name as a reference
overrides that reference. A new name adds to the set.

**The four extension points** all live in `.runbooks/`. The details are in
[references/extending.md](references/extending.md).

- `config.json` sets `dir`, `firesAt` (0.8), `writeBar` (0.85), `maxInject` (6), `shortlist` (30)
  and `ledger`. The runbooks folder is `RUNBOOKS_DIR`, then `dir`, then `docs/runbooks/` at the
  git top, then `~/docs/runbooks/`, skipping any that do not exist. A `dir` from `~/.runbooks/`
  ranks below another repo's own `docs/runbooks/`. A worktree of home counts as home.
- `nudges/<name>.mjs` exports `fn({ root, dir, entries })`, which returns a string or null for a
  session-start line, under a 1.2 second deadline.
- `lint/<name>.mjs` exports `fn({ slug, text, header })`, which returns a list of violation
  strings.
- `standard/<name>.md` adds a writing rule, or overrides a bundled reference of the same name.

## The five genres

The genre decides what a runbook costs and how it reaches a session.

| Type | What it is | How it reaches a session | Cost |
|---|---|---|---|
| `procedure` | Steps you run, in order | Router, per prompt, when its purpose matches | One router question per prompt |
| `standard` | A rule you must not break | Router, per prompt, when its purpose matches | One router question per prompt |
| `reference` | A lookup table, map or profile | Router, per prompt, when its purpose matches | One router question per prompt |
| `residual` | What is wrong on purpose in one code path | Session-start tail, slug only | A few words every session |
| `postmortem` | What was tried and why it ended | Session-start tail, slug only | A few words every session |

A retired file of any type never routes. At the top level it is named in the session-start
tail as "do not re-propose", which every session pays for.

## The header

Fields in this order, and only these five:

    # <Name>
    **Type:** procedure | standard | reference | residual | postmortem
    **Status:** retired YYYY-MM-DD — why
    **Project:** project slug, or comma-separated slugs when shared
    **Purpose:** one line, the tasks a reader is doing when they need this file.
    **Run:** the single entry command
    **Verified:** YYYY-MM-DD

`Type` and `Purpose` are required. `Project` is required when config lists allowed `projects`, including in retired files. `Status` appears only on a retired or dormant file. `Run` is
for procedures only. `Verified` records the last check against reality. The router shows each
routed runbook's age from it. Past 30 days, or with no date, it asks the agent to check a fact
against the live system before acting on it and then set `Verified` to today. The em dash in the
retired line is required by the lint.

## The commands

Run these from the repo that holds the runbooks. They find the folder the same way the hooks do.

| Command | What it does |
|---|---|
| `node <plugin>/scripts/index.mjs --lint` | Lints every header. Exits 1 on a violation. Also prints advisories that never fail it. |
| `node <plugin>/scripts/check.mjs <runbook.md> "<prompt>" "<prompt>" "<prompt>" --not "<prompt>"` | Scores one purpose line through the live router. Add `--purpose "<text>"` to trial a rewrite, `--record` to save a passing run to the ledger. |
| `node <plugin>/scripts/check.mjs --changed` | Re-scores only the purposes that moved since their ledger entry. Add `--dry` to list them free. Over 20 calls it needs `--yes`. |
| `node <plugin>/scripts/router.mjs --selftest` | Checks the router offline, with no API call. |
| `node <plugin>/scripts/projects.mjs pack --project <slug> --output <path.zip>` | Makes a local ZIP of tagged live and retired runbooks. Repeat `--exclude <relative-path>` to omit reviewed files. A scan finding stops the pack. |
| `node <plugin>/scripts/projects.mjs retire --project <slug> [--apply]` | Previews moves and tag removals. `--apply` edits live runbooks after collision and dirty-file checks. |

`check.mjs` makes one API call a prompt, about $0.0004 each. The lint and `--dry` are free.

## Rules that do not bend

- A purpose line is one physical line. Only the first line reaches the index and the lint.
- A standard or reference purpose is 25 words or fewer.
- A new or changed purpose passes `check.mjs` before it is committed.
- Retire, do not delete. The steps are in [references/lifecycle.md](references/lifecycle.md).
- Never put other people's personal details in a runbook. Every prompt and every purpose line is sent to OpenRouter.
