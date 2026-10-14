# gtg: todo list and handoffs for AI

Walking away mid-task usually means re-explaining everything next session. Say "gtg" and the agent writes a handoff that a fresh session can resume from, with no re-explaining and no re-litigating.

## What gtg is

gtg (Got to Go) is a pause-and-resume skill for Claude Code and Codex, with a small CLI that keeps the records.

- **A handoff.** One markdown document per project: where you stopped, the one next action, decisions already made and open questions. Each checkpoint updates it in place, and git keeps the earlier versions.
- **An entry.** A small record that pins the handoff to your list, either active or shelved on the backlog.
- **The CLI.** The bookkeeping commands (list, shelve, complete, undo) run without a model, so they cost no tokens.
- **Progress records.** Optional per-task state for a long plan, covered in [progress.md](skills/gtg/references/progress.md).

## How it works

Say "gtg" mid-session. The agent names the project, writes the handoff and makes one CLI call from the worktree. The CLI adds what it can read from disk (your task list, this session's commits and the files touched), then commits the handoff and its entry.

In a new session, say "gtg <project>", or just "gtg" when one project is active. The CLI first pulls the latest store down from git, then prints the handoff, and the agent carries on from the next action. A name that fits several projects gets a pick list instead of a guess.

In [T3 Code](https://t3.codes), a session can also restart itself. When the context is full, say "gtg refresh": the agent writes the handoff and opens a fresh T3 thread whose first message is `gtg <project>`, so the work carries on with a clean context. "gtg migrate <device>" does the same on another machine running T3, listed in `.gtg/t3-servers.json`. Both need T3 Code. A migrate also needs either the target's T3 registered as an MCP server in your agent, or a launcher script of your own. Without what they need they refuse and write nothing, and a plain "gtg" is the way to leave. The setup is in [extending.md](skills/gtg/references/extending.md#hooks).

Entries stay until the work is finished. The agent completes one itself when a departure finds no next action left, or when a resumed session meets the project's goal, and `gtg undo` reverses that on a file store. When an entry goes quiet (active work untouched for 5 days, backlog for 30), a command asks you about it, one entry at a time and each entry at most once in 30 days across every session. Resuming an entry counts as touching it.

## Install

Add the logical-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install gtg@logical-tools        # Claude Code
codex plugin add gtg@logical-tools       # Codex
```

Or copy `skills/gtg/` into your project or user `.claude/skills/` as a frozen copy that never updates. You need Node 18 or later and git on PATH.

## Where things live

Handoffs live in your repo, under `docs/handoffs/`, committed to your history. Set `GTG_HUB=<path to a git repo>` to keep one list for all your projects there instead. A `.gtg/forge.json` stores projects on a Forgejo or Gitea forge instead of files ([forge-store.md](skills/gtg/references/forge-store.md)).

Pin the record files in `.gitattributes`, or every command rewrites the whole store after a fresh clone on Windows:

```
docs/handoffs/active/*.json   -text
docs/handoffs/backlog/*.json  -text
```

## Commands

Say these to the agent. The agent runs the matching `gtg.mjs` command.

```
gtg                            leave (mid-session) or resume the only active project (session start)
gtg <project>                  resume a project at session start
gtg list | backlog             active entries | the shelf
gtg show <slug> [--json]       one entry's current handoff, or its record as JSON
gtg list --json                both shelves as JSON, each record with its handoff, for code to read
gtg --version                  installed plugin version, without reading the hub
gtg handoff [--due <date>]      save a handoff, optionally with a due date
gtg backlog <idea>             park a long-horizon idea
gtg back <slug> [--wake <date>]  shelve, optionally until a date
gtg active <slug>              reactivate
gtg complete <slug>            finished (legacy: remove, prune)
gtg supersede <slug> [--into <slug>]
gtg keep <slug>                answer a review question with "still live"
gtg upnext <slug> --text <text> append an ordered follow-on to the handoff
gtg upnext <slug> --edit=<n> --text <text> | --remove=<n> | --move=<n> --to=<m>
                               change one Up next item by position (1 = first)
gtg upnext <slug> --promote    make Up next item 1 the Next Action, clearing the due date
gtg edit <slug> [--next] [--eta] [--due|none] [--parent|none]   change fields without a handoff
gtg apply-queue [--watch]      apply actions queued in Logic (one pass, or a long-running watcher)
gtg rename <slug> <new> | unparent <slug>
gtg log | undo | stats | report
gtg progress init|show|list|update|add
gtg refresh | migrate <device>  depart into a new T3 Code thread, here or on another device
```

`supersede` is for an entry rolled into another or filed in error, which is neither a ship nor an abandonment. `rename` re-points any sub-projects that named the old slug as their parent, and `unparent` clears one entry's parent. `log` reads what happened from git. `report` writes a JSON file that the `reporter` skill turns into an HTML habit-grid report. Full routing is in [commands.md](skills/gtg/references/commands.md).

`apply-queue` serves the author's own planner app, Logic, which queues changes to the store. Without Logic you can ignore it. It needs `LOGIC_URL`, `LOGIC_AGENT_EMAIL` and `LOGIC_AGENT_PASSWORD`. There is only ever one runner. A one-shot run (scheduled or a manual recovery run) takes the canonical scheduler's existing `flock`, and watch mode relies on the fixed container name `logic-applier`. Watch mode and the cron must never run together. It claims each action atomically, checks the exact current project slug and captured shelf, then runs GTG. Interrupted `applying` actions are failed for review and never replayed. Recovery assumes that single runner; multiple independent runners are unsupported. Project validation is a check immediately before execution, not a transaction spanning GTG and Logic. Per-action progress omits action text; bounded command results are stored in Logic. After each successful command it asks Logic to sync, then marks the action applied, so the board never flashes back to the old value.

`apply-queue --watch` is that single runner as a long-lived process in the `logic-applier` container. It recovers interrupted actions once at start, then applies pending actions every `APPLY_POLL_MS` milliseconds (default 3000) until SIGTERM or SIGINT, finishing the current action and claiming no more. A failed pass is logged and retried on the next tick, and a 401 or 403 signs in again. PocketBase treats an expired token as a guest (empty lists and 404s, never a 401), so the watcher also signs in again before a pass once its token is older than `APPLY_REAUTH_MS` milliseconds (default 21600000, six hours). A result Logic fails to record is retried at the start of each later pass instead of leaving the row in `applying` until restart. If that retry gets a 400 or 404, it signs in again and reads the row, and drops the result only once the row is no longer `applying`. A one-shot run drops it on exit, and the next run's recovery fails the row for review. Set `KUMA_PUSH_URL` to an Uptime Kuma push URL and, after a pass that completes without error, it reports up at most once a minute. Silence therefore means applying is broken, not only that the process died.

Queued existing-project commands use `--exact --expected-shelf active|backlog`. The child checks its own current store before mutation; ordinary CLI calls keep numeric, `bN` and fuzzy matching. Extensions can read fresh authoritative projects with `await ctx.projectEntries()`, a flat array with `shelf: 'active' | 'backlog'`; an unavailable Forge hub fails instead of providing cached authority.

Queued ideas use `--exact --create-only`: an existing generated slug fails without replacing its project or handoff. Forge creates retain an expected-absent POST and never turn a creation collision into an edit. Queued text is passed as an attached literal option value so leading `--` remains text. Automated children skip review questions and their nudge stamps; ordinary GTG calls keep their review behavior.

Automated handoff updates require GTG 4.8.1 or later, discoverable with `gtg --version`.
Pass `--expected-body-sha256 <64hex> --expected-shelf active|backlog` together with
`--project` and the exact `--slug`. Hash the exact UTF-8 `handoff` string returned by
`list --json`, including whitespace. Missing, ambiguous, removed, shelf-changed or
body-changed records reject with exit 2 before body, progress or index writes. A
cached Forge read cannot authorize this update. Old versions ignore unknown handoff
flags, so consumers must verify the version first and never fall back to an unguarded
write. `handoff` still activates a backlog record when its backlog guard matches.
Forge writes retain the original read's SHA and also refuse changed bodies/shelves
on concurrent readback; other fields retain the normal conflict/merge behavior.
Post-comparison Forge failures exit 1 and retain the submitted body in the existing
recovery file. Local files have no cross-process transaction or lock after comparison.

## Extend it

Drop `.gtg/commands/<name>.mjs` into your repo and it becomes a real `gtg <name>` subcommand, no fork. Add `.gtg/after-handoff.mjs` or `.gtg/after-resume.mjs` to run your own steps on each departure or resume. Your `.gtg/` lives in your repo and updates never touch it. See [extending.md](skills/gtg/references/extending.md), which also documents the store and report formats.

## Details

- **Sync on resume.** `gtg resume` fast-forwards the hub from the current branch's upstream (`--ff-only`, 5 seconds). With no upstream set, it falls back to `$GTG_SYNC_REMOTE/$GTG_SYNC_BRANCH` (default `origin/main`), and only on that branch. It prints nothing unless it moved. A divergence says so on stderr and the resume carries on from local state. The forge store skips the sync.
- **Undo is scoped to your session.** Every gtg commit carries a `gtg-session:` trailer from `GTG_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`. Undo only reverts a commit with the calling session's id that is still at the tip of store history, and refuses otherwise. A session with no id cannot undo.
- **Completion verbs write different commit subjects**, and `stats` and `report` read those subjects. Using `complete` for rolled-up work records a phantom ship.
