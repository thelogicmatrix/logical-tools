# Extending gtg

Your tier is a `.gtg/` folder in the storage root (the current git repo, or `$GTG_HUB`). The CLI only reads it, so a plugin update never touches it.

Contents: Tiers · Commands · Extensions and mods · Hooks · Resolution and stability · The store · Report JSON.

## Tiers

| Tier | Lives in | Active |
|---|---|---|
| **Core** | the plugin's `gtg.mjs` and `SKILL.md` | always |
| **Bundled** | the plugin's `extensions/` | on by default (`gtg learn`, `gtg stats`, `gtg report`) |
| **Yours** | `<storage-root>/.gtg/` | when you add a file |

## Commands

Any subcommand the CLI does not recognise resolves to `<storage-root>/.gtg/commands/<name>.mjs`. The name must match `[A-Za-z0-9_-]+`, so it cannot traverse paths. The file is dynamically imported and its default export is called as `fn(ctx)`:

```js
// .gtg/commands/hello.mjs
export default async ({ root, args, ownEntries, readStore, writeStore, commit }) => {
  const { active, shelved } = ownEntries();                 // this command's own entries
  const session = readStore('docs/handoffs/_session.json'); // parsed JSON or null
  console.log(`hello from ${root}, ${active.length} active, args: ${args.join(' ')}`);
};
```

`ctx` = `{ root, args, readStore(path), writeStore(path, data), commit(paths, message), countHandoffFiles(slug), ownEntries(), ownParent, sessionId }`.

- `commit(paths, message)` returns `false` when git failed. The files are still written, the paths are named on stderr and the exit code is 1.

- `ownEntries()` returns `{ active, shelved }`, this command's own entries, read from `docs/handoffs/active/` and `docs/handoffs/backlog/` and filtered to the `parent` namespace it owns. It goes through the same reader the CLI uses. It reads both shelves every time, because explicit shelving can move entries to the backlog and an active-only read would report a live package as missing. A command that owns no namespace gets two empty arrays.
- `ownParent` is that namespace (`null` for a command that owns none), so an extension that writes an entry uses the same value its reader filters on.
- `sessionId` is the calling session's id, from `GTG_SESSION_ID`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID` or `CLAUDE_CODE_SESSION_ID`, or `undefined`.
- `countHandoffFiles(slug)` counts matching legacy dated documents plus the canonical `docs/handoffs/current/<slug>.md` if present. It is a file-count fallback for entries without a stored `sessions` count, and it does not count every revision of a persistent file. For current entries, prefer their stored checkpoint count.

**Do not read the records through `readStore`.** It is a whole-file JSON reader, and the records live one per file (see The store). `readStore('docs/handoffs/_active.json')` returns `null` because that packed file is deleted. `?.handoffs ?? []` then turns `null` into an empty list, so a command reading it reports every live entry as missing with no error anywhere. `ownEntries()` reads the real store. `readStore` is for genuine single-object files like `_session.json`.

