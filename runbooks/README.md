# runbooks: immediate intelligent context injection

Context is best fresh, relevant and detailed to the task. Runbooks give you that, on the prompt that needs it, without the cost of loading every document into every session.

## What a runbook is

A runbook is a short markdown file of concentrated, useful context. It tells an AI agent how to do one thing, or what rule to follow while doing it. You or your agent writes them (sold separately). Each one opens with a short header:

- **A title.** What it's called, like `# Restoring a backup`.
- **A type.** Which of five kinds it is (table below).
- **A purpose line.** One sentence saying what it's for and when it applies. This is the most important line, because the plugin reads nothing else when it decides whether the runbook is relevant.
- **Optional extras.** The command that runs it, the date someone last checked it was still true, and a note if it has been retired.

Under the header is the body: steps, rules, a table, whatever the job needs.

| Type       | In plain English                | Example                              |
| ---------- | ------------------------------- | ------------------------------------ |
| Procedure  | Steps you follow in order       | How to restore a backup              |
| Standard   | A rule you must not break       | Never print a password into the chat |
| Reference  | Something you look up           | Which server runs which app          |
| Residual   | Something left wrong on purpose | A known bug we decided to live with  |
| Postmortem | Something we tried that ended   | Why we stopped using X               |

The full format is in the `runbooks` skill, which fires when you write, retype, retire or lint a runbook.

## How the right runbook finds you

On every prompt, a fast, cheap model called Jev reads what you asked and scores each runbook's purpose line from 0 to 1. Any runbook scoring 0.8 or higher is named to the agent before it answers, up to six at a time. The agent opens the ones it needs, and the rest cost nothing.

To keep that check cheap, a word match (BM25) first cuts a big collection down to the 30 likeliest runbooks. Rules you must not break are never cut, so a word match can never hide one.

This matters most for standards. You go looking for a procedure because you know you're about to restore a backup. Nobody goes looking for a rule they don't know exists. The plugin brings that rule to you.

Residuals and postmortems work differently. When a session starts, the plugin lists them by name, one line each, so the agent knows what not to re-propose and what not to "fix".

If the scoring call can't run (no API key, no internet), the plugin says so rather than silently doing nothing.

## Three ways a runbook arrives

The router is one of three. The other two watch what the agent does instead of what you asked.

| When | What is matched | Cost |
|---|---|---|
| You send a prompt | The prompt, by one model call | One call per prompt |
| A skill loads | The topics the skill declares in its `runbooks:` frontmatter | Free after each topic is mapped once |
| A command runs | The commands a runbook declares in `**Triggers:**` | Free |

Each one injects a path and a purpose line. The agent reads the file when it needs it.

The skill and command triggers run in Claude Code only for now. Both Claude Code and Codex get prompt routing. Native subagent routing is verified in Claude Code; Codex has the measured gap below.

**Subagents.** Before an `Agent` or `Task` dispatch in Claude Code, the router scores the child's `prompt` and appends matched runbooks through `PreToolUse.updatedInput`. Every other dispatch argument is preserved. Each dispatch has its own dedupe scope, so a parent or another child receiving the same runbook cannot suppress this child's context. If routing fails, the brief receives the usual failure notice and dispatch continues. The same shortlist, score threshold, retry budget, outage breaker and spend receipts apply. Codex's adapter is tested offline with a plaintext `spawn_agent.message` and JSON rewrite contract; those tests do not establish delivery across the encrypted native boundary.

The hook contracts follow the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#pretooluse-decision-control) and [Codex hooks guide](https://developers.openai.com/codex/hooks). Codex requires trusted hooks and its `hooks` feature enabled; its rewrite contract requires `permissionDecision: "allow"` alongside `updatedInput`. Claude's rewrite leaves the permission decision unset.

Verified on 2026-10-01: Claude Code 2.1.286 delivered a live match at 0.90 in a child's first prompt using the production 0.8 threshold and a temporary runbook fixture; parent prompt routing also delivered its match. A fresh codex-cli 0.159.3 capture reported native `PreToolUse.tool_name` as `collaborationspawn_agent` with an encrypted `message`, while `SubagentStart` supplied no task text. The router rejects that native name; allowing it alone would still leave no plaintext task to score and no safe place to append runbooks. Native Codex first-turn delivery remains a measured gap pending supported plaintext hook input.

**Skills.** A skill names topics in its own words, so it works on any host whatever its runbooks are called:

```yaml
runbooks:
  - topic: branching, pushing and opening a pull request on this host
    at: dispatch, landing
```

`at` is optional. It names the skill's steps where the agent should read the runbook.

`node <plugin>/scripts/resolve.mjs --skill <name>` maps each topic to one of your runbooks, with one model call per topic it has not seen, and writes the result to `.runbooks/topics.json`. It writes there only when that `.runbooks/` sits beside the runbooks (`<its parent>/docs/runbooks`), or when its `config.json` `dir` or `RUNBOOKS_DIR` names them, so one repo's map never lands in another's. A topic that no runbook fits well enough is printed as `unresolved:` and left out. You can also write an entry by hand. It needs only a slug: `{ "<topic>": { "slug": "git-workflow" } }`. When the skill loads, the plugin reads that map and makes no call.

