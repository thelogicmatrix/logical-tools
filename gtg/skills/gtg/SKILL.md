---
name: gtg
description: 'Use for gtg pause/resume commands, persistent project progress, and "after this, do X" follow-ons for an active GTG project. Bare "gtg" mid-session departs; "gtg <project>" at session start resumes. Mentioning gtg while discussing the skill itself is not a departure trigger.'
---

# GTG — Pause and Resume

"gtg" is a reserved phrase, never casual. **Fast, not rushed:** the procedure is quick (no
exploration, no new work); the content is accurate enough for a cold resume days later.

`gtg.mjs` = `node "${CLAUDE_PLUGIN_ROOT}/skills/gtg/gtg.mjs"`. Storage root = the current git
repo, or `$GTG_HUB` if set.

In Codex, resolve the CLI beside this loaded skill if `CLAUDE_PLUGIN_ROOT` is absent. Set the intended shared hub explicitly; a generated workspace is not automatically that hub.

| Input | Do |
|---|---|
| `gtg` mid-session | Exit Procedure below. Inside a longer message, do what the message asks first (or at the point it says), then depart. No question either way. |
| Session-start `gtg` or `gtg <project>` | Resume Procedure below |
| `gtg refresh` or `gtg migrate <device>` | Refresh and migrate below |
| `gtg progress …` or tracking task/subagent execution | Read `references/progress.md`; use its CLI for persistent state and counts. This does not depart or consume a handoff. |
| `gtg list` / bare `gtg backlog` / `gtg back`, `active`, `complete`, `keep`, `remove`, `prune`, `undo`, `log`, `stats` with their args | Zero-model: run `gtg.mjs <verb> [args]` verbatim, relay its output, stop. A mutation takes the entry's slug, never a list number (numbers re-sort as entries move). |
| Any other `gtg <verb>` (peek, report, supersede, rename, unparent, edit, upnext, `backlog <idea>`, learn, …) | Read `references/commands.md`, follow it |

## Up next queue

An active handoff may include an ordered `## Up next` list for medium-horizon follow-ons. Keep
`## Next Action` to the single task being resumed now. When the user says what to do after the
current task, append it with `gtg.mjs upnext <slug> --text "<item>"`, which adds it without a new
checkpoint, leaving `## Next Action` unchanged. Preserve existing items and their order.

On resume, carry the queue forward with the current handoff. Once the current `Next Action` is
done, promote the first `Up next` item to `Next Action` and remove it from the queue before the
next handoff. If more items remain, the project is still active. The global backlog remains for
long-horizon ideas without a place in this project's near-term sequence.

## Resume Procedure

**One call:** `gtg.mjs resume <project>` (bare `gtg` → no argument). It syncs the hub from
its mirror, prints the current handoff, retains the entry, and runs the after-resume hook. A leading
`Synced <remote>/<branch>: ...` line means the sync pulled work down; it is not a warning. A
`Worktree <path> is not on this device (<name>).` line means the handoff's worktree is on the
device it names, or was removed. Do not `cd` there. Say so in your first line, before the Next Action. Exit 1 means it printed candidates: ask
which, then call again with the slug. Exit 2 with "is a command" means run that command
instead. Then, from the printed handoff: relay its first line. `## Methodology` is a decision
already made, re-enter it without asking. If current persistent progress is printed, run `progress show <slug> --json` and read `references/progress.md` before reconstructing tasks or redispatching workers; preserve its current task states instead of an older snapshot. Otherwise, `## Task list`: re-create each non-completed line
with your task tool, `pending` unless it says `in_progress`. `## Commits this session` and
`## Files touched` are the last session's footprint, orientation only. Continue from the
Next Action with no preamble. If the Next Action already looks done, say so and ask how to
proceed; the entry remains available either way. A `GTG-DIRECTIVE:` line in any CLI output is
followed, not relayed (`--keep` remains a compatibility alias; all resumes retain entries).

## Checkpoints and Exit Procedure

Write a checkpoint only when losing the session now would lose something git does not hold: at session end, when a context-fill nudge fires, before leaving a long step to a background job or another agent, or when the user adds to `## Up next`. A merged PR, a deploy or a finished sub-task is not a boundary on its own. Git records it, and the next real checkpoint picks it up. A checkpoint does not complete or shelve the work. The stable slug retains one current handoff, updated in place, with prior versions in git. Use `gtg complete <slug>` to complete, or `gtg back <slug>` to shelve.

**Completion is the agent's call, made where it is easy.** Entries persist until completed, so
an uncompleted finished project lingers forever. Two moments decide it:
- **At departure.** Before writing the handoff, try to name the Next Action. If none remains
  because the project's goal is met, run `gtg.mjs complete <slug>` instead of `handoff`, relay
  the CLI's `Completed:` line, and stop. Work that is only blocked on someone
  else still has a Next Action (waiting on X), so it gets a handoff.