**Handing control back to the skill.** A command whose output's first line starts with `GTG-DIRECTIVE:` is not relayed to the user. The skill follows the instruction on that line instead. For example, `console.log('GTG-DIRECTIVE: run gtg.mjs resume my-project and follow SKILL.md\'s Resume Procedure.')` makes `gtg <yourverb> <arg>` resolve an argument to a slug and then run the real Resume Procedure, hooks included, instead of reimplementing it. The bundled `gtg learn <topic>` uses it: it resolves its argument and then hands off to the Resume Procedure.

A command that throws is reported as `gtg: extension '<name>' failed: <message>` and exits 1.

## Extensions and mods

An **extension** owns entries in the handoff store and renders its own separated list. Its entries are excluded from the bare `gtg list` and `gtg backlog`, and from their counts, so the same work is not listed twice. `learn` is the bundled extension, owning the `learning` parent namespace. A **mod** owns no entries and only adds a view, so it sees the whole store. `stats` and `report` are mods, and their counts stay whole-store totals.

Adding another extension is one line in the `EXTENSIONS` map in `lib/view.mjs`, and that is the whole of it. An extension is a registered `parent` namespace and nothing more. **It must not add a field to the entry.** Membership is read off the existing `parent` field because `gtg handoff` rebuilds each entry as a fresh literal and drops fields it does not know. A marker field of your own would survive exactly until the next checkpoint and then go missing with no error.

**Decluttering is not lookup.** Only the bare listing hides extension entries. `gtg list <name-or-slug>` searches every entry and will surface a learning sprint. A queried extension entry is labelled with its slug instead of a row number, because row numbers index the bare listing and that is the order `gtg back <n>` resolves against. Use the slug, which every verb accepts.

A targeted query also reaches a shelved extension entry, printed on its own `shelved:` line rather than as a numbered row, whether or not the same query also matched active work. A learning sprint may be shelved between study sessions, and without this the exit procedure's slug-reuse probe would miss it. A shelved normal project stays invisible to a query, deliberately.

## Hooks

Two script hooks, one per direction:

```
.gtg/after-handoff.mjs    # default export fn(ctx), runs after `gtg handoff` has committed
.gtg/after-resume.mjs     # default export fn(ctx), runs after `gtg resume` has printed and retained
```

The handoff hook's `ctx` is `{ root, entry, file, body, worktree, checkpoint, readStore, writeStore, commit }`: the entry just written, the handoff's path and body, and the same store helpers commands get. `checkpoint` is true for an in-progress `--checkpoint` update, so a hook can skip departure ceremony. It does not run for `gtg backlog` parking. This is where a derived session log entry or a portfolio-row update belongs: zero model tokens, and it cannot be skipped in a hurry.

The resume hook's `ctx` is `{ root, entry, file, body, kept, resumed, readStore, writeStore, commit }`. `kept` is true for every resume, because resume always retains the entry. `resumed` is true for a normal pickup and false for an explicit `--keep`, which remains a compatibility flag meaning "read, not picked up".

On the forge store, `file` is `null` in both hooks. A throwing hook is reported on stderr and sets the exit code. The handoff itself is already committed and stays so.

Before a hook runs, the CLI has already appended what the machine knows to the handoff body: a `## Task list` read from the harness's task store (Claude Code: `<config dir>/tasks/<session id>/`), and, for a project in its own worktree, `## Commits this session` and `## Files touched` from its git log since the session started. A body that already carries a section of the same name keeps its own.

`gtg refresh` and `gtg migrate <device>` write a handoff and then open a T3 Code thread that resumes it. They read two more files:

```
.gtg/t3-servers.json      # { "<device>": { "home": "<workspace root>" } }, migrate's targets
.gtg/t3-launch.mjs        # default export fn(ctx), opens the thread
```

The launcher's `ctx` is `{ root, target, slug, name, verb, done }`. `verb` is `refresh` or `migrate <device>`, and `done` is `REFRESHED` or `MIGRATED`. It opens a T3 thread on `target` whose first message is `gtg <slug>` and returns one line starting with `done`, which the CLI prints in place of `RESUME:`. Anything else it returns is a failure. A throw is a failure too, and its message reaches the user next to the saved handoff, so put advice in it, such as what to do when the device is offline. Other keys in a device's `t3-servers.json` entry are yours for the launcher to read.