The lint checks every skill's topics. For a skill in your project (`.claude/skills` or `.agents/skills`), a topic that maps to nothing or a `runbooks:` block it can't read fails the lint. For a skill from an installed plugin those two are advisories, listed after the violation count, because you can't edit that skill. A topic mapped to a runbook that was renamed or retired fails the lint wherever the skill lives.

**Commands.** Add `**Triggers:** git push, fj pr create` to a runbook's header. The line arrives beside the output of the first matching command in a conversation, so name the earliest command in the flow. It never blocks a command. A runbook the conversation already got, from the router or a skill, isn't sent again until the conversation is compacted.

**By hand.** `node <plugin>/scripts/find.mjs "<topic>"` lists the runbooks that match a phrase, locally and with no key. `--judge` scores them with one model call.

## Install

Add the logical-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install runbooks@logical-tools        # Claude Code
codex plugin add runbooks@logical-tools       # Codex
```

Codex may ask you to trust the plugin's hooks once before they fire.

You need Node 20 or later and an OpenRouter key. The plugin reads the key from `OPENROUTER_KEY_RUNBOOKS` in the environment, then from that line in `~/.jev.env`, then falls back to `OPENROUTER_API_KEY` in the same two places. A key of its own per consumer keeps its spend separate in OpenRouter. It has no other dependencies.

## Where your runbooks live

The plugin uses the first of these folders that exists:

1. the `RUNBOOKS_DIR` environment variable
2. `dir` in `.runbooks/config.json`
3. `docs/runbooks/` at the git top of the working directory
4. `~/docs/runbooks/`

A `dir` in `~/.runbooks/config.json` read from another repo ranks below that repo's own `docs/runbooks/`, so a home-wide pin does not hide a project's runbooks. Home and every worktree of home, found through its `.git` file, count as home on any branch, so they route the pinned store, not a stale copy an old branch carries.

With no folder found, the plugin does nothing, so installing it in a repo without runbooks costs nothing.

## Commands

`<plugin>` is the plugin's install folder.

```
node <plugin>/scripts/index.mjs --lint                     lint every header, exit 1 on a violation
node <plugin>/scripts/check.mjs <runbook.md> "<prompt>" ... [--not "<prompt>"] [--purpose "<text>"] [--record]
node <plugin>/scripts/check.mjs --changed [--dry] [--yes]  re-score only purposes that moved, --yes above 20 calls
node <plugin>/scripts/router.mjs --selftest                offline router check, no API call
node --test <plugin>/test/*.test.mjs                       the plugin's tests
```

The router and `check.mjs` write API usage receipts to
`~/.local/state/jev-spend/calls.jsonl`. The jevtools command
`node <jevtools>/scripts/spend-report.mjs` breaks out active routing, purpose-line tests,
tools and sessions. Set `JEV_SPEND_LOG` to use another path. Old `claude-router/spend.jsonl`
rows remain readable as unclassified history.

`check.mjs` tests a purpose line before you commit it. Give it three or four prompts phrased the way a real task would arrive. Each must score 0.85, and each `--not` prompt must stay under 0.8. `--record` saves a passing run so `--changed` can skip it later.

## Extend it

Change the thresholds, add your own session-start lines, lint rules and writing rules, or tag runbooks by project to pack and retire them together. All of it lives in a `.runbooks/` folder you own, which updates never touch. See [extending.md](skills/runbooks/references/extending.md).

## Details

**The router** runs on every prompt (UserPromptSubmit).

- With more than 30 procedures, standards and references, BM25 keeps the top 30, padded to 30 even where a runbook scores zero. Every standard outside the top 30 is added back. Then it makes one `jev-latest` call on the OpenRouter System One endpoint, about $0.0004 a prompt.
- It injects each match by name, type and purpose.
- Retries fit inside a 4 second total budget. Only a timeout, a 5xx, a 429 or a network error is retried. When all of them fail, the router skips the API for 60 seconds and injects the notice straight away.
- A failure (no key, no network, a timeout, a bad response) injects a short notice saying routing is unavailable, why, and to read the runbooks folder directly.
- A failure that will not fix itself (no key, a rejected key, no credits: HTTP 401, 402 or 403) also shows you a warning on every Claude Code prompt until it is fixed, so routing can't stay down unnoticed. Transient failures stay quiet.
- Once a key is set, a prompt under 12 characters, like "ok" or "yes", injects nothing. With no key, the failure notice fires on every prompt.
- A second copy of the hook on the same prompt exits before the API call.
- Spend, dedupe and outage logs go to `%LOCALAPPDATA%/claude-router/` on Windows and `~/.local/state/claude-router/` elsewhere.

**The index** runs at session start (SessionStart) and makes no API call. It names residuals, postmortems and top-level retired runbooks (as "do not re-propose"), one line each. Your nudges print after them.
