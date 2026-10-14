# jevtools: primitive tools made for big work

Some text is too long or too costly for your agent to read in full. jevtools has a fast, cheap model read it first and hands back only the parts worth your agent's attention.

## What it is

Jev is a judgement model (`jev-latest` on OpenRouter). It answers typed questions about a text, such as a yes-or-no probability, a score or a pick from a list, and writes no text of its own. Code splits the text and asks the questions. Jev judges each part. You read only what it flags.

- **jevchecker** (a skill). Sweeps a large body for a criterion a regex cannot express and returns a ranked shortlist. It ships one sweep, which checks a tailored resume bullet by bullet against the resume it came from.
- **jevclick.** Picks the element to click from a browser accessibility snapshot, so the agent never reads the snapshot.
- **jevmail.** Tags a mailbox window from postman (rejection, interview invite, needs a reply and so on), or finds the message and link that answer a plain-English question. It refuses the `work` identity in code, before anything is read or sent.
- **jevmail.triage.** Turns jevmail's tags into a filing plan and a digest of what needs a person. It proposes and never files.
- **jevclassify.** Labels every repo on a Forgejo server from its metadata. It reads the server from `FORGEJO_URL` and the token from the Forgejo CLI's `keys.json`.
- **jevdrift.** Finds rules stated in two markdown files that disagree.
- **jevescalate** (a library). Sends only the answers Jev was unsure of to a bigger model for a second opinion.

A hit is a signal, never a verdict. Read the flagged part before acting on it.

## Install

Add the logical-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install jevtools@logical-tools        # Claude Code
codex plugin add jevtools@logical-tools       # Codex
```

You need Node 20 or later and an OpenRouter key, read from `OPENROUTER_KEY_JEVTOOLS` in the environment or `~/.jev.env`, with `OPENROUTER_API_KEY` in either place as the fallback. jevmail's search also needs Python and the postman plugin installed. It runs the newest postman in your Claude Code or Codex plugin cache, or the `postman.py` that `POSTMAN_PY` names, and stops with the install command when neither is there.

## Commands

`<plugin>` is the plugin's install folder. Each script's options are in its header comment.

```
node <plugin>/skills/jevchecker/jevchecker.mjs <body> --sweep <sweep.json> [--source <file>]
node <plugin>/scripts/jevclick.mjs --snapshot <file> --goal "<what to click>"
node <plugin>/scripts/jevmail.mjs --ask "<question>" --identity <id> --query "<gmail query>"
node <plugin>/scripts/jevclassify.mjs > repos.md
node <plugin>/scripts/jevdrift.mjs --root docs
node <plugin>/scripts/spend-report.mjs [--since YYYY-MM-DD] [--json]
node --test <plugin>/scripts/*.test.mjs             offline tests, no API call
node --test <plugin>/skills/jevchecker/jevchecker.test.mjs
```

## Extend it

A new jevchecker sweep is one JSON file in `skills/jevchecker/sweeps/`. The format and how to word a check are in the jevchecker skill.

## Jev spend

Jevtools and runbooks append the API's usage receipts to `~/.local/state/jev-spend/calls.jsonl`.
Set `JEV_SPEND_LOG` to use another path. `spend-report.mjs` groups reported cost by tool,
activity and session. Runbook routing uses `active_route`, while `check.mjs` purpose-line
tests use `purpose_test` and name the runbook being checked. The report also shows the old
router log as unclassified history and names Hindsight's separate reranker as unallocated.

The journal stores no prompts or runbook text. A failed call without a usage receipt has
unknown cost, not zero. A 30-day run rate appears only after seven complete UTC days of
journal coverage. It projects observed local spend, not the provider's full bill.

## Details

- Every call goes to OpenRouter's System One endpoint with a 60 second timeout and up to three attempts (network errors, 408, 429 and 5xx, with backoff). `scripts/lib.mjs` holds the shared key lookup, call and retry.
- jevclick says to click only at 0.95 confidence or higher. Below that it says to hand the snapshot to the agent instead. With `--json` it exits 0 on ACT, 2 on HOLD and 3 when the Jev call failed.
- jevmail's search stops before any call when the narrowing still matches more than 60 messages.
- jevchecker exits 0 whenever the sweep ran, whatever it found, so it cannot serve as a gate.
- jevclassify looks for the Forgejo CLI's `keys.json` under `%APPDATA%` on Windows and `$XDG_DATA_HOME` (or `~/.local/share`) elsewhere. macOS is not handled. It reads six repos at a time, and a repo it cannot read is listed as unknown.
- Before 2026-09-24 these scripts lived in a private monorepo as `scripts/jev-sweep/` and `.claude/skills/jevchecker/`.