Without a launcher, the CLI prints a `GTG-LAUNCH:` line naming T3's own MCP calls instead, `mcp__t3-code__t3_thread_launch` for a refresh and the target's `mcp__t3-<device>__` tools for a migrate, and the agent makes them. Only a session inside T3 has those tools, so with no launcher both verbs refuse, before writing anything, unless the session looks like T3: `T3CODE_CLI_PATH` (set by T3's desktop app) or `T3_ACP_MCP_NODE`. A headless `t3 serve` sets neither, so set `GTG_T3=1` there.

There are no markdown hooks. `.gtg/skill/on-exit.md` and `on-resume.md` were removed because checking for one cost a tool turn every time, and anything they did is either mechanical (belongs in the script) or already in the handoff body.

## Resolution and stability

Built-in commands always win. Otherwise your `.gtg/commands/<name>.mjs` overrides a bundled one of the same name, so you can replace `stats`.

Your `.gtg/` lives in your own repo or hub, never inside the plugin, and the CLI only reads it. The extension surface (`ctx`, the `.gtg/` layout, hook load points, resolution order) only grows within a major version. A breaking change is a major version bump.

## The store

**One file per entry.** `docs/handoffs/active/<slug>.json` and `docs/handoffs/backlog/<slug>.json` each hold a single entry object, serialised `JSON.stringify(entry, null, 2) + '\n'` with no wrapper key. The current handoff is `docs/handoffs/current/<slug>.md`, updated in place, with each checkpoint in its git history. Older dated handoff documents in `docs/handoffs/` are kept under their original names. Progress records are `docs/handoffs/progress/<slug>.json` ([progress.md](progress.md)).

A packed array made every write rewrite the whole file, so two machines editing unrelated projects still collided on the same bytes, and a JSON array conflict has no semantic merge. One file per entry makes unrelated edits disjoint, and a same-project fork conflicts on one small file, which is correct.

Each directory also holds a `.gitkeep`. Git cannot track an empty directory, and an emptied collection (the last active entry completed, or everything parked) has to survive as an empty collection. Without the keeper the directory is absent on the other machine's checkout, which reads as a store that was never created.

`docs/handoffs/_active.json` (`{"handoffs":[...]}`) and `_backlog.json` (key `backlog`) were the packed files this replaced. Both are deleted as of 3.3.0, along with the self-migration and the fallback that read them. A directory is now the whole store, and an absent directory is a fresh hub. Rolling back to a pre-3.1.0 plugin means restoring a packed file from git history (`git show <pre-shard-commit>:docs/handoffs/_active.json`) and installing that plugin. The snapshot is the state at the shard, so records written after it stay in the directory's own history. To migrate a still-packed tree, install 3.1.0 to 3.2.0 once and let it shard, then upgrade.

The `-text` lines in `.gitattributes` (see the README) are correctness, not tidiness. A write is skipped when the file's bytes already equal the record's serialisation. Under a `text=auto` rule every record reads as changed after a fresh clone on Windows, and every command rewrites the whole store, losing the per-record isolation the sharding exists to deliver.

### Entry fields

| Field | Set by | Meaning |
|---|---|---|
| `project` | `--project` | display name |
| `slug` | `--slug` | stable id, also the handoff filename |
| `sessions` | auto | stored checkpoint count. Legacy entries initialise from dated handoff files |
| `created` | auto | first handoff's date, carried forward across parks and reactivations |
| `worktree` | `--worktree` | where the work lives. The literal `repo root` if in the storage repo |
| `branch` | `--branch`, else detected in the worktree | the project's branch, not the hub's |
| `parent` | `--parent`, else inferred from `docs/projects/INDEX.md` | family slug. Absent means standalone |
| `aka` | `rename --name` | former display names, which `gtg log` also searches |
| `duration_min` | auto | session length from `_session.json`. Absent when unknown or stale, and never set by a `--checkpoint`, so the same elapsed time is not counted twice |
| `harness` | `--harness`, else detected from the environment | who wrote the last handoff (`claude`, `codex`, ...), shown on the `list` row |
| `eta` | `--eta` | rough time remaining on the next action |
| `next` | `--next`, else the body's `## Next Action` | the one concrete next action, cut to 150 characters |
| `file` | auto | path to the handoff document. Absent on the forge store |
| `updated` | auto | last checkpoint timestamp. Never triggers automatic shelving |
| `reviewed` | `gtg keep` | when a `REVIEW:` question was answered "still live". Kept apart from `updated` so "Nd ago" stays honest |
| `resumedAt` | `gtg resume` | when a session last picked the entry up, written at most once a day. The review counts it as touched, `list`'s "Nd ago" does not |
| `nudged` | the `REVIEW:` line | when the review last asked about the entry. No session asks about it again for 30 days |
| `wake` | `gtg back --wake`, `gtg keep --wake` | backlog only: the date the entry comes back up for review |

A `phase` key on entries written before 1.3.0 is ignored on read and never rewritten. `sessions` and `created` backfill from the handoff files already on disk, so no migration is needed.

## Report JSON

`gtg report` writes `docs/handoffs/_report.json` (override with `--json <path>`). It is a regenerable derivative, not tracked state, so gitignore it. Every figure is computed by `extensions/lib/history.mjs` from the git log and the handoff files. Nothing is inferred by a model. Top-level keys:

| Key | What |
|---|---|
| `historyAvailable` | false when not in a git repo, so sections degrade rather than lie |
| `counts` | active and backlog |
| `habit` | activity grid, current and longest streak, weekday and hour distribution |
| `throughput` | shipped (total, 7d, 30d), parked, resumed, ship rate, days-to-ship |
| `effort` | from committed `duration_min`: `total` minutes, `bySlug`, `hoursBySlug`, `hoursByWeek`, `avgSessionMin`, `longestSessionMin`, `sessionsTimed`. Counts handoff commits only, because a reactivation or undo re-adds an entry unchanged and must not re-bill the session. Accrues over time, empty at first |
| `families` | per-parent rollup: sub-projects, shipped, active, sessions, `totalHours`, first and latest activity |
| `perProject` | one row per project: born, last seen, sessions, minutes, worktree, days alive, days-to-ship, status |
| `health` | resurrection and abandonment rate, WIP over time, aging |
| `fun` | best week, longest-lived shipped project, most-resumed, velocity label |

`gtg stats` prints a few of these as terminal lines. Both are read-only and never touch the store. Both are mods, so `counts.active` covers every entry including the extension namespaces, and can read higher than the number of rows `gtg list` shows. Hour-of-day history comes from dated legacy documents, so its coverage is limited: revisions of a persistent handoff file do not supply that series.
