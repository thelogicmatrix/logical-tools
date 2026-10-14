# Extending runbooks

Your tier is a `.runbooks/` folder. The plugin only reads it, so an update never touches it.

## Where `.runbooks/` is found

The first of these that is a folder wins. Folders are never merged.

1. `.runbooks/` at the git top of the working directory
2. `.runbooks/` in the working directory itself
3. `~/.runbooks/`

Outside a git repo, or with git unavailable, the working directory stands in for the git top.

## Where the runbooks folder is found

The first of these that exists as a folder wins. A missing candidate is skipped.

1. the `RUNBOOKS_DIR` environment variable
2. `dir` in `.runbooks/config.json`
3. `docs/runbooks/` at the git top of the working directory
4. `~/docs/runbooks/`

When the `.runbooks/` in use is `~/.runbooks/` reached from a repo other than home, 2 and 3 swap:
the repo's own `docs/runbooks/` beats home's `dir`, and home's `ledger` and topics map do not apply
to it. Home and every worktree of home (its `.git` file points at home's `.git`) count as home
on any branch, so an old branch's `docs/runbooks/` copy never wins over the store.

With none found, every hook prints nothing, and the lint and `check.mjs` exit with an error.

## 1. `config.json`

Every key is optional. A missing or unreadable file, or one that is not a JSON object, counts as
empty.

| Key | Default | What it sets |
|---|---|---|
| `dir` | see above | the runbooks folder |
| `firesAt` | `0.8` | the score a runbook needs to be injected |
| `writeBar` | `firesAt + 0.05`, so `0.85` | the score `check.mjs` needs from each task prompt |
| `maxInject` | `6` | the most runbooks injected on one prompt |
| `shortlist` | `30` | how many top-ranked runbooks the word match keeps, before every standard is added back |
| `ledger` | `<runbooks folder>/.router-ledger.json` | where `check.mjs --record` writes |
| `projects` | unset | allowed project slugs for lint, local packs, and retirement |

A relative `dir` or `ledger` resolves from the folder that holds `.runbooks/`. A relative
`RUNBOOKS_DIR` resolves from the working directory. A `writeBar` below `firesAt` counts as unset.

## 2. `nudges/<name>.mjs`

A line of your own at session start, printed after the tails. The default export is a function
`fn({ root, dir, entries })`:

- `root` is the `.runbooks/` path, `dir` the runbooks folder.
- `entries` holds one parsed header per top-level runbook: `slug`, `type`, `status`, `purpose`,
  `run` and `order`.
- It returns a string to print, or null for nothing. It may be async.

All nudges start at once under a shared 1.2 second deadline, and the deadline counts their import
time too. A throw, a non-string or a nudge still pending at the deadline drops that nudge only. So
keep any timeout inside a nudge, a network call's included, well under 1.2 seconds, or the nudge is
dropped before its own timeout can fire. An import still pending at the deadline drops every
nudge, so keep slow work out of a module's top level. A file that throws on import, or whose
default export is not a function, is skipped, and so is any `*.test.mjs`, here and in `lint/`.

### `skill-nudges/<name>.mjs`

A line of your own when a skill loads, printed after the skill's runbook lines. The default export
is a function `fn({ skill, topics, resolved })`:

- `skill` is the skill's name, as the agent called it.
- `topics` holds the skill's declared topics, each `{ topic, at }`, with `at` a list of steps.
- `resolved` holds the topics that map to a runbook, each `{ topic, at, file }`, with `file` the
  runbook's path inside the runbooks folder.
- It returns a string to print, or null for nothing. It may be async.

They run like `nudges/`, under a 500 ms deadline shared by all of them, import time included. A
skill that declares no topics, or whose `runbooks:` block can't be read, runs none of them.

## 3. `lint/<name>.mjs`

A rule of your own for `index.mjs --lint`, run once per runbook. The default export is a function
`fn({ slug, text, header })`:

- `slug` is the file name without `.md`, `text` the whole file.
- `header` is the parsed header: `type`, `status`, `purpose`, `run` and `order`.
- It returns a list of violation strings. They print and count like core violations, so start
  each with the slug, as the core ones do.

A rule that throws or returns something other than a list adds nothing, so one broken rule never
hides the core violations.

## 4. `standard/<name>.md`

Writing rules of your own. Read every `standard/*.md` alongside this skill's `references/`. A
file with the same name as a bundled reference (`format`, `lifecycle`, `purpose-lines`,
`extending`) overrides it. A new name adds to the set.

## Project packs and retirement

Add `**Project:** slug` after `Status`, if present, and before `Purpose`. Separate shared project slugs with commas. With a `projects` list in config, lint checks every top-level and retired runbook for a valid tag. Project tags do not affect routing.

`node <plugin>/scripts/projects.mjs pack --project <slug> --output <path.zip> [--exclude <relative-path>]` creates a local ZIP of tagged live and retired runbooks and their same-slug companion folders. Its README lists the included runbooks, exclusions, and links outside the pack. The command refuses an existing ZIP, symbolic links in selected content, and scanner findings. It needs `gitleaks` and PowerShell on Windows or `zip` on Unix. The scan reports file and line, not matched values. Review the files and their audience before sharing a pack. The command never sends it.

`node <plugin>/scripts/projects.mjs retire --project <slug>` previews the live files it would move or remove a tag from. Add `--apply` to edit them. Exclusive files receive a retired status and move to `retired/`. Shared files stay live and lose only that slug. Already retired files and companion folders stay in place. Commit the resulting edits in the runbook store after checking the diff and lint.
