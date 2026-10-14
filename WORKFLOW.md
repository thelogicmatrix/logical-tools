# The workflow behind logical-tools

The plugins in this repo come out of one person's daily work with AI coding agents. This page describes that work: what a day looks like, which plugin does which part, and the rules behind them. You can take the rules without installing anything.

If you want an AI to read this for you, point it at [AGENTS.md](AGENTS.md).

## The idea

The agent does the work. The repo remembers it. The plugins are habits written down so the agent keeps them.

Three rules shape all of them:

1. **Memory lives in files, in git.** A model forgets everything when the session ends. Anything worth keeping goes into a markdown file the next session can read: a handoff, a runbook, a research note, a project page. Git keeps every version.
2. **If no thinking is needed, a script does it.** Listing projects, shelving one, counting sessions, checking a recipient's address: each is a CLI call that costs no model tokens. The model is kept for judgement.
3. **Your changes live outside the plugin.** Most plugins read a dot-folder in your repo (`.gtg/`, `.runbooks/`, `.dd/` and so on) for your own commands, rules and checklists. postman keeps its identities in your home folder instead. Updates never touch it, so you can bend a plugin to your setup and still take every update.

## A working day

### Starting

Say `gtg <project>` in a new session. [gtg](gtg/README.md) prints the handoff the last session wrote: where it stopped, the one next action, decisions already made and open questions. The agent carries on from the next action with no re-explaining.

From the first prompt on, [runbooks](runbooks/README.md) work in the background. A cheap model reads the one-line purposes of the likeliest runbooks, picks the ones that apply to the prompt, and the agent reads those before it answers. The agent gets the restore procedure when you ask about a backup, and nothing else the rest of the time.

**Take away:** end every session with one written next action, and start the next one from it.

### Working

Each project gets its own git worktree and branch, and lands through a pull request. Several agents can then work in the same repo at once without trampling each other.

When the agent learns something the runbooks lack (a step that failed in a new way, a fact about a machine, a rule you just settled), it edits the runbook before the next step. The knowledge is in place the next time any session needs it, instead of in a chat log nobody reopens.

Two plugins handle reading that would swamp a session:

- [logical-research](logical-research/README.md) reads a question's sources, or a whole channel, book or docs site, in full. It writes a file where every claim is graded and traced to its source, so the work is done once and reused.
- [jevtools](jevtools/README.md) has a fast, cheap model read a body of text too big to read in full and pass back only the parts worth the agent's attention.

**Take away:** write a fact down where it will be found the moment you learn it, and let a cheap model filter before an expensive one reasons.

### Before anything leaves

Nothing goes to another person unchecked: an email, a release, a published page.

- [due-diligence](due-diligence/README.md) sends a critic after finished work, armed with named checklists for the ways work goes wrong, such as an invented figure or silently dropped data. A corrector fixes or disproves each finding. A quick check is one pass, and the deeper settings repeat until the critic finds no real defect. `cdd` hands the agent the same checklists before it builds, so the review has less to find.
- [postman](postman/README.md) sends email from your own mailbox. It checks every recipient, shows exactly what will go, and sends nothing in a batch if any reply cannot find its thread.

**Take away:** review against named checklists, not a general "look this over", and have the agent show you the exact outbound text before it sends.

### Leaving

Say `gtg`. The agent writes the handoff, and the CLI adds what it can read from disk (the task list, this session's commits, the files touched) and commits it.

When a long session's context fills up, `gtg refresh` writes the handoff and opens a fresh [T3 Code](https://t3.codes) thread that resumes it. The work carries on with a clean context and no copy-paste. `gtg migrate <device>` does the same on another machine.

**Take away:** leave a session on purpose with a written handoff. Don't wait for a session to run out.

### Across weeks

- [logical-projects](logical-projects/README.md) keeps one page per project and a generated index of all of them, and checks both against the real repos so the list never quietly goes stale.
- [logical-learning](logical-learning/README.md) runs study sprints around something you want to build, one concept per session, each ending in a pass/fail gate the learner does not mark.

## The setup it runs on

None of this needs the same setup, but it explains some choices.

- **[T3 Code](https://t3.codes) as the cockpit.** One window holds threads from Claude Code and Codex side by side, on several machines: a desktop, a laptop and a home server running T3 in a container. `gtg refresh` and `gtg migrate` are built on it. They are the reason T3 is the recommended way to run these plugins.
- **Claude Code and Codex both.** Every plugin is one source for both harnesses, not a port. A plugin with hooks may ask Codex to trust them once.
- **A self-hosted git server as the shared store.** gtg can keep its handoffs as record files in a Forgejo or Gitea repo ([forge-store.md](gtg/skills/gtg/references/forge-store.md)), so every machine and every agent sees the same list. logical-projects can sync its portfolio through a shared repo too.
- **The home folder is a git repo.** Runbooks, handoffs and agent settings sit in one repo every session shares. Notes and docs are committed straight to it. Code goes through worktrees and pull requests.
- **A private repo, published by hand.** Work lands in a private copy of this repo first. The public one gets a release once a scan for private names and addresses passes.

## How to adopt it

Pick a level.

1. **Read only.** Take the rules: memory in files, one next action, scripts for bookkeeping, outbound checks with named checklists, your changes kept outside the tools.
2. **Copy a skill.** Most plugins are a plain skill folder you can copy into `.claude/skills/`. A copy never updates, which suits trying one out.
3. **Install.** Add the marketplace and install what you want. The plugins are independent. [README.md](README.md#install) has the commands, and each plugin's README lists what it needs.

gtg and runbooks give the most for the least setup. gtg needs Node 18 or later and git. runbooks needs Node 20 or later and an OpenRouter key.
