# logical-learning: your personal tutor

You read about a subject for four weeks, build nothing, and can't tell whether any of it stuck. `learn` runs a sprint around a project you actually want, one new concept per session, with a pass/fail gate at the end of each session that you don't get to mark yourself.

## What a sprint is

A sprint is a few weeks on one subject, anchored to something you want to build or write. Each session teaches one concept and ends on a **mastery gate**. A pass moves on to a new concept. A fail repeats the same concept next session with a different worked example, not a re-read. A short "spot the flaw" **verify exercise** is due at least every two weeks, so it can't quietly get skipped forever.

A **track** sets how one kind of subject is studied, including how the gate is graded. Two ship:

| Track | For subjects that | Examples |
| --- | --- | --- |
| `code` | produce working code | Python, SQL, APIs |
| `concept` | don't | marketing, strategy, theory, design, history |

## How it works

Say "I want to learn X" and the skill fires. It scopes the sprint, picks a track and runs each session. A small CLI keeps the books: week number, concept, gate history and the verify floor. None of it depends on a model remembering last Tuesday.

Two other logical-tools plugins pair with it, and it runs without either:

- **[gtg](../gtg)** keeps the story between sessions: what got built and where you stopped. `learn` holds none of that, and `gtg learn` lists your sprints.
- **[logical-research](../logical-research)** sources each week's concept and can gap-check your plan against real curricula. Link to the pack it returns, never copy it into the sprint. If it is unavailable, the sprint goes on with a "cross-check skipped" note.

## Install

Add the logical-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install logical-learning@logical-tools        # Claude Code
codex plugin add logical-learning@logical-tools       # Codex
```

You need Node 18 or later and git. There are no other dependencies.

## Where things live

Everything lives at the top of your current git repo. Set `LEARN_HUB` to keep one learning hub across many repos instead.

- `.learn/sprints/<slug>.json` is each sprint's state.
- `.learn/tracks/` holds your own tracks.
- `.learn/profile.md` is your learner profile. `learn profile` reads it, and you write it.
- `docs/learning/<slug>/` holds what you write: `sprint.md` for the goal and weekly milestones, then one page per week.

## Commands

`learn` is short for `node <plugin>/skills/logical-learning/learn.mjs`, where `<plugin>` is the plugin's install folder.

```
learn tracks                           list every track, bundled and your own
learn start <subject> --track <name>   create the sprint and its sprint.md
learn week                             what week, what concept, what is due
learn gate <pass|fail> [--verified]    record the gate and advance the week
learn page [concept]                   stamp this week's page from the template
learn brief [--for week|curriculum]    write a brief for logical-research (body on stdin)
learn profile                          read the learner profile
learn help                             print the verb list
cd <plugin> && npm test                the plugin's tests
```

`--verified` records that a verify exercise ran. With more than one sprint, pass `--sprint <slug>`.

## Extend it

Write your own track, or replace `code` or `concept` with a file of the same name in `.learn/tracks/`. A track is six fixed headings, and the skill follows one it has never seen. See [extending.md](skills/logical-learning/references/extending.md).

The defaults (session length, one concept per session, the two-week verify floor, the binary gate) are guesses. [pedagogy.md](skills/logical-learning/references/pedagogy.md) keeps the five cited frameworks behind the design apart from those invented numbers.

## Details

`start`, `gate`, `page` and `brief` commit only their own files. `page` and `brief` never overwrite an existing file. Exit `2` is a usage or environment error, `1` a failure with nothing advanced, `0` success. Commit rules, brief flags and the 0.3.x upgrade note are in [cli.md](skills/logical-learning/references/cli.md).

MIT.