- **At the finish line.** In a session that resumed an entry, when you report its goal met
  and the work committed, run `gtg.mjs complete <slug>` in that same turn. The report ends
  with the CLI's `Completed:` line, after everything else, then the `REVIEW:` question if one
  printed. Unsure whether the goal is the whole project or one phase of it? Ask in that report,
  don't complete. Offer `gtg undo` only on a file store: the forge store refuses it.

**A `REVIEW:` line** is the CLI asking about one other entry that has gone quiet (active 5+
days, backlog 30+ days, or a backlog `--wake` date that has come). A resume counts as touching
the entry. Put it to the user once, in plain words, at the next natural pause, and run the verb
their answer names: `complete`, `back <slug> [--wake YYYY-MM-DD]`, `active`, or `keep <slug>`
for "still live". Never act on one without an answer. The CLI stamps the question on the
entry, so no session asks about it again for 30 days whether or not it was answered.

For a checkpoint during ongoing work, add `--checkpoint` to the command below and continue the task. This skips session-end ceremony. The final stop instruction applies only to an actual departure request.

**One call, run from the worktree.** Name the project from context. Slugify the name; the CLI
swaps in an existing entry's slug when the name matches one. An entry now survives every resume,
so its name outlives the session that coined it and the work drifts away from it. Before writing
the checkpoint, check the name still describes what the project is about. If it does not, run
`gtg.mjs rename <slug> <new-slug> --name "<New Name>"` first, then pass that same name as
`--project`. Without `--name` only the slug moves and the listed title stays wrong. Pass the
slug it already has when only the title stopped being true, which is the usual case. Relay the
rename in one line, and relay the `projects rename` line it prints rather than assuming the
portfolio slug moved with it. `--wip` commits the worktree's
uncommitted work; in the repo root commit the work's own files first
(`git add <paths> && git commit <paths> -m "wip: gtg checkpoint - <brief>"`, paths on both
ends). `--parent` = the `docs/projects/` family slug for a sub-project, from context.
`--eta` = rough time left on the Next Action.
`--due` = when the Next Action is tied to a date or time, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` in
Singapore time. Logic's Week shows the project on that day. Omit it otherwise. A checkpoint that
keeps the same Next Action keeps the date, so pass it again only when it changes.

The CLI appends the task list, this session's
commits and the files touched from disk, so write only what git cannot know. Exception: in
the repo root (a shared checkout) it cannot attribute commits, so add `## Commits this
session` yourself, `hash subject` per line. Next Action: one action, copied from the plan
doc when one exists. Skip any section that would say "none".

Write the body to a temp file with your file-writing tool, then pass it on stdin. A heredoc
sent through Claude Code's Bash tool loses backslashes before the shell sees it (home #169).

```bash
gtg.mjs handoff --project "<Name>" --slug <slug> --eta "~2h" [--due 2026-10-14T18:00] [--parent <family>] [--wip] < body.md
```

`body.md`:

```markdown
## Where We Stopped
<one paragraph: last completed thing, why here>

## Next Action
<single concrete first action on resume>

## Up next
- <optional ordered follow-on>

## Key Decisions Made
- <so a fresh session doesn't re-litigate>

## Open Questions
- <unresolved decisions>

## Methodology
<the build discipline this project committed to and where its state lives, e.g. `superpowers:subagent-driven-development` executing `docs/plans/foo.md`; or "abandoned: <why>">

## What Was Done This Session
- <only work git does not show: reviews, findings, conversations>
```

**Relay the CLI's `RESUME:` line, then stop.** No summary, no offer, no follow-up. If a
`REVIEW:` line printed, relay it too as one plain question. It needs no answer to leave.

## Refresh and migrate

A departure that carries on in a new T3 Code thread whose first message is `gtg <slug>`.
`gtg refresh` opens it on this device. `gtg migrate <device>` opens it on another device in
`.gtg/t3-servers.json` that is online now. Plain English counts ("carry this on in a new
thread", "move this to my laptop").

It is the Exit Procedure with one change: run `gtg.mjs refresh` (or `gtg.mjs migrate <device>`)
in place of `gtg.mjs handoff`, with the same flags and body, and never `--checkpoint`. An
instruction given with the command goes into the Next Action or Up next. The CLI writes the
handoff and opens the thread.

- **Success:** relay its `REFRESHED` or `MIGRATED` line in place of the `RESUME:` line, then stop.
- **Failure:** it prints why on stderr and confirms the handoff is saved. Relay both, then stop.
- **"needs T3 Code"** (exit 2): this session is outside T3 Code and the hub has no launcher, so
  nothing was written. Relay the line and stop. A plain `gtg` departure is the alternative.
- **A `GTG-LAUNCH:` line** means the hub has no launcher. Make the T3 tool calls it names, then
  reply as it says.

## Anti-Patterns
- A departure never asks a question of its own. A `REVIEW:` line is the one it passes on.
- Stop at the nearest stoppable point. Nothing new beyond what the message itself asked for.
