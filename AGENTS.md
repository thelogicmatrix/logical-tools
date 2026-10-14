# For an AI reading this repo

Your user has pointed you at logical-tools and probably asked what to take from it. This file tells you how to answer well. If you are working on this repo's code instead, the plugin READMEs and their `references/` folders are your guide.

## What this repo is

Eight independent plugins for Claude Code and Codex, plus the working method they come from. [WORKFLOW.md](WORKFLOW.md) describes the method. [README.md](README.md) lists the plugins and how to install them. Each plugin's own README says what it needs.

`lib-cli/` is shared code the plugins' CLIs copy in, not something to install.

## How to answer your user

1. **Read [WORKFLOW.md](WORKFLOW.md) first**, then the plugin list in [README.md](README.md). Open a plugin's README only when it looks relevant.
2. **Look at your user's setup before recommending anything.** Which harness they use, whether their work lives in git, whether they use T3 Code, how they pick work back up after a break, what they repeat by hand, and what they send to other people.
3. **Answer in three parts:**
   - **Habits to adopt now, with no install.** Match WORKFLOW.md's "take away" lines to problems your user actually has. Say which problem each one fixes.
   - **Plugins worth installing**, at most three to start, each with its exact install commands and requirements from its README.
   - **What to skip, and why.** For example, postman only helps someone who sends email in batches from Gmail, and gtg's refresh and migrate need T3 Code.
4. **Install nothing without your user's go-ahead.** When they agree, the commands are in [README.md](README.md#install). A copied skill folder never updates, so say so if you offer that route.

## Facts to get right

- Every plugin installs in both Claude Code and Codex, from the same source. A few hooks run in Claude Code only, and each README says which.
- Requirements differ per plugin. gtg, logical-projects and logical-learning need only Node 18 or later and git. runbooks and jevtools need Node 20 or later and an OpenRouter key. postman needs Python 3.9 or later and a Gmail app password. due-diligence needs nothing extra. logical-research needs nothing extra except for YouTube and podcast sources, which need Python 3 with `yt-dlp`.
- `gtg refresh` and `gtg migrate` need [T3 Code](https://t3.codes), and a migrate also needs the target machine's T3 set up as gtg's README describes. Everything else in gtg works anywhere.
- Customisation goes in a dot-folder in the user's repo (`.gtg/`, `.runbooks/`, `.dd/`, `.lr/`, `.learn/`), or for postman `~/.postman` in their home folder, never inside the plugin. Updates never touch it.
- The CLIs do the bookkeeping without a model. Don't describe them as costing tokens.
