# logical-tools: Mouldable AI tool frameworks

Eight bespoke plugins covering fundamental tools to create cohesive AI workflows, and each modifiable to your specific needs. Built to retain your custom behaviour between updates, while balancing performance, efficiency and cost. 

By [Nathan Wong](https://github.com/thelogicmatrix).

**New here?** [WORKFLOW.md](WORKFLOW.md) shows how the plugins fit into a working day, and the habits behind them you can use without installing anything. Or point your AI at this repo and ask it what to take from it. [AGENTS.md](AGENTS.md) tells it how to answer.

## Install

Add the marketplace, then install whichever plugins you want. They are independent.

```
/plugin marketplace add thelogicmatrix/logical-tools
/plugin install gtg@logical-tools
```

In Codex:

```
codex plugin marketplace add thelogicmatrix/logical-tools
codex plugin add gtg@logical-tools
```

Swap `gtg` for any plugin name below. Both harnesses run the same source, not copied ports. Most plugins are also a plain skill folder you can copy into `.claude/skills/` for a frozen copy that never updates.

Each plugin's README lists what it needs. Most need only Node 18 or later and git. runbooks and jevtools also need an OpenRouter key, and postman needs Python and a Gmail app password. Not sure where to start? gtg and runbooks give the most for the least setup.

### Recommended setup

[T3 Code](https://t3.codes) runs Claude Code and Codex threads side by side, on one machine or several, and it is how these plugins are used day to day. `gtg refresh` and `gtg migrate`, which restart a session in a fresh thread here or on another machine, need it. Everything else works in Claude Code or Codex alone.

## The plugins

### [gtg](gtg/README.md): todo list and handoffs for AI 
Say "gtg" and the agent writes a handoff a fresh session can resume from. Say "gtg <project>" next time and it carries on from the next action. The bookkeeping runs in a CLI, so it costs no tokens. 

Functionally, just a todo list with notes attached, made smart by handoffs and git. Simple in concept, magical in practice. **Extend it** with your own subcommands and after-handoff steps in `.gtg/`.

### [logical-projects](logical-projects/README.md): basic project tracking
A generated index of every project and one page each, and a `sync` that checks both against the repos so the table never quietly goes stale. No extension point yet, deliberately.

### [postman](postman/README.md): the ultimate email manager
Sends cold email and threaded replies from your own mailbox. If any reply in a batch cannot find its thread, nothing sends. **Extend it** with one identity per mailbox, each with its own signature, voice and password command.

### [jevtools](jevtools/README.md): primitive tools made for big work
A fast, cheap model reads a large body of text first and hands your agent only the parts worth its attention. **Extend it** with a new sweep, one JSON file each.

### [due-diligence](due-diligence/README.md): your harshest critic
`due-diligence` sends a critic after your work before anyone else sees it, and `cdd` hands you the same checklists (lenses) before you start. **Extend it** by adding or replacing a lens in `.dd/lenses/`.

### [logical-learning](logical-learning/README.md): your personal tutor
One subject, one project you want, one new concept per session, and a pass/fail gate at the end of each session that you don't get to mark yourself. **Extend it** with your own study tracks in `.learn/tracks/`.

### [runbooks](runbooks/README.md): immediate intelligent context injection
Short files of procedures, rules and lookup tables. On every prompt a cheap model picks the ones that apply and points the agent to them before it answers. **Extend it** with thresholds, lint rules and session-start lines in `.runbooks/`.

### [logical-research](logical-research/README.md): research once, keep it usable 
Reads a question's sources, or a whole channel, book or doc set, in full, and writes context you can paste into a model later, with every claim graded and traced. **Extend it** with reading angles you reuse in `.lr/angles/`.

## How extending works

Most plugins have the same three layers. postman is the exception: its identities live in `~/.postman` in your home folder, not in a repo.

| Layer | Where | Updates? |
|---|---|---|
| Core | the plugin | ships and updates with the plugin |
| Bundled defaults | the plugin | on by default, update with the plugin |
| Yours | a dot-folder in your repo (`.gtg/`, `.dd/`, `.lr/`, `.learn/`, `.runbooks/`) | never touched by updates |

The plugin only reads your folder, so an update cannot overwrite your changes.

## [lib-cli](lib-cli/README.md): the CLI framework

Most plugins do their bookkeeping in a small Node CLI, so the agent spends no tokens on it. `lib-cli/` is the shared code under those CLIs: finding the repo root, parsing flags, a one-file-per-record JSON store, git with a lock retry, and exit handling. It is not a plugin and has no marketplace entry. An installed plugin can't import from a sibling, so each plugin vendors a copy of the files it uses.

To build a new plugin CLI on it, list the files you want in a `.framework.json` next to where the copies will live, run `node scripts/sync-lib.mjs`, and import the copies by relative path. Outside this repo, copy the files you need. They use only Node's built-in modules, plus the git binary for `root.mjs` and `git.mjs`. [lib-cli/README.md](lib-cli/README.md) covers each file and the rules for changing one, and [lib-cli/CHANGELOG.md](lib-cli/CHANGELOG.md) holds its version.

## License

See [LICENSE](LICENSE).
