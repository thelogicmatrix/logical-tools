#!/usr/bin/env node
// gtg - zero-model bookkeeping CLI for the gtg pause/resume skill.
// Storage root: GTG_HUB env var if set, else the current git repo's root.
// Unknown subcommands dispatch to <root>/.gtg/commands/<name>.mjs (see README).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readCollection, writeCollection } from './lib/store.mjs';
import { runGit, firstMeaningfulLine } from './lib/git.mjs';
import { gitTop, configuredRoot } from './lib/root.mjs';
import { isMain } from './lib/exit.mjs';
import { forgeConfig, openForge } from './lib/forge.mjs';
import { readProgress, renderProgress, renderProgressTaskList } from './lib/progress.mjs';
import { EXTENSIONS, REVIEW_ACTIVE_DAYS, REVIEW_BACKLOG_DAYS, REVIEW_CMDS, ago, c, displayOrder, dueLabel, localOffsetSuffix, nowIso,
  parseFlags, renderList as renderListFor, repeatWait, takeReview as takeReviewFor, resolveEntry, sortByProject, userVisible } from './lib/view.mjs';
import { resumeConsume as resumeFor, thisDevice } from './lib/resume.mjs';
import { addUpNext, upNextItems, setUpNext, setSection } from './lib/upnext.mjs';
import { NEEDS_T3, canOpenThread, loadServers, openThread } from './lib/move.mjs';

// --- storage root -----------------------------------------------------------
// The repo the caller stands in, or null outside one. Looked up once: startup needs it for ROOT
// when GTG_HUB is unset, and handoff's inferWorktree needs it again. 2 s, so a hung git cannot
// hang every command.
let cwdTop;
function callerRepo() {
  if (cwdTop === undefined) cwdTop = gitTop();
  return cwdTop;
}
function resolveRoot() {
  if (process.env.GTG_HUB) return process.env.GTG_HUB;
  const top = callerRepo();
  if (top) return top;
  console.error('gtg: not inside a git repository and GTG_HUB is not set');
  process.exit(2);
}
// Set by main(), so importing this file resolves nothing and spawns nothing.
let ROOT = '';
const DIR_ACTIVE = 'docs/handoffs/active';
const DIR_BACKLOG = 'docs/handoffs/backlog';
// `which` -> the directory that holds its records. One file per record, and the directory is the
// whole store: the packed files these replaced are deleted as of 3.3.0, and nothing reads them.
const COLLECTIONS = { active: DIR_ACTIVE, backlog: DIR_BACKLOG };
// The packed stores, DELETED in 3.3.0 and named here for git HISTORY only. They are not read
// from disk anywhere - readCollection lost its fallback with them - but `log` and `undo` read
// history, and history spans the migration. Dropping these two paths would make every pre-shard
// commit invisible to `gtg log` and would leave `gtg undo` on a pre-shard commit unable to see
// its own change (the whole store moved out from under the pathspec it anchors on). A pathspec
// naming a path that no longer exists in the worktree is legal and matches its old commits.
const PACKED_ACTIVE = 'docs/handoffs/_active.json';
const PACKED_BACKLOG = 'docs/handoffs/_backlog.json';
const STORE_PATHSPEC = [PACKED_ACTIVE, PACKED_BACKLOG, DIR_ACTIVE, DIR_BACKLOG];
const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// Directory of this CLI file - bundled extensions ship alongside it under extensions/.
const CLI_DIR = dirname(fileURLToPath(import.meta.url));

// Who is mutating the store. Every gtg commit carries this as a trailer so `undo`
// can tell its own change from a concurrent session's - two sessions sharing one
// checkout is the normal setup, and undo used to revert whichever session
// committed last (2026-07-14: one session's undo silently reverted another's
// park). Must be stable ACROSS processes, since the mutation and the later undo
// are separate invocations, which is exactly what a harness session id gives us.
// GTG_SESSION_ID is the portable override for other harnesses and for tests.
const SESSION_ID = process.env.GTG_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '';
// Progress also records Codex's native task/session identity. Keep this separate from undo's
// established identity contract: progress attribution is history, not process ownership.
const PROGRESS_SESSION_ID = process.env.GTG_SESSION_ID
  || process.env.CODEX_THREAD_ID
  || process.env.CODEX_SESSION_ID
  || process.env.CLAUDE_CODE_SESSION_ID
  || '';
const SESSION_TRAILER = 'gtg-session';
// Which harness is writing. Two agents share one store now (Claude Code and Codex, 2026-08-26),
// and a resume from the other side wants to know whose task-list conventions the handoff
// carries. Detected from the env the harness exports to its tools: Claude Code sets CLAUDECODE
// and a session id; Codex exports CODEX_* (CODEX_HOME, CODEX_MANAGED_BY_*, sandbox flags).
// --harness on the handoff overrides, undefined when nothing identifies the caller.
function detectHarness() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID) return 'claude';
  if (Object.keys(process.env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  return undefined;
}

// --- helpers (readStore/writeStore/commit are also the extension ctx) --------
// readStore is a WHOLE-FILE JSON reader and stays one: it is published on the extension ctx,
// and a caller indexes the wrapper key itself (`readStore('...')?.handoffs ?? []`), so handing
// it a bare array would yield [] with no error at all. Nothing inside gtg reads the record
// stores through it any more - that is `entries(which)` below - and since Task 4 no BUNDLED
// extension does either: extensions/lib/history.mjs used to, and buildReport now calls
// readCollection instead, because a whole-file reader cannot see a directory of records.
// The remaining internal callers read _session.json, which is a genuine single-object file.
//
// So the shape contract is real but has no bundled caller left to enforce it. A third-party
// extension in .gtg/commands/ is now the caller that depends on it, and test/gtg-part6.test.mjs
// case 72 is what holds it - keep that case if you touch this function.
function readStore(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function writeStore(rel, data) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}
// firstMeaningfulLine lives in lib/git.mjs beside runGit, one copy shared with projects and learn.
function commit(paths, message) {
  // An EMPTY path list degrades to exactly the pathspec-less commit the block below exists
  // to prevent: `git commit -- ` with nothing after the `--` takes the whole shared index.
  // Callers now build their paths from what the store actually touched, so "touched nothing"
  // is reachable, and it is never a reason to commit everything.
  if (!paths.length) return;
  const opts = { cwd: ROOT };
  try {
    // runGit waits out another session's index.lock and times out a hung git.
    runGit(['add', '--', ...paths], opts);
    // Name the paths on the COMMIT too, not just the add. A pathspec-less `git commit`
    // takes the WHOLE index, so anything a concurrent session staged between our add and
    // our commit rides along in ours - on 2026-07-27 a `gtg resume` swallowed an unrelated
    // spec file that another session had just staged. `--` keeps a path that starts with
    // a dash from being read as a flag.
    // The trailer goes in a second -m so it lands in the BODY, leaving the subject
    // (which history.mjs classifies on) byte-identical to what it always was.
    const msg = SESSION_ID ? ['-m', message, '-m', `${SESSION_TRAILER}: ${SESSION_ID}`] : ['-m', message];
    runGit(['commit', '-q', ...msg, '--', ...paths], opts);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    if (/nothing to commit|no changes added/i.test(out)) return; // identical content - files already on disk
    // `git add` is not atomic and may have staged some or all of the paths before the failure.
    // Unstage them, as learn does, so nothing is left ownerless in the shared index.
    try { runGit(['reset', '-q', '--', ...paths], opts); } catch { /* nothing staged */ }
    // Don't let a real git failure masquerade as success: the files are written, but say so.
    console.error(`gtg: git commit failed, changes are on disk but uncommitted - ${firstMeaningfulLine(e)}`);
    // NAME THE PATHS, because nothing else ever will. The records sit uncommitted on disk,
    // and writeCollection skips byte-identical files, so a later gtg run recomputes the same
    // records, reports NO changed paths for them, and never names them again. The packed store
    // was immune to this by accident: its pathspec was two fixed filenames, so the next commit
    // re-added whatever was pending.
    //
    // Recovery is deliberately MANUAL - the user runs `git commit -- <the paths below>`. The
    // automatic fix would be to widen the pathspec to the whole keep-set, and that is exactly
    // what must not happen here: on one shared tree and index there is no way to tell our own
    // stranded record from another session's in-flight one, so committing the keep-set would
    // sweep their work into our commit. That is the 2026-07-27 incident with extra steps.
    // Labelled "uncommitted", not "staged": a stale index.lock (the 2026-08-11 cause) fails
    // the `git add` too, so on that path nothing is staged at all - verified, the tree shows
    // an unstaged ` D` and an untracked `??`. `git commit -- <paths>` recovers either way,
    // which is what the line is for, so the label states the thing that is always true.
    console.error(`  uncommitted: ${paths.join(' ')}`);
    // ...and say so in the EXIT CODE, not only on stderr. A batch caller reads $?, not our
    // warnings: on 2026-08-11 a 39-call backfill hit a stale index.lock and every call after
    // it warned, exited 0 and kept going, ending with 14 uncommitted rows and files left
    // staged and ownerless in the shared checkout. exitCode rather than a throw because the
    // store write already landed - this reports a partial success, it does not roll back.
    process.exitCode = 1;
    return false; // so a caller can say which write landed, see extensions/commands/progress.mjs
  }
}
// `which` is 'active' | 'backlog'. Order is NOT stored: sortByProject/displayOrder recompute
// it at render, so a directory read (alphabetical by slug) renders identically to the packed
// array it replaces.
//
// With <root>/.gtg/forge.json the records live on a forge instead (lib/forge.mjs). FORGE holds them
// in memory for this one process, and the dispatcher flushes the difference when the command ends.
let FORGE = null;
function entries(which) {
  if (FORGE) return FORGE.entries(which);
  return readCollection(ROOT, COLLECTIONS[which], { name: 'gtg' });
}
// Returns the repo-relative paths touched, INCLUDING deletions, because commit() must name
// every path on both `git add` and `git commit` or a removal is left for another session to
// pick up as its own.
function saveEntries(which, items) {
  if (FORGE) return FORGE.save(which, items);
  const { written, deleted } = writeCollection(ROOT, COLLECTIONS[which], items, { name: 'gtg' });
  return [...written, ...deleted];
}

// NO import-time migration since 3.3.0. It read the packed stores and sharded them, and both
// packed files are deleted, so there is nothing to migrate from: a tree with no record
// directory is a fresh hub, and the first write creates it. What went with the migration:
//   - the `RESUME_PATH && MIGRATION_PENDING` sync that had to run BEFORE the shard commit, or
//     the two machines each committed their own shard over the same records and every later
//     cross-machine handoff needed a human to resolve the fork. The sync that matters is still
//     there, in resumeConsume, ahead of every read - see syncHub() and gtg-part6.test.mjs case 73.
//   - the per-collection catch that kept a corrupt packed file from taking gtg down entirely.
//     readCollection now throws per RECORD instead, which is the same protection one level
//     down: one unparseable record names itself rather than emptying a list.
// A pre-shard tree needs the pre-shard plugin. docs/runbooks/git-parity.md has the rollback.
// Legacy handoff docs are named YYYY-MM-DD-HHMM-<slug>.md. New work uses one
// docs/handoffs/current/<slug>.md file whose git history carries each checkpoint.
// File counts remain only a migration fallback for records that predate the
// stored `sessions` counter; they are not a count of current-file revisions.
function legacyHandoffFilesFor(slug) {
  const dir = join(ROOT, 'docs/handoffs');
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-\\d{4}-${slug}\\.md$`);
  try { return readdirSync(dir).filter((f) => re.test(f)).sort(); } catch { return []; }
}
function canonicalHandoffPath(slug) { return `docs/handoffs/current/${slug}.md`; }
function countHandoffFiles(slug) {
  return legacyHandoffFilesFor(slug).length + (existsSync(join(ROOT, canonicalHandoffPath(slug))) ? 1 : 0);
}
// Reuse only paths generated by a GTG handoff writer and still present on disk.
// The filename slug may differ after `rename`; retaining that safe path preserves
// the line's history. Anything outside these two shapes falls back to the current path.
function reusableHandoffPath(rel) {
  if (typeof rel !== 'string') return null;
  const safe = isHandoffDocPath(rel);
  return safe && existsSync(join(ROOT, rel)) ? rel : null;
}
function isHandoffDocPath(rel) {
  return typeof rel === 'string'
    && /^docs\/handoffs\/(?:\d{4}-\d{2}-\d{2}-\d{4}-[A-Za-z0-9][A-Za-z0-9_-]*|current\/[A-Za-z0-9][A-Za-z0-9_-]*)\.md$/.test(rel);
}
function sameHandoffPath(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase();
}
function progressSlugOnDisk(slug) {
  const dir = join(ROOT, 'docs/handoffs/progress');
  if (!existsSync(dir)) return null;
  const wanted = `${slug}.json`.toLowerCase();
  const file = readdirSync(dir).find((name) => name.toLowerCase() === wanted);
  return file ? file.slice(0, -'.json'.length) : null;
}
// Earliest handoff filename's date, as a midnight ISO stamp. Null if none exist.
function firstHandoffDate(slug) {
  const f = legacyHandoffFilesFor(slug)[0];
  if (!f) return null;
  const datePart = f.slice(0, 10);
  const [y, m, day] = datePart.split('-').map(Number);
  return `${datePart}T00:00:00${localOffsetSuffix(new Date(y, m - 1, day))}`;
}

// Family grouping. The parent already exists as a docs/projects/ page - the
// logical-projects skill owns that hierarchy, gtg only points at it.
// Resolution order: the flag the skill passes from session context, then a
// slug-prefix match against INDEX.md page slugs. Never asks; an unresolved
// parent just lists the project as standalone.
function inferParent(slug, explicit) {
  if (explicit) return explicit;
  const idx = join(configuredRoot('PROJECTS_ROOT') || ROOT, 'docs/projects/INDEX.md');
  if (!existsSync(idx)) return undefined;
  let text;
  try { text = readFileSync(idx, 'utf8'); } catch { return undefined; }
  const pages = new Set();
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+)\.md\)/g)) pages.add(m[1]);
  // ponytail: longest match wins so 'widget-stats' picks 'widget' over any
  // shorter page slug that also prefixes it.
  let best;
  for (const page of pages) {
    if (slug !== page && !slug.startsWith(page + '-')) continue;
    if (!best || page.length > best.length) best = page;
  }
  return best;
}

// Session length. The SessionStart hook stamps docs/handoffs/_session.json as a
// per-cwd map { sessions: { <cwd>: ISO } }; git only knows when a handoff was
// WRITTEN, never how long the work took. Keying by cwd is what stops two
// concurrent worktree sessions from clobbering each other's clock through the
// one shared hub file - this handoff reads only ITS OWN session's start.
// A stale stamp (machine left on overnight) would report a 3-day session, so
// anything over 24h is discarded rather than believed.
// ponytail: a clear/compact mid-session restamps this cwd, so the duration is a
// lower bound (time since the last context reset), never an overcount. Fine.
function sessionDurationMin() {
  const s = readStore('docs/handoffs/_session.json');
  const started = Date.parse(s?.sessions?.[process.cwd()] ?? '');
  if (!Number.isFinite(started)) return undefined;
  const min = Math.round((Date.now() - started) / 60000);
  if (min < 0 || min > 24 * 60) return undefined;
  return min;
}

// ISO start of THIS session, from the same per-cwd stamp sessionDurationMin() reads.
function sessionStartIso() {
  const s = readStore('docs/handoffs/_session.json');
  const iso = s?.sessions?.[process.cwd()];
  return Number.isFinite(Date.parse(iso ?? '')) ? iso : undefined;
}
// Case-insensitive on Windows, where the hub env var and git's own path spelling differ. Real paths,
// because git reports a junctioned hub (a Windows profile reached through a junction) by its target. A path that is
// gone falls back to resolve().
function samePath(x, y) {
  const real = (s) => { try { return realpathSync.native(s); } catch { return resolve(s); } };
  const n = (s) => (process.platform === 'win32' ? real(s).toLowerCase() : real(s));
  return n(x) === n(y);
}
// The caller's checkout is the project's worktree only when the hub is a checkout's top, as home
// is. An agent hub (ATOM's /state/atom, or ~/.atom inside home) is not, and before 4.8.0 any repo
// a command ran in counted as its worktree, so the handoff carried that repo's commits and files
// (an ATOM probe on 2026-10-12 got 40 lines of home's history).
function inferWorktree() {
  const hubTop = gitTop(ROOT);
  if (!hubTop || !samePath(hubTop, ROOT)) return 'repo root';
  const top = callerRepo();
  return top && !samePath(top, ROOT) ? top : 'repo root';
}
// Body of one `## <heading>` section, '' when absent.
//
// `$(?![\s\S])`, not a bare `$`. The `m` flag is needed for the `^## ` anchor - a heading is
// almost never at offset 0 - but under `m` a bare `$` also matches at EVERY line end, and the
// capture is lazy: with `## Next Action\n\nDo the thing` the group tries empty first, the
// position right after the heading's newline is a line end, `$` matches there, and the section
// reads as ''. A well-formed handoff was then refused for "missing --next", `Task list` read as
// absent and got appended twice, and the home after-handoff hook wrote an empty session entry.
// The negative lookahead makes `$` mean end of STRING while `^` keeps its per-line meaning.
function sectionOf(body, heading) {
  const m = body.match(new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : '';
}
// The harness's task list, read from disk so the skill neither loads a task tool nor types
// the list into the body. Claude Code keeps <config dir>/tasks/<session id>/<n>.json; other
// harnesses get [] and the section is simply absent.
function readHarnessTasks() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  const cfg = process.env.CLAUDE_CONFIG_DIR || join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
  if (!sid || !cfg) return [];
  const dir = join(cfg, 'tasks', sid);
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const f of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (t?.subject) rows.push({ id: Number(t.id ?? f), line: `- [${t.status || 'pending'}] ${t.subject}` });
    } catch { /* a half-written task file is not a reason to fail the handoff */ }
  }
  return rows.sort((x, y) => x.id - y.id).map((r) => r.line);
}
// Commits and files in a worktree since an ISO time. Empty on any git failure.
function gitSince(dir, sinceIso) {
  const opt = { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 };
  try {
    const commits = execFileSync('git', ['log', `--since=${sinceIso}`, '--format=%h %s'], opt)
      .toString().trim().split('\n').filter(Boolean);
    const files = [...new Set(execFileSync('git', ['log', `--since=${sinceIso}`, '--name-only', '--format='], opt)
      .toString().split('\n').map((s) => s.trim()).filter(Boolean))].sort();
    return { commits, files };
  } catch { return { commits: [], files: [] }; }
}

// --- handoff / backlog park ---------------------------------------------------
async function writeHandoff(argv, { which, verb, quiet = false }) {
  const a = parseFlags(argv, { boolean: ['exact', 'create-only'] });
  const body = readFileSync(0, 'utf8').trim(); // stdin
  // --next used to be typed twice, once as a flag and once as the body's Next Action section.
  // The section is the truth; the flag is now an override for a body without one (2.0.0).
  if (typeof a.next !== 'string') a.next = sectionOf(body, 'Next Action').split('\n').find((l) => l.trim()) || undefined;
  const missing = ['project', 'slug', 'next'].filter((k) => !a[k]);
  if (missing.length) { console.error(`gtg ${verb}: missing --${missing.join(', --')}${missing.includes('next') ? ' (or a ## Next Action section in the body)' : ''}`); process.exit(2); }
  // slug becomes a filename and a git-add arg - constrain it so it can't traverse paths or inject
  // shell. At least as strict as lib/store.mjs's own SLUG_OK, which requires an alphanumeric FIRST
  // character: a leading '-' reads as a flag to git and to argv parsing. Refused here rather than
  // inside the store because writeHandoff writes the .md to disk before it saves the entry, and
  // that no-orphan-file guarantee only holds while nothing after that write can still refuse -
  // `--slug _foo` used to pass here, land the markdown, and then throw inside writeCollection,
  // leaving an untracked .md, no entry, and a body that came from stdin and is therefore gone.
  if (!SLUG_OK.test(a.slug)) { console.error(`gtg ${verb}: --slug must start with a letter or digit and match [A-Za-z0-9_-]`); process.exit(2); }
  if (a.due !== undefined && !dueOk(a.due)) { console.error(`gtg ${verb}: --due takes YYYY-MM-DD or YYYY-MM-DDTHH:MM`); process.exit(2); }
  if (!body) { console.error(`gtg ${verb}: empty body on stdin`); process.exit(2); }
  // Slug reuse lives HERE, not in a `list <name>` probe the skill runs first (one tool turn per
  // departure, 2026-08-26). A fresh slug for a project that already has an entry mints a
  // duplicate beside it. An exact slug is taken as given; otherwise exactly one entry whose
  // project name contains --project (case-insensitive, the same predicate `list <filter>`
  // uses) lends its slug. Two or more matches: ambiguous, keep the given slug. --exact opts
  // out, for the `gtg [project]` override where the caller means the slug literally.
  const everything = [...entries('active'), ...entries('backlog')];
  const guarded = Object.hasOwn(a, 'expected-body-sha256');
  if (guarded) {
    // Compare the same snapshot list --json exposes. In particular, Forge's resume reader
    // trims whitespace; it cannot be used here. Do not reload/reset Forge's write baseline.
    a.exact = true;
    const matches = ['active', 'backlog'].flatMap((shelf) => entries(shelf)
      .filter((e) => e.slug === a.slug).map((e) => ({ e, shelf })));
    let error;
    if (FORGE?.stale) error = 'hub is unreachable; cached records cannot authorize a handoff';
    else if (matches.length !== 1) error = 'exact project is missing or ambiguous';
    else if (matches[0].shelf !== a['expected-shelf']) error = 'project changed shelf since the caller read';
    else {
      const rec = await withHandoff(matches[0].e, matches[0].shelf);
      if (typeof rec.handoff !== 'string'
        || createHash('sha256').update(rec.handoff, 'utf8').digest('hex') !== a['expected-body-sha256'].toLowerCase()) {
        error = 'handoff changed or is missing since the caller read';
      }
    }
    if (error) {
      console.error(`gtg handoff: guarded write refused - ${error}`);
      process.exitCode = 2;
      return { refused: true };
    }
  }
  // A queued idea authorizes creation, never replacing or re-shelving another project.
  // Refuse before progress/WIP/body writes; ordinary handoffs retain their reuse behavior.
  const createOnly = a['create-only'] === true;
  if (createOnly) {
    a.exact = true;
    if (everything.some((e) => e.slug.toLowerCase() === a.slug.toLowerCase())) {
      console.error(`gtg ${verb}: project slug already exists; this create-only idea was not written`);
      process.exitCode = 2;
      return { refused: true };
    }
  }
  if (!a.exact && !everything.some((e) => e.slug === a.slug)) {
    const name = String(a.project).toLowerCase();
    const near = everything.filter((e) => String(e.project).toLowerCase().includes(name));
    if (near.length === 1) {
      console.log(`slug: reusing ${near[0].slug} (matches "${near[0].project}")`);
      a.slug = near[0].slug;
    }
  }
  // Progress is durable state scoped by the same stable slug. Read it before any handoff or
  // --wip mutation so a corrupt matching record fails loudly without leaving half a handoff.
  const progress = readProgress(ROOT, a.slug, { optional: true });
  // ROOT is the storage hub, NOT the project. A project in its own worktree has
  // its own branch - detect there, or the hub's branch gets recorded for everyone.
  // Inferred from where the call is made when the flag is omitted: a session runs in its
  // worktree, so cwd's repo is the project unless that repo IS the hub, or the hub is not a
  // checkout's top (see inferWorktree).
  const worktree = a.worktree || inferWorktree();
  let branch = a.branch;
  if (!branch) {
    const gitDir = worktree === 'repo root' ? ROOT : worktree;
    try {
      branch = execFileSync('git', ['-C', gitDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    } catch { branch = '?'; }
  }
  const device = thisDevice();
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const prior = everything.find((e) => e.slug === a.slug);
  const relFile = reusableHandoffPath(prior?.file) || canonicalHandoffPath(a.slug);
  const pathOwner = everything.find((e) => e !== prior && sameHandoffPath(e.file, relFile));
  if (pathOwner) {
    console.error(`gtg ${verb}: handoff path '${relFile}' is already owned by '${pathOwner.slug}'`);
    process.exit(2);
  }
  const ownWorktree = worktree !== 'repo root' && !samePath(worktree, ROOT);
  // --wip: checkpoint the worktree's uncommitted work inside this same call, so the skill
  // spends no turn on status/add/commit. Worktree only: 'repo root' may be a checkout shared
  // with concurrent sessions, where a tree-wide add sweeps their work (see commit() above), so
  // there the caller names its own files. A clean tree is not an error. Runs BEFORE the
  // git-derived sections below so the checkpoint shows up in them.
  if (a.wip && ownWorktree && !a['dry-run']) {
    // runGit, so another session's index.lock is waited out and a hung git times out.
    const wt = { cwd: worktree };
    try {
      runGit(['add', '-A'], wt);
      runGit(['commit', '-q', '-m', `wip: gtg checkpoint - ${a.project}`], wt);
      console.log('wip: committed');
    } catch (e) {
      const out = `${e.stdout || ''}${e.stderr || ''}`;
      if (!/nothing to commit|no changes added/i.test(out)) {
        console.error(`gtg: wip commit failed - ${out.trim().split('\n')[0]}`);
        process.exitCode = 1;
      }
    }
  }
  // Sections the model used to type that the machine already knows (2.0.0): the harness's
  // task list from disk, and this session's commits and files from the worktree's git log.
  // Only for a worktree of its own: the hub may be a checkout shared by concurrent sessions,
  // where "commits since I started" would be everyone's. Each is added only when the body
  // has not already got a section of that name, so a caller can still write its own.
  const auto = [];
  if (!sectionOf(body, 'Task list')) {
    const progressTasks = progress ? renderProgressTaskList(progress) : '';
    const harnessTasks = progress ? [] : readHarnessTasks();
    if (progress) auto.push(`## Task list\n${progressTasks || '(no tasks)'}`);
    else if (harnessTasks.length) auto.push(`## Task list\n${harnessTasks.join('\n')}`);
  }
  if (progress && !sectionOf(body, 'Progress')) {
    auto.push(`## Progress (snapshot revision ${progress.revision}, updated ${progress.updatedAt})\n${renderProgress(progress)}`);
  }
  if (ownWorktree && verb === 'handoff') {
    const since = sessionStartIso() || prior?.updated || new Date(Date.now() - 12 * 3600e3).toISOString();
    const { commits, files } = gitSince(worktree, since);
    if (commits.length && !sectionOf(body, 'Commits this session')) auto.push(`## Commits this session\n${commits.map((l) => `- ${l}`).join('\n')}`);
    if (files.length && !sectionOf(body, 'Files touched')) auto.push(`## Files touched\n${files.map((f) => `- ${f}`).join('\n')}`);
  }
  const fullBody = [body, ...auto].join('\n\n');
  const doc = `# Handoff: ${a.project}
Date: ${stamp.slice(0, 10)} ${p(d.getHours())}:${p(d.getMinutes())}
Worktree: ${worktree}
Branch: ${branch}
Device: ${device}

${fullBody}

## Resume Prompt
Say: "gtg ${a.slug}"
`;
  // `sessions` now counts checkpoint events. New records begin at one; legacy
  // records without the field seed it from the handoff files still on disk.
  // Every real handoff call bumps the record, so even an identical body produces
  // a committed checkpoint event without inventing revisions from file counts.
  const priorSessions = Number.isInteger(prior?.sessions) && prior.sessions >= 0
    ? prior.sessions
    : countHandoffFiles(a.slug);
  const sessions = priorSessions + 1;
  const entry = {
    project: a.project, slug: a.slug, sessions,
    created: prior?.created || firstHandoffDate(a.slug) || nowIso(),
    worktree, branch, device,
    // --parent is stable family metadata only the calling skill can know
    // (inferParent's slug-prefix fallback can't deduce e.g.
    // sub-project -> atlas) - carry it forward when the flag is
    // omitted instead of silently dropping the project out of its family.
    parent: inferParent(a.slug, a.parent) ?? prior?.parent,
    // Former display names, set by `rename --name`. A checkpoint rebuilds the entry field by
    // field, so anything not carried here is dropped on the next one.
    aka: prior?.aka,
    // A checkpoint can happen several times in one native session. Recording
    // the cumulative clock on each would make history sum 10+20+30 minutes for
    // 30 minutes of work. Only the final/departure handoff records duration.
    duration_min: a.checkpoint ? undefined : sessionDurationMin(),
    harness: (typeof a.harness === 'string' ? a.harness : undefined) ?? detectHarness(),
    eta: a.eta || prior?.eta,
    // --due belongs to the Next Action: a checkpoint that keeps the same Next Action keeps it,
    // a new Next Action without --due drops it.
    due: a.due ?? (prior?.next === String(a.next).slice(0, 150) ? prior?.due : undefined),
    // On the forge store the body lives inside the record, so there is no path to record.
    next: String(a.next).slice(0, 150), file: FORGE ? undefined : relFile, updated: nowIso(),
  };
  if (a['dry-run']) {
    console.log(`--- DRY RUN: would write ${relFile} ---\n${doc}`);
    console.log(`--- ${COLLECTIONS[which]}/${a.slug}.json entry ---\n${JSON.stringify(entry, null, 2)}`);
    return;
  }
  if (FORGE) FORGE.queueHandoff(a.slug, doc, { createOnly,
    expectedBodySha256: a['expected-body-sha256']?.toLowerCase(), expectedShelf: a['expected-shelf'] });
  else {
    mkdirSync(dirname(join(ROOT, relFile)), { recursive: true });
    writeFileSync(join(ROOT, relFile), doc);
  }
  const items = entries(which).filter((e) => e.slug !== a.slug); // dedupe by slug
  items.push(entry);
  const paths = saveEntries(which, items);
  // The two stores PARTITION the work, in flight against shelved, which is what every other
  // mover already assumes: back and active MOVE an entry rather than
  // copy it. Deduping against only the store being written left the other copy sitting there,
  // and the two drive different renderers, so one project read as active or shelved depending
  // on which command you happened to run. `prior` above already spans both stores; the write
  // now does too, so writing a handoff for a shelved slug unparks it instead of forking it.
  const other = which === 'active' ? 'backlog' : 'active';
  const others = entries(other);
  const kept = others.filter((e) => e.slug !== a.slug);
  const unparked = kept.length !== others.length;
  if (unparked) paths.push(...saveEntries(other, kept));
  // 'backlog' here means "park a NEW idea" (writeHandoff's other caller) - distinct
  // from `back` (below), which SHELVES an already-active entry and keeps its own
  // 'gtg backlog: park <project>' subject unchanged; historical commits use that
  // one and must stay parsable.
  const subject = verb === 'backlog'
    ? `gtg backlog: new ${a.project} - session ${sessions}`
    : `${verb}: ${a.project} - session ${sessions}`;
  // relFile plus every record file the two saves touched, deletions included - the unpark
  // above REMOVES the slug's file from the other store, and an unnamed deletion stays in the
  // working tree for whichever session commits next.
  if (FORGE) {
    // Flushed here rather than at dispatch end, so the hook below runs on a handoff that has landed.
    // The body came from stdin, so a failed write must not lose it: it goes to the file it would
    // have had on the file store, uncommitted, and the command fails.
    try {
      console.log((await FORGE.flush(verb))[0] ?? '(forge: record unchanged)');
    } catch (e) {
      // A refused queued create leaves its idea in Logic. Do not save a replacement body
      // under an existing project's slug as the ordinary handoff recovery path would.
      if (createOnly) {
        console.error(`gtg ${verb}: create-only write failed - ${firstMeaningfulLine(e)}`);
        process.exitCode = 1;
        return { forgeFlushFailed: true };
      }
      mkdirSync(dirname(join(ROOT, relFile)), { recursive: true });
      writeFileSync(join(ROOT, relFile), doc);
      console.error(`gtg ${verb}: forge write failed - ${firstMeaningfulLine(e)}`);
      console.error(`  the handoff body is saved, uncommitted, at ${relFile}`);
      // exitCode, not process.exit: on Windows (Node 24) exiting right after a fetch POST trips a
      // libuv assertion and the process dies with 0xC0000409 instead of the code asked for.
      process.exitCode = 1;
      return { forgeFlushFailed: true };
    }
  } else {
    commit([relFile, ...paths], subject);
    console.log(relFile);
  }
  // After-handoff hook: <root>/.gtg/after-handoff.mjs, default export fn(ctx), runs once the
  // handoff is committed. This is where the ceremony that used to be prose steps for the model
  // to perform (a docs/sessions entry, a portfolio-row flip) goes, so it costs no model tokens
  // and cannot be skipped in a hurry. ctx is additive-only, like the command ctx. A failing
  // hook is reported and sets the exit code; it never rolls the handoff back.
  const hook = join(ROOT, '.gtg', 'after-handoff.mjs');
  if (verb === 'handoff' && existsSync(hook)) {
    try {
      const mod = await import(pathToFileURL(hook).href);
      if (typeof mod.default !== 'function') throw new Error('no default export function');
      // --checkpoint keeps the handoff write identical while allowing the home
      // hook to skip departure-only ceremony for an in-session milestone update.
      await mod.default({ root: ROOT, entry, file: FORGE ? null : relFile, body: fullBody, worktree, checkpoint: !!a.checkpoint, readStore, writeStore, commit });
    } catch (e) {
      console.error(`gtg: after-handoff hook failed - ${firstMeaningfulLine(e)}`);
      process.exitCode = 1;
    }
  }
  // quiet: refresh and migrate print their own done line in place of RESUME.
  if (!quiet) console.log(verb === 'backlog'
    ? `PARKED on backlog: "${a.project}" - reactivate with 'gtg active <n>' or "gtg ${a.slug}"`
    : `RESUME: "gtg ${a.slug}"`);
  // Automated creation must preserve unrelated metadata, including review nudge stamps.
  return { skipReview: createOnly, slug: a.slug, project: a.project };
}
const handoff = (argv) => writeHandoff(argv, { which: 'active', verb: 'handoff' });

// refresh / migrate <device>: the handoff (same flags and body as `handoff`), then a new T3 thread
// that resumes it, here or on <device> (lib/move.mjs). One call, one done line in place of
// RESUME. With --slug and no --project the handoff is already written, so only the thread opens.
// The device is checked before the handoff, so a typo writes nothing. A thread that fails to
// open leaves the handoff saved, says so, and exits 1.
async function move(argv, { refresh }) {
  const verb = refresh ? 'refresh' : 'migrate';
  const usage = refresh
    ? 'usage: gtg refresh --project "<Name>" --slug <slug> [handoff flags] < body.md   (or --slug <slug> [--name "<Name>"] once the handoff is written)'
    : 'usage: gtg migrate <device> --project "<Name>" --slug <slug> [handoff flags] < body.md   (or --slug <slug> [--name "<Name>"] once the handoff is written)';
  const positional = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const flags = parseFlags(argv);
  if (refresh === !!positional || (!flags.project && typeof flags.slug !== 'string')) {
    console.error(refresh && positional ? `${usage}\n(for another device, gtg migrate <device>)` : usage);
    process.exitCode = 2;
    return { refused: true };
  }
  if (!canOpenThread(ROOT)) {
    console.error(`gtg ${verb} needs T3 Code: ${NEEDS_T3}`);
    process.exitCode = 2;
    return { refused: true };
  }
  const target = refresh ? thisDevice() : positional.toLowerCase();
  if (!refresh && !loadServers(ROOT)[target]?.home) {
    console.error(`gtg migrate: no device named ${target} with a "home" in .gtg/t3-servers.json`);
    process.exitCode = 2;
    return { refused: true };
  }
  let slug = flags.slug;
  let name = typeof flags.name === 'string' ? flags.name : null;
  let result = {};
  if (flags.project) {
    result = await writeHandoff(refresh ? argv : argv.slice(1), { which: 'active', verb: 'handoff', quiet: true });
    if (result?.refused || result?.forgeFlushFailed) return result;
    ({ slug } = result);
    name = result.project;
  }
  try {
    console.log(await openThread({ root: ROOT, target, slug, name, refresh }));
  } catch (e) {
    console.error(`gtg ${verb}: the handoff is saved, but the thread did not open - ${firstMeaningfulLine(e)}`);
    console.error(`  resume it on ${target} with "gtg ${slug}"`);
    process.exitCode = 1;
  }
  return result;
}

// backlog: with --project it parks a new entry; bare it lists the shelf (Task 3)
function backlog(argv) {
  if (parseFlags(argv).project) return writeHandoff(argv, { which: 'backlog', verb: 'backlog' });
  return backlogList();
}
function backlogList() {
  // Excluded up front, not just in the sortByProject call below, so the header count and the
  // empty-shelf message describe the rows actually rendered.
  const bl = userVisible(entries('backlog'));
  if (!bl.length) {
    console.log("Backlog is empty. Shelf an active entry with 'gtg back <n>', or park an idea with 'gtg backlog --project ...'.");
    return;
  }
  console.log(`${bl.length} backlogged project${bl.length === 1 ? '' : 's'}:`);
  sortByProject(bl).forEach((e, i) => {
    console.log(`${c('33', 'b' + (i + 1) + '.')} ${c('1;36', e.project)} ${c('2', 's' + (e.sessions ?? countHandoffFiles(e.slug)))} [${c('32', e.eta || '?')}]${e.due ? ' ' + c('35', 'due ' + dueLabel(e.due)) : ''} ${c('2', '(parked ' + ago(e.updated) + ')')}${e.harness ? c('2', ' ·' + e.harness) : ''}`);
    console.log(`    next: ${e.next}`);
  });
  console.log('Activate: gtg active <n>');
}

function help() {
  console.log(`gtg - pause/resume + backlog bookkeeping
  gtg handoff --project --slug [--next] [--eta] [--parent] [--worktree] [--branch] [--dry-run]   (body on stdin)
      --due YYYY-MM-DD[THH:MM]  the date the Next Action is tied to (Logic's Week shows it)
      --next defaults to the body's "## Next Action" first line; --worktree to the repo you run it
      from when the hub is a checkout's top, else "repo root"
      [--wip]      commit the worktree's uncommitted work first (worktree only, never the shared root)
      [--exact]    keep --slug literally; by default one name-matching entry lends its slug
      [--harness]  who wrote it (claude|codex|...); auto-detected from the environment
      [--checkpoint] refresh the current handoff and set hook ctx.checkpoint without departure ceremony
      [--expected-body-sha256 <64hex> --expected-shelf active|backlog] guarded handoff of an exact
      existing slug; compare the exact UTF-8 handoff from list --json before writing. Exit 2 on refusal
      appends "## Task list" (harness task store) and, in a worktree, "## Commits this session"
      and "## Files touched" (git log since the session started) unless the body has them;
      runs <root>/.gtg/after-handoff.mjs afterwards if present (default export fn(ctx))
  gtg backlog [same flags]     park on the backlog shelf (body on stdin); bare = list the shelf
  gtg list [project]           active handoffs; read-only, with optional filter
  gtg list --json              the whole store as {"active": [...], "backlog": [...]}, each record
                               with its shelf and its current handoff text (null when none). Read-only
  gtg show <slug> [--json]     print one entry's current handoff, or with --json its record as list
                               --json prints it. Exit 1 when no entry has that slug. Read-only
  gtg --version               plugin version; no hub or network required (guards require >=4.8.1)
  gtg upnext <slug> --text "<item>"
                               add one item to a project's Up next list
  gtg upnext <slug> --edit=<n> --text "<item>" | --remove=<n> | --move=<n> --to=<m>
                               change one Up next item by its position (1 = first)
  gtg upnext <slug> --promote  make Up next item 1 the Next Action (clears the due date)
  gtg edit <slug> [--next] [--eta] [--due|none] [--parent|none]   change fields without a handoff
  gtg back <n|slug> [--wake YYYY-MM-DD]
                               shelf an active entry to the backlog, optionally until a date
  gtg keep <slug> [--wake YYYY-MM-DD]
                               answer a REVIEW line with "still live": restarts its review clock
  gtg active <n|slug>          reactivate a backlog entry
  gtg complete <n|slug>        explicitly finish and clear an entry (active first, then backlog)
  gtg remove <n|slug>          drop an entry (active first, then backlog)
  gtg resume [n|slug|name] [--keep]
                               the whole pick-up: fast-forwards the hub from its upstream
                               (silent when offline or already current), prints the handoff,
                               retains the current entry, runs
                               <root>/.gtg/after-resume.mjs if present. Bare = the
                               only active project, else the list. --keep remains a compatible
                               read-only hint for hooks. Exit 1 = choose from the candidates printed
  gtg supersede <n|slug> [--into <n|slug>]
                               rolled up or created in error (neither ship nor abandon)
  gtg rename <n|slug> <new> [--name "<Display Name>"]
                               change a slug, re-pointing any sub-projects. With a slug nothing
                               here carries, it repairs a stale parent reference instead.
                               --name also moves the listed title, keeping the old one so
                               gtg log still finds history written under it
  gtg unparent <n|slug>        clear an entry's parent, so it lists as standalone
  gtg log [n|slug] [-n N]      what happened, read from git rather than a ledger
  gtg undo                     revert THIS SESSION'S last change to the stores
  gtg stats                    one-screen scoreboard: streak, ships, sessions, effort
  gtg report                   full report JSON -> docs/handoffs/_report.json
  gtg progress <verb>          persistent task progress: init, add, show, list, update
  T3 Code only (https://t3.codes); elsewhere these refuse and write nothing:
  gtg refresh [handoff flags]  (body on stdin) write the handoff, then open a new T3 thread here
                               whose first message is "gtg <slug>"; prints REFRESHED in place
                               of RESUME. --slug <s> [--name "<N>"] alone only opens the thread
  gtg migrate <device> [handoff flags]
                               the same on a device in <root>/.gtg/t3-servers.json (MIGRATED).
                               <root>/.gtg/t3-launch.mjs opens the thread; without it a
                               GTG-LAUNCH line names the T3 MCP calls to make instead
After a move (back/active/remove/resume/undo) the updated list auto-prints when
stdout is a terminal; it stays silent when piped (so an AI wastes no context).
Force either way with --list / --no-list.
Storage root: GTG_HUB env var if set, else the enclosing git repo.
With <root>/.gtg/forge.json the store is record files in a Forgejo/Gitea repo instead
(skills/gtg/references/forge-store.md). log, undo, stats and report need the file store.
stats/report ship bundled; unknown commands dispatch to <root>/.gtg/commands/<name>.mjs,
which overrides a bundled one of the same name - see skills/gtg/references/extending.md.`);
}

let reviewSkip = null; // the entry this command is working on, never the one asked about
// What lib/view.mjs reads the store through. Getters, because main() sets ROOT and the running
// command sets reviewSkip after this object exists.
const view = {
  get root() { return ROOT; },
  entries,
  countHandoffFiles,
  get skip() { return reviewSkip; },
  stampNudged,
};
const renderList = (argv) => renderListFor(argv, view);
const takeReview = (cmd, argv) => takeReviewFor(cmd, argv, view);
// Commits that only record that an entry was read or asked about. undo steps over them, so
// `gtg undo` after a command still reverses that command, not the question printed under it.
const STAMP_SUBJECT = /^gtg (?:nudge|resumed): /;
// The review's question goes on the record, so no session asks about this entry again for
// REVIEW_REPEAT_DAYS. On a stale forge read there is no hub copy to write to, so it is asked again.
function stampNudged(which, slug) {
  if (FORGE?.stale) return;
  const arr = entries(which);
  const e = arr.find((x) => x.slug === slug);
  if (!e) return;
  e.nudged = nowIso();
  commit(saveEntries(which, arr), `gtg nudge: ${e.project}`);
}

function wakeFlag(v) {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    console.error(`gtg: --wake takes a date as YYYY-MM-DD, got '${v}'`);
    process.exit(2);
  }
  return v;
}

// A Next Action's date, from --due: YYYY-MM-DD or YYYY-MM-DDTHH:MM, Singapore local time. Logic
// (the personal planner behind the Sales Ops Board) puts the project on that day in its Week.
function dueOk(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v)) return false;
  const d = new Date(`${v.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(+d) || d.toISOString().slice(0, 10) !== v.slice(0, 10)) return false;
  if (v.length > 10) {
    const [h, m] = v.slice(11).split(':').map(Number);
    if (h > 23 || m > 59) return false;
  }
  return true;
}

// Queued actions opt into exact lookup; ordinary numeric/fuzzy selectors retain their behavior.
const exactSelector = (argv) => parseFlags(argv.slice(1), { boolean: ['exact'] }).exact === true;
const commandEntry = (arr, t, argv, order = sortByProject) => exactSelector(argv)
  ? arr.find((e) => e.slug === t) : resolveEntry(arr, t, order);
const backlogSelector = (t, argv) => exactSelector(argv) ? t : t.replace(/^[bB](?=\d+$)/, '');

function keep(argv) {
  const t = argv.find((x) => !x.startsWith('--'));
  if (!t) { console.error('Usage: gtg keep <slug> [--wake YYYY-MM-DD]'); process.exit(2); }
  const wake = wakeFlag(parseFlags(argv).wake);
  let which = 'active';
  let arr = entries('active');
  let match = commandEntry(arr, t, argv, displayOrder);
  if (!match) {
    which = 'backlog';
    arr = entries('backlog');
    match = commandEntry(arr, backlogSelector(t, argv), argv);
  }
  if (!match) { console.error(`No project matching '${t}'. Try 'gtg list' or 'gtg backlog'.`); process.exit(2); }
  if (which === 'active' && wake) {
    console.error(`gtg: --wake is for shelved work. Shelve it with: gtg back ${match.slug} --wake ${wake}`);
    process.exit(2);
  }
  reviewSkip = match.slug;
  match.reviewed = nowIso(); // not `updated`: nobody worked on it, and list's "Nd ago" stays true
  if (which === 'backlog') { if (wake) match.wake = wake; else delete match.wake; }
  commit(saveEntries(which, arr), `gtg keep: ${match.project}`);
  const quiet = wake ? `until ${wake}` : `for ${Math.max(which === 'active' ? REVIEW_ACTIVE_DAYS : REVIEW_BACKLOG_DAYS, repeatWait(match))} days`;
  console.log(`Kept: ${match.project}. Not asked about again ${quiet}.`);
}

// --- upnext --------------------------------------------------------------------
// The current handoff doc for an entry, from whichever store holds it.
async function readHandoffDoc(match) {
  if (FORGE) return FORGE.latestHandoff(match);
  return match.file && existsSync(join(ROOT, match.file)) ? readFileSync(join(ROOT, match.file), 'utf8') : null;
}
// --- list --json / show ----------------------------------------------------------
// Reads for code rather than a person (Rodney's ATOM register reads its tasks through these). An
// entry as the store holds it, with its shelf and its current handoff text, null when it has none.
// On the forge store that is the raw stored record, since entries() blanks its `file` field and
// readHandoffDoc trims the body (both for the other commands). The file store's handoff is the file.
async function withHandoff(e, shelf) {
  if (FORGE) {
    const { handoff = null, ...rest } = FORGE.stored(e) ?? e;
    return { ...rest, shelf, handoff };
  }
  return { ...e, shelf, handoff: await readHandoffDoc(e) };
}
// list --json prints the whole store and nothing else, so stdout always parses: no rows, no REVIEW
// question, no flush. The dispatcher returns as soon as it sees readOnly. A filter is not applied.
async function list(argv) {
  if (parseFlags(argv, { boolean: ['json'] }).json !== true) return renderList(argv);
  const doc = {};
  for (const shelf of ['active', 'backlog']) doc[shelf] = await Promise.all(entries(shelf).map((e) => withHandoff(e, shelf)));
  console.log(JSON.stringify(doc, null, 2));
  return { readOnly: true };
}
// One entry by its exact slug, on either shelf. Exit codes are set rather than process.exit, since a
// forge read may still have sockets open (see writeHandoff's forge branch).
async function show(argv) {
  const t = argv.find((x) => !x.startsWith('--'));
  if (!t) { console.error('Usage: gtg show <slug> [--json]'); process.exitCode = 2; return { readOnly: true }; }
  const json = parseFlags(argv, { boolean: ['json'] }).json === true;
  for (const shelf of ['active', 'backlog']) {
    const match = entries(shelf).find((e) => e.slug === t);
    if (!match) continue;
    const rec = await withHandoff(match, shelf);
    if (json) console.log(JSON.stringify(rec, null, 2));
    else if (rec.handoff === null) { console.error(`gtg show: '${t}' has no handoff`); process.exitCode = 1; }
    else process.stdout.write(rec.handoff.endsWith('\n') ? rec.handoff : `${rec.handoff}\n`);
    return { readOnly: true };
  }
  console.error(`gtg show: no entry '${t}'`);
  process.exitCode = 1;
  return { readOnly: true };
}

// Queue (forge) or write (file store) the new doc. Returns the file-store paths for commit().
function writeHandoffDoc(match, doc) {
  if (FORGE) { FORGE.queueHandoff(match.slug, doc); return []; }
  writeFileSync(join(ROOT, match.file), doc);
  return [match.file];
}

// Up next changes, without a new checkpoint: nobody worked on the project, so `updated` and
// `sessions` stay. Logic queues these (the planner). Bare --text adds one item to the end; --edit,
// --remove and --move change one item by its 1-based position; --promote makes item 1 the Next Action.
async function upnext(argv) {
  const t = argv[0];
  const f = parseFlags(argv.slice(1), { boolean: ['exact', 'promote'] });
  const usage = 'Usage: gtg upnext <slug> --text "<item>" | --edit=<n> --text "<item>" | --remove=<n> | --move=<n> --to=<m> | --promote';
  const mode = f.promote === true ? 'promote' : ['edit', 'remove', 'move'].find((k) => Object.hasOwn(f, k)) ?? 'add';
  const needsText = mode === 'add' || mode === 'edit';
  if (!t || t.startsWith('--') || (needsText && (typeof f.text !== 'string' || !f.text.trim()))) { console.error(usage); process.exit(2); }
  // A bare --remove is true, and Number(true) is 1: refuse it rather than act on item 1.
  const posKeys = { edit: ['edit'], remove: ['remove'], move: ['move', 'to'] }[mode] ?? [];
  if (posKeys.some((k) => typeof f[k] !== 'string')) { console.error(usage); process.exit(2); }
  const all = [...entries('active').map((e) => ['active', e]), ...entries('backlog').map((e) => ['backlog', e])];
  const found = all.find(([, e]) => e.slug === t);
  if (!found) { console.error(`No project with slug '${t}'. Try 'gtg list' or 'gtg backlog'.`); process.exit(2); }
  const [which, match] = found;
  const doc = await readHandoffDoc(match);
  if (!doc) { console.error(`gtg upnext: ${match.project} has no handoff to add to.`); process.exit(2); }
  if (mode === 'add') {
    commit(writeHandoffDoc(match, addUpNext(doc, f.text)), `gtg upnext: ${match.project}`);
    console.log(`Up next for ${match.project}: ${f.text.replace(/\s+/g, ' ').trim()}`);
    return;
  }
  const list = upNextItems(doc);
  const pos = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > list.length) {
      console.error(list.length ? `gtg upnext: Up next has only ${list.length} items` : 'gtg upnext: Up next is empty');
      process.exit(2);
    }
    return n - 1;
  };
  if (mode === 'promote') {
    if (!list.length) { console.error('gtg upnext: Up next is empty'); process.exit(2); }
    const [head, ...rest] = list;
    // setSection refuses a body line starting with "## ": say so before writing anything.
    if (head.startsWith('## ')) { console.error('gtg upnext: the first Up next item cannot start with "## "'); process.exit(2); }
    const shelf = entries(which);
    const rec = shelf.find((e) => e.slug === t);
    rec.next = head.slice(0, 150);
    delete rec.due;
    const paths = writeHandoffDoc(match, setUpNext(setSection(doc, 'Next Action', head), rest));
    commit([...saveEntries(which, shelf), ...paths], `gtg upnext: promote in ${match.project}`);
    console.log(`Next Action for ${match.project}: ${head}`);
    return { skipReview: true };
  }
  if (mode === 'edit') list[pos(f.edit)] = f.text.replace(/\s+/g, ' ').trim();
  if (mode === 'remove') list.splice(pos(f.remove), 1);
  if (mode === 'move') { const from = pos(f.move), to = pos(f.to); list.splice(to, 0, list.splice(from, 1)[0]); }
  commit(writeHandoffDoc(match, setUpNext(doc, list)), `gtg upnext: ${mode} in ${match.project}`);
  console.log(`Up next for ${match.project}: ${list.length} items`);
}

// One or more fields of an existing entry, without a session handoff. Logic's sheet uses it.
// `updated` is left alone, as upnext leaves it: an edit is not a session.
async function edit(argv) {
  const t = argv[0];
  const f = parseFlags(argv.slice(1), { boolean: ['exact'] });
  const usage = 'Usage: gtg edit <slug> [--next "<text>"] [--eta "<text>"] [--due YYYY-MM-DD[THH:MM]|none] [--parent <slug>|none]';
  const keys = ['next', 'eta', 'due', 'parent'].filter((k) => Object.hasOwn(f, k));
  if (!t || t.startsWith('--') || !keys.length) { console.error(usage); process.exit(2); }
  for (const k of keys) {
    if (typeof f[k] !== 'string' || (k !== 'eta' && !f[k].trim())) { console.error(`gtg edit: --${k} needs a value`); process.exit(2); }
  }
  if (keys.includes('next') && f.next.trim().split(/\r?\n/).some((l) => l.startsWith('## '))) {
    console.error('gtg edit: --next cannot contain a line starting with "## "'); process.exit(2);
  }
  if (keys.includes('due') && f.due !== 'none' && !dueOk(f.due)) {
    console.error(`gtg: --due takes YYYY-MM-DD or YYYY-MM-DDTHH:MM, or none, got '${f.due}'`); process.exit(2);
  }
  if (keys.includes('parent') && f.parent !== 'none' && !SLUG_OK.test(f.parent)) {
    console.error('gtg edit: --parent must be a slug or none'); process.exit(2);
  }
  for (const which of ['active', 'backlog']) {
    const list = entries(which);
    const match = list.find((e) => e.slug === t);
    if (!match) continue;
    const paths = [];
    if (keys.includes('next')) {
      const doc = await readHandoffDoc(match);
      if (!doc) { console.error(`gtg edit: ${match.project} has no handoff to edit.`); process.exit(2); }
      paths.push(...writeHandoffDoc(match, setSection(doc, 'Next Action', f.next)));
      match.next = f.next.split('\n').find((l) => l.trim()).trim().slice(0, 150);
    }
    if (keys.includes('eta')) { if (f.eta.trim()) match.eta = f.eta.trim(); else delete match.eta; }
    if (keys.includes('due')) { if (f.due === 'none') delete match.due; else match.due = f.due; }
    if (keys.includes('parent')) { if (f.parent === 'none') delete match.parent; else match.parent = f.parent; }
    commit([...saveEntries(which, list), ...paths], `gtg edit: ${match.project}`);
    console.log(`Edited ${match.project}: ${keys.join(', ')}`);
    return { skipReview: true };
  }
  console.error(`No project with slug '${t}'. Try 'gtg list' or 'gtg backlog'.`);
  process.exit(2);
}

// --- back / active / remove / undo --------------------------------------------
function back(argv) {
  const t = argv[0];
  if (!t) { console.error("Usage: gtg back <number|slug> [--wake YYYY-MM-DD]  (see 'gtg list')"); process.exit(2); }
  const wake = wakeFlag(parseFlags(argv.slice(1)).wake);
  const act = entries('active');
  const match = commandEntry(act, t, argv, displayOrder);
  if (!match) { console.error(`No active project matching '${t}'. Try 'gtg list'.`); process.exit(2); }
  reviewSkip = match.slug;
  match.updated = nowIso(); // restamp = parked-at
  delete match.reviewed;
  if (wake) match.wake = wake; else delete match.wake;
  const bl = entries('backlog').filter((e) => e.slug !== match.slug);
  bl.push(match);
  const paths = [...saveEntries('active', act.filter((e) => e !== match)),
                 ...saveEntries('backlog', bl)];
  commit(paths, `gtg backlog: park ${match.project}`);
  // `|| match.slug` for the same reason printEntry substitutes a slug label: an extension entry
  // has no position in the listing these numbers index, so indexOf is -1 and the hint would read
  // 'gtg active 0', which resolveEntry turns into arr[-1] and exits 2. Print what actually works.
  const hint = sortByProject(bl).indexOf(match) + 1 || match.slug;
  console.log(`Parked: ${match.project} -> backlog${wake ? ` until ${wake}` : ''}. Bring back: gtg active ${hint}`);
}

function activate(argv) {
  const t0 = argv[0];
  if (!t0) { console.error("Usage: gtg active <number|slug>  (see 'gtg backlog')"); process.exit(2); }
  const t = backlogSelector(t0, argv); // ordinary selectors accept backlog b<n> numbering
  const bl = entries('backlog');
  if (!bl.length) { console.error('Backlog is empty - nothing to activate.'); process.exit(2); }
  const match = commandEntry(bl, t, argv);
  if (!match) { console.error(`No backlog project matching '${t0}'. Try 'gtg backlog'.`); process.exit(2); }
  reviewSkip = match.slug;
  match.updated = nowIso();
  delete match.wake; // picked up, so the date it was waiting for no longer applies
  delete match.reviewed;
  const act = entries('active').filter((e) => e.slug !== match.slug);
  act.push(match);
  const paths = [...saveEntries('backlog', bl.filter((e) => e !== match)),
                 ...saveEntries('active', act)];
  commit(paths, `gtg activate: ${match.project}`);
  // active list is display-ordered. `|| match.slug` is the mirror of the one in back(), and for
  // the same reason: an extension entry has no numbered row, so 'gtg back 0' would exit 2.
  const hint = displayOrder(act).indexOf(match) + 1 || match.slug;
  console.log(`Activated: ${match.project}. Shelve again: gtg back ${hint}`);
}

// The slug is what every other verb takes, and it is ALSO how a sub-project names its family
// via `parent`. So a rename has to re-point the children in the same operation, on both
// shelves, or the family silently splits into orphans that list as standalone.
//
// Legacy dated handoff files keep the old slug deliberately. A canonical current file moves
// with its live entry so reusing the old slug cannot make two lines point at one writable body.
function rename(argv) {
  // Positionals come before any flag, so --name's value can hold spaces without being read as one.
  const cut = argv.findIndex((x) => x.startsWith('--'));
  const [from, to] = cut === -1 ? argv : argv.slice(0, cut);
  const flags = parseFlags(argv);
  if (!from || !to) { console.error('Usage: gtg rename <number|slug> <new-slug> [--name "<Display Name>"]'); process.exit(2); }
  // `--name` with nothing after it parses as true. Renaming a project to the string "true" is
  // never what was meant, and an empty name would leave the entry unlistable.
  if (flags.name !== undefined && typeof flags.name !== 'string') {
    console.error('gtg rename: --name needs a display name'); process.exit(2);
  }
  // Same constraint --slug is held to, and for the same reason: a slug becomes a path segment.
  if (!SLUG_OK.test(to)) {
    console.error('gtg rename: <new-slug> must start with a letter or digit and match [A-Za-z0-9_-]'); process.exit(2);
  }
  const act = entries('active');
  const bl = entries('backlog');
  // Active wins a collision, the same precedence resume uses.
  // --exact (the Logic applier) matches the slug only: no list number, no fuzzy name, and no
  // fall-through to the parent-reference rename below.
  const exact = parseFlags(argv, { boolean: ['exact'] }).exact === true;
  const match = exact
    ? act.find((e) => e.slug === from) ?? bl.find((e) => e.slug === from)
    : resolveEntry(act, from, displayOrder) ?? resolveEntry(bl, from);
  if (!match && exact) { console.error(`No project with slug '${from}'. Try 'gtg list' or 'gtg backlog'.`); process.exit(2); }
  if (!match) {
    // No entry carries this slug, but `parent` names a slug in the PORTFOLIO, not here. So a
    // rename over there leaves references here pointing at something that no longer exists, and
    // repairing them is what `projects rename` tells the caller to run this for. Exact match
    // only, never resolveEntry's fuzzy name matching: a parent is always a slug.
    //
    // No collision check on `to` on this path. The new parent SHOULD normally be a slug that
    // already exists, which is the exact opposite of what the entry case requires.
    const kids = [...act, ...bl].filter((e) => e.parent === from);
    if (!kids.length) {
      console.error(`No project or parent reference matching '${from}'. Try 'gtg list'.`);
      process.exit(2);
    }
    for (const e of kids) e.parent = to;
    const paths = [...saveEntries('active', act), ...saveEntries('backlog', bl)];
    commit(paths, `gtg rename: parent ${from} to ${to}`);
    console.log(`Re-pointed ${kids.length} entr${kids.length === 1 ? 'y' : 'ies'} from parent '${
      from}' to '${to}'. Nothing here carries '${from}' as its own slug.`);
    return;
  }
  const old = match.slug;
  // A name-only rename passes the slug it already has. That is the common case once entries
  // outlive the session that named them: the slug is still right and the title is not.
  const sameSlug = old === to;
  if (sameSlug && !flags.name) { console.error(`gtg rename: '${to}' is already its slug`); process.exit(2); }
  if ([...act, ...bl].some((e) => e !== match && e.slug.toLowerCase() === to.toLowerCase())) {
    console.error(`gtg rename: '${to}' is already used by another project`); process.exit(2);
  }
  // Progress is a separate durable record keyed by the same stable slug. Silently moving only
  // the handoff would orphan its tasks, while moving both needs its own revision-aware contract.
  // Fail closed before any file/store mutation until that operation exists.
  let progressCollision;
  try { progressCollision = progressSlugOnDisk(old) ?? progressSlugOnDisk(to); }
  catch (e) {
    console.error(`gtg rename: cannot inspect progress records - ${firstMeaningfulLine(e)}`);
    process.exit(2);
  }
  if (progressCollision) {
    console.error(`gtg rename: progress '${progressCollision}' is bound to this identity; cannot rename this line of work`);
    process.exit(2);
  }
  const oldCurrent = canonicalHandoffPath(old);
  const newCurrent = canonicalHandoffPath(to);
  const handoffPaths = [];
  if (!sameSlug && sameHandoffPath(match.file, oldCurrent) && existsSync(join(ROOT, oldCurrent))) {
    if (existsSync(join(ROOT, newCurrent))
      || [...act, ...bl].some((e) => e !== match && sameHandoffPath(e.file, newCurrent))) {
      console.error(`gtg rename: handoff path '${newCurrent}' is already in use`);
      process.exit(2);
    }
    mkdirSync(dirname(join(ROOT, newCurrent)), { recursive: true });
    renameSync(join(ROOT, oldCurrent), join(ROOT, newCurrent));
    match.file = newCurrent;
    handoffPaths.push(oldCurrent, newCurrent);
  }
  match.slug = to;
  // The display name moves only when asked. It cannot be derived from the slug: a slug is
  // lowercase and hyphenated, and inferring "Runbook Memory Router" from one would overwrite
  // whatever capitalisation and wording the project actually chose.
  const oldName = match.project;
  if (flags.name && flags.name !== oldName) {
    // `log <slug>` greps commit SUBJECTS for the project name, and every subject written before
    // now carries the old one. Dropping it would blind the filtered log to the project's whole
    // history at the moment its name stops describing it, which is exactly when it gets renamed.
    match.aka = [...new Set([...(match.aka ?? []), oldName])];
    match.project = flags.name;
  }
  let kids = 0;
  for (const e of [...act, ...bl]) if (e.parent === old) { e.parent = to; kids++; }
  // Both stores every time. The entry sits on one shelf but a child can sit on the other.
  // The renamed entry's file MOVES (old.json -> to.json), so `deleted` carries the old name
  // and the commit has to name it or the removal is left staged for another session.
  const paths = [...saveEntries('active', act), ...saveEntries('backlog', bl)];
  commit([...paths, ...handoffPaths],
    sameSlug ? `gtg rename: ${oldName} to ${match.project}` : `gtg rename: ${old} to ${to}`);
  const named = match.project === oldName ? match.project : `${oldName} -> ${match.project}`;
  console.log(`Renamed: ${named} (${sameSlug ? to : `${old} -> ${to}`})${
    kids ? `, re-pointed ${kids} sub-project(s)` : ''}`);
  // Only a slug has a portfolio half. A title that moved on its own leaves nothing to match.
  if (!sameSlug) console.log(`The portfolio slug is separate. Match it with: projects rename ${old} ${to}`);
}

// The inverse of rename's parent path. rename can only re-POINT a parent, and its <new> is
// held to the slug regex, so there was no way to say "this entry belongs to no family".
// Re-pointing a dangling parent at its own project's slug just trades a dangling parent for a
// self-parent, which is the same defect in a different costume.
//
// A dangling parent and a self-parent both already list as standalone (see inferParent), so
// this fixes the stored record rather than today's behaviour: the value stops claiming a
// family that is not there, and a later reader stops having to know that.
//
// Entry-scoped, deliberately, unlike rename's second path which acts on every child of a
// parent at once. Clearing is the operation you want to watch happen one entry at a time.
function unparent(argv) {
  const t = argv[0];
  if (!t) { console.error("Usage: gtg unparent <number|slug>  (see 'gtg list')"); process.exit(2); }
  const act = entries('active');
  const bl = entries('backlog');
  // Active wins a collision, the same precedence rename and resume use.
  const match = resolveEntry(act, t, displayOrder) ?? resolveEntry(bl, t);
  if (!match) { console.error(`No project matching '${t}'. Try 'gtg list'.`); process.exit(2); }
  // Refused rather than passed over, the same call rename makes on a no-op rename. A silent
  // success here reads as "there was a parent and it is gone", which is a different fact.
  if (!match.parent) {
    console.error(`gtg unparent: '${match.slug}' has no parent`);
    process.exit(2);
  }
  const had = match.parent;
  // Deleted, not set to null or '': absent gets ONE representation, which is what every
  // reader here already branches on with a bare truthiness test.
  delete match.parent;
  // `updated` is NOT restamped. Bookkeeping is not work, the same rule rename follows, and
  // restamping would falsely report bookkeeping as project activity.
  const paths = [...saveEntries('active', act), ...saveEntries('backlog', bl)];
  commit(paths, `gtg unparent: ${match.project}`);
  console.log(`Cleared parent '${had}' from ${match.project}. It now lists as standalone.`);
}

// The record IS git. Every verb here commits with a descriptive subject, so the two stores
// already carry the whole history and a written ledger would be a second, thinner copy of it.
// Subjects carry the project NAME rather than the slug, so filtering resolves the entry first.
function log(argv) {
  const t = argv.find((a) => !a.startsWith('-'));
  const i = argv.indexOf('-n');
  const n = i === -1 ? '20' : (argv[i + 1] ?? '20');
  const filter = [];
  if (t) {
    const match = resolveEntry(entries('active'), t, displayOrder)
      ?? resolveEntry(entries('backlog'), t);
    if (!match) { console.error(`No project matching '${t}'. Try 'gtg list'.`); process.exit(2); }
    // --fixed-strings: a project name is free text and can hold regex metacharacters.
    // Every name it has been called, because several --grep terms OR together and the subjects
    // under a former name are the same project's history.
    filter.push('--fixed-strings');
    for (const n of [match.project, ...(match.aka ?? [])]) filter.push('--grep', n);
  }
  let out = '';
  try {
    out = execFileSync('git', ['log', `-n${n}`, '--date=short', '--format=%h %ad %s',
      ...filter, '--', ...STORE_PATHSPEC],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch {
    console.error('gtg log: no git history here'); process.exit(1);
  }
  process.stdout.write(out || 'gtg log: nothing recorded yet\n');
}

function remove(argv, { completed = false } = {}) {
  const t = argv[0];
  if (!t) { console.error(`Usage: gtg ${completed ? 'complete' : 'remove'} <number|slug>  (see 'gtg list')`); process.exit(2); }
  const act = entries('active');
  const match = commandEntry(act, t, argv, displayOrder);
  if (match) {
    commit(saveEntries('active', act.filter((e) => e !== match)),
      `gtg prune: remove ${match.project} - confirmed done`);
    console.log(`${completed ? 'Completed' : 'Removed'}: ${match.project}`);
    return;
  }
  // not in active - try the backlog (lets resume-consume clear a pulled backlog item)
  const bl = entries('backlog');
  const blMatch = commandEntry(bl, backlogSelector(t, argv), argv);
  if (blMatch) {
    commit(saveEntries('backlog', bl.filter((e) => e !== blMatch)),
      `gtg prune: remove ${blMatch.project} from backlog - confirmed done`);
    console.log(`${completed ? 'Completed' : 'Removed'} from backlog: ${blMatch.project}`);
    return;
  }
  console.error(`No project matching '${t}'. Try 'gtg list' or 'gtg backlog'.`);
  process.exit(2);
}
const complete = (argv) => remove(argv, { completed: true });

// supersede = this entry was rolled up or created in error, NOT shipped and NOT
// given up on. `remove` writes a phantom ship and `back` reads as shelved-for-later,
// so consolidating N slices into one parent used to corrupt whichever stat you
// borrowed (2026-07-25: 7 slices reported as abandoned forever, 12 minutes after
// being consolidated into a live sub-project). Its own subject gives history.mjs a
// type to exclude from both ships and abandonments, and --into records which entry
// absorbed it rather than leaving the roll-up implicit.
function supersede(argv) {
  const [t, ...rest] = argv;
  if (!t) { console.error('Usage: gtg supersede <number|slug> [--into <number|slug>]'); process.exit(2); }
  const i = rest.indexOf('--into');
  if (i !== -1 && !rest[i + 1]) { console.error('gtg supersede: --into needs a target'); process.exit(2); }
  const intoArg = i === -1 ? null : rest[i + 1];

  const act = entries('active');
  const bl = entries('backlog');
  const exact = parseFlags(rest, { boolean: ['exact'] }).exact === true;
  const stripB = (s) => s.replace(/^[bB](?=\d+$)/, '');
  // Active wins a collision, the same precedence resume and rename use.
  const match = exact
    ? act.find((e) => e.slug === t) ?? bl.find((e) => e.slug === t)
    : resolveEntry(act, t, displayOrder) ?? resolveEntry(bl, stripB(t));
  if (!match) { console.error(`No project matching '${t}'. Try 'gtg list' or 'gtg backlog'.`); process.exit(2); }

  // The absorbing entry is usually a gtg entry, but it can equally be a docs/projects
  // page no entry exists for, so an unresolvable target passes through as text rather
  // than being rejected.
  let into = null;
  if (intoArg) {
    const target = exact
      ? act.find((e) => e.slug === intoArg) ?? bl.find((e) => e.slug === intoArg)
      : resolveEntry(act, intoArg, displayOrder) ?? resolveEntry(bl, stripB(intoArg));
    if (exact && !target) { console.error(`No project with slug '${intoArg}'. Try 'gtg list' or 'gtg backlog'.`); process.exit(2); }
    if (target === match) { console.error('gtg supersede: an entry cannot supersede itself'); process.exit(2); }
    into = target ? target.project : intoArg;
  }

  const paths = [...saveEntries('active', act.filter((e) => e !== match)),
                 ...saveEntries('backlog', bl.filter((e) => e !== match))];
  commit(paths, `gtg supersede: ${match.project}${into ? ` into ${into}` : ''}`);
  console.log(`Superseded: ${match.project}${into ? ` -> ${into}` : ' (created in error)'}`);
}

// Resume resolves the name, prints the current handoff and runs the after-resume
// hook without mutating the store. Before 3.0.0 the skill read both store files (25KB on a
// busy hub), then the handoff, then called consume, then probed for a markdown hook: five
// turns and the entire store in context to pick one entry out of it.
//
// Exit codes: 0 resumed, 1 a choice is needed (candidates printed on stdout), 2 nothing to
// resume.
// lib/resume.mjs returns 1 or 2 for a choice or nothing to resume. It exits here at once, before
// the dispatcher's flush, auto-list and review, which is where it used to call process.exit.
async function resumeConsume(argv) {
  const code = await resumeFor(argv, {
    root: ROOT, forge: FORGE, entries, saveEntries, commandFileFor, readStore, writeStore, commit,
    listAll: () => renderList([]), onPick: (slug) => { reviewSkip = slug; },
  });
  if (code !== undefined) process.exit(code);
}
function commandFileFor(t) {
  if (!/^[A-Za-z0-9_-]+$/.test(t)) return false;
  return existsSync(join(ROOT, '.gtg', 'commands', `${t}.mjs`))
    || existsSync(join(CLI_DIR, 'extensions', 'commands', `${t}.mjs`));
}

// undo = restore BOTH stores from before THIS SESSION'S last commit that touched
// either one; repeats to step further back. Two refusals guard the concurrent case,
// both of them loud: no change of ours to undo, and our change no longer being the
// tip. Before 2026-08-04 undo took whatever commit was last and reverted it.
//
// Finding C1, and the rule it left behind: the anchor must span BOTH collections.
// It was once picked from the active store alone, but two mutations touch the
// backlog ONLY (`gtg backlog --project ...` parking a new idea, and explicit
// completion of backlog work), so an active-only anchor skipped right past those,
// landed on an unrelated older active-list commit, reverted THAT instead, and
// silently deleted the backlog. STORE_PATHSPEC is what keeps that fixed now: it
// names both sharded directories, so a backlog-only commit is still the anchor,
// and it keeps the deleted packed files too so undoing a pre-shard commit works.
//
// The restore below is per PATH rather than per store. A sharded collection is
// many files and a commit usually touches one or two of them, so rewinding a
// whole directory would discard records the commit never mentioned - the same
// class of over-reach C1 was about, one level down.
function undo() {
  // The newest store commit that is not a stamp (STAMP_SUBJECT).
  const storeLog = (extra = []) => {
    try {
      return execFileSync('git', ['log', '-n', '200', '--format=%H%x1f%s%x1f%ar', ...extra, '--', ...STORE_PATHSPEC],
        { cwd: ROOT }).toString().split('\n').map((l) => l.trim())
        .find((l) => l && !STAMP_SUBJECT.test(l.split('\x1f')[1])) ?? '';
    } catch { return ''; }
  };
  const parse = (line) => { const [sha, subject, age] = line.split('\x1f'); return { sha, subject, age }; };

  const tipLine = storeLog();
  if (!tipLine) { console.error('No gtg history to undo.'); process.exit(2); }
  const tip = parse(tipLine);

  // Undo means "revert MY last change", which is how it has always been advertised.
  // Without a session id there is no way to tell whose change is whose, so refuse
  // rather than revert a stranger's (see SESSION_ID above).
  if (!SESSION_ID) {
    console.error('gtg undo: no session id, so gtg cannot tell your change from another session\'s.');
    console.error(`  Last store commit: '${tip.subject}' (${tip.age}, ${tip.sha.slice(0, 8)})`);
    console.error('  Set GTG_SESSION_ID to scope undo, or revert that commit by hand if it is yours.');
    process.exit(2);
  }
  const mineLine = storeLog(['-F', '--grep', `${SESSION_TRAILER}: ${SESSION_ID}`]);
  if (!mineLine) {
    console.error('gtg undo: no change from this session to undo.');
    console.error(`  Last store commit: '${tip.subject}' (${tip.age}, ${tip.sha.slice(0, 8)}) - not this session's.`);
    process.exit(2);
  }
  const mine = parse(mineLine);

  // Scoping the ANCHOR is not enough on its own: the restore below rewinds each
  // store to the anchor's PARENT, which would also throw away anything committed
  // after it. So the change being undone has to still be the tip of store history.
  if (mine.sha !== tip.sha) {
    console.error(`gtg undo: another session changed the store after yours - undoing would discard their work.`);
    console.error(`  Yours:  '${mine.subject}' (${mine.age})`);
    console.error(`  Theirs: '${tip.subject}' (${tip.age}, ${tip.sha.slice(0, 8)})`);
    process.exit(2);
  }

  const last = mine.sha;
  const subject = mine.subject;

  // Rewind every store or handoff-body path the anchor commit touched to its state at
  // `${last}^`. Persistent handoffs overwrite one current body, so restoring only
  // the record would pair a session-1 entry with session-2 prose. The packed store
  // made this two whole files; a sharded store is many, so the unit is now "the paths this
  // commit changed" and git names them for us. STORE_PATHSPEC covers the packed files too, so
  // an undo of a pre-shard commit still works exactly as it used to. `--root` keeps the
  // very-first-commit case working (no parent to diff against).
  //
  // A path absent at `last^` was CREATED by this commit, so undoing it means removing it -
  // the same rule the packed version followed, and the reason a deletion has to be in the
  // commit path list below rather than left in the working tree.
  const isStorePath = (rel) => STORE_PATHSPEC.some((path) => rel === path || rel.startsWith(path + '/'));
  let changed = [];
  try {
    changed = execFileSync('git', ['diff-tree', '-r', '--root', '--no-commit-id', '--name-only',
      last, '--', 'docs/handoffs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n').map((s) => s.trim())
      .filter((rel) => rel && (isStorePath(rel) || isHandoffDocPath(rel)));
  } catch { /* the empty check below reports it */ }

  // Refuse before restoring any store path if a handoff body has uncommitted edits.
  // The anchor proves ownership of its own committed body change, not of a later
  // body-only commit or later working-tree prose.
  for (const rel of changed.filter(isHandoffDocPath)) {
    try {
      const bodyTip = execFileSync('git', ['log', '-1', '--format=%H', '--', rel],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (bodyTip !== last) {
        console.error(`gtg undo: handoff body changed after the store commit: ${rel}`);
        process.exit(2);
      }
      const dirty = execFileSync('git', ['status', '--porcelain', '--', rel],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (dirty) {
        console.error(`gtg undo: handoff body has uncommitted changes: ${rel}`);
        process.exit(2);
      }
    } catch (e) {
      console.error(`gtg undo: cannot verify handoff body before restore - ${firstMeaningfulLine(e)}`);
      process.exit(2);
    }
  }

  const paths = [];
  for (const rel of changed) {
    const abs = join(ROOT, rel);
    let prev = null;
    try { prev = execFileSync('git', ['show', `${last}^:${rel}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
    catch { /* absent at last^ - this commit created it */ }
    if (prev !== null) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, prev); }
    else if (existsSync(abs)) rmSync(abs);
    else continue; // created by the commit and already gone - nothing to undo for this path
    paths.push(rel);
  }
  if (!paths.length) {
    console.error(`Nothing before '${subject}' - can't undo further.`);
    process.exit(2);
  }

  commit(paths, `gtg undo: revert '${subject}'`);
  // Report what came back without a second full render.
  const names = entries('active').map((e) => e.project);
  console.log(`Undone: ${subject}`);
  console.log(`Active entries now (${names.length}): ${names.join(', ') || '(none)'}`);
}

// After a move (back/active/remove/resume/undo) a HUMAN wants the updated list;
// an AI does not - gtg runs piped when a tool invokes it (stdout not a TTY), so
// TTY-gating suppresses the render for models with zero wasted context, no flag
// needed. --list / --no-list force it either way.
function maybeAutoList(argv) {
  const a = parseFlags(argv);
  if (a['no-list']) return;
  if (a.list || process.stdout.isTTY) renderList([]);
}
const MOVE_CMDS = new Set(['back', 'active', 'complete', 'remove', 'rm', 'prune', 'resume', 'undo', 'rename', 'supersede', 'keep']);

// --- dispatch -----------------------------------------------------------------
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--version') {
    console.log(JSON.parse(readFileSync(join(CLI_DIR, '../../package.json'), 'utf8')).version);
    return;
  }
  // Validate guard syntax even when the hub is unavailable, before reading/mutating its store.
  if (['handoff', 'backlog'].includes(cmd)) {
    const flags = parseFlags(rest);
    const hash = flags['expected-body-sha256'];
    const shelf = flags['expected-shelf'];
    if (Object.hasOwn(flags, 'expected-body-sha256') || Object.hasOwn(flags, 'expected-shelf')) {
      if (cmd !== 'handoff' || typeof hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hash)
        || !['active', 'backlog'].includes(shelf)) {
        console.error('gtg handoff: guard requires paired --expected-body-sha256 <64hex> --expected-shelf active|backlog');
        process.exitCode = 2;
        return;
      }
    }
  }
  // help reads no store, so it skips the git spawn, which was about 80 ms of a 137 ms `gtg help`.
  ROOT = ['help', '--help', '-h'].includes(cmd) ? '' : resolveRoot();
  const builtins = {
    handoff, backlog, list, show, help, '--help': help, '-h': help,
    back, active: activate, complete, remove, rm: remove, prune: remove, resume: resumeConsume, undo,
    rename, unparent, log, supersede, keep, upnext, edit,
    refresh: (argv) => move(argv, { refresh: true }), migrate: (argv) => move(argv, { refresh: false }),
  };
  // Forge store: load before the command, flush after it. Commands that never read the records skip
  // the network. The refused ones read git history of the file store, which the forge store does
  // not write, so on a forge they would report an empty history as if it were the truth.
  const NO_STORE = new Set(['help', '--help', '-h', 'progress']);
  const FORGE_REFUSED = new Set(['log', 'undo', 'stats', 'report']);
  // Commands that never write the store, so they may run on a stale cached read. undefined = bare gtg.
  const STALE_OK = new Set([undefined, 'list', 'show', 'resume', 'learn']);
  // A failed or refused forge read stops the command with exit 1. Not process.exit: on Windows
  // (Node 24) exiting while fetch sockets are open trips a libuv assertion, and the process dies
  // with 0xC0000409 instead of 1 (seen on a 401). See writeHandoff's forge branch.
  // Extension lookup, in resolution order: user <root>/.gtg/commands/<cmd>.mjs FIRST (user
  // overrides bundled), then the plugin's own extensions/commands/<cmd>.mjs (bundled, ships
  // active). cmd becomes a path segment - constrain it the same way --slug is, so it can't
  // traverse paths. Resolved before the forge opens, so an unknown verb costs no request (#97).
  let ext = null;
  if (cmd && !Object.hasOwn(builtins, cmd)) {
    const safe = /^[A-Za-z0-9_-]+$/.test(cmd);
    const userExt = safe ? join(ROOT, '.gtg', 'commands', `${cmd}.mjs`) : null;
    const bundledExt = safe ? join(CLI_DIR, 'extensions', 'commands', `${cmd}.mjs`) : null;
    ext = (userExt && existsSync(userExt)) ? userExt
      : (bundledExt && existsSync(bundledExt)) ? bundledExt
      : null;
    if (!ext) {
      console.error(`gtg: unknown command '${cmd}' - try 'gtg help'`);
      process.exit(2);
    }
  }
  let stopped = false;
  if (!NO_STORE.has(cmd)) {
    let cfg;
    try { cfg = forgeConfig(ROOT); } catch (e) { console.error(`gtg: ${e.message}`); process.exit(2); }
    if (cfg && FORGE_REFUSED.has(cmd)) {
      console.error(`gtg ${cmd}: not available on the forge store. The history is the commit log of ${cfg.repo}.`);
      process.exit(2);
    }
    if (cfg) {
      try { FORGE = await openForge(cfg); } catch (e) {
        console.error(`gtg: cannot read the forge store - ${firstMeaningfulLine(e)}`);
        stopped = true;
      }
    }
    // #29: the hub was unreachable and the read came from the local cache. Read-only commands run on
    // it, marked stale. handoff and backlog <idea> go on to the write guard in lib/forge.mjs, so the
    // handoff body read from stdin is saved to a file as on any failed forge write. Every other
    // command could write, so it stops here, before it prints anything that reads as done.
    if (FORGE?.stale) {
      const readOnly = STALE_OK.has(cmd) || (cmd === 'backlog' && !parseFlags(rest).project);
      // refresh and migrate write a handoff, so they get handoff's saved-body guard too.
      if (!readOnly && !['handoff', 'backlog', 'refresh', 'migrate'].includes(cmd)) {
        console.error(`gtg ${cmd}: refused, the hub is unreachable. Only the cached store from ${FORGE.stale} could be read, and a write must start from the hub's copy. Re-run it when the hub is back.`);
        stopped = true;
      } else if (readOnly) {
        // To stderr under --json, so a stale read still prints one JSON object on stdout.
        const json = ['list', 'show'].includes(cmd) && parseFlags(rest, { boolean: ['json'] }).json === true;
        (json ? console.error : console.log)(`(stale, hub unreachable) cached store from ${FORGE.stale}`);
      }
    }
  }
  const flushForge = async () => {
    if (!FORGE) return;
    try { await FORGE.flush(cmd ?? 'list'); } catch (e) {
      console.error(`gtg: forge write failed partway, re-run the command - ${firstMeaningfulLine(e)}`);
      process.exitCode = 1; // not process.exit, see writeHandoff's forge branch
    }
  };
  if (stopped) process.exitCode = 1;
  // The review is taken before the flush, so its stamp rides in the same write, and printed last,
  // so a command's own result line (Completed:, Parked:) sits directly above the question.
  else if (!cmd) {
    renderList([]);
    const review = takeReview('list', []);
    await flushForge();
    if (review) console.log(review);
  }
  // hasOwn, not truthiness: every inherited Object key resolved here, so `gtg constructor` and
  // `gtg toString` called something that is not a verb instead of falling through to the
  // extension lookup and then the unknown-command error.
  else if (Object.hasOwn(builtins, cmd)) {
    // Validate on the CHILD command's freshly loaded backend, as well as the applier's check.
    // This is pre-mutation validation, not a cross-service transaction or distributed lock.
    if (['complete', 'back', 'active', 'keep', 'upnext', 'edit', 'rename', 'supersede', 'remove'].includes(cmd)) {
      const flags = parseFlags(rest.slice(1), { boolean: ['exact'] });
      if (flags.exact === true || Object.hasOwn(flags, 'expected-shelf')) {
        const all = ['active', 'backlog'].flatMap((shelf) => entries(shelf).map((e) => ({ ...e, shelf })));
        const matches = all.filter((e) => e.slug === rest[0]);
        let error;
        if (flags.exact !== true) error = '--expected-shelf requires --exact';
        else if (Object.hasOwn(flags, 'expected-shelf') && !['active', 'backlog'].includes(flags['expected-shelf'])) error = 'Invalid expected shelf';
        else if (!matches.length) error = 'Project no longer exists with this exact slug';
        else if (matches.length !== 1) error = 'Project slug is ambiguous across shelves';
        else if (flags['expected-shelf'] && matches[0].shelf !== flags['expected-shelf']) error = 'Project changed shelf since this action was queued';
        if (error) { console.error(`gtg: ${error}`); process.exitCode = 2; return; }
      }
    }
    const result = await builtins[cmd](rest);
    // readOnly: list --json and show, whose stdout is the answer and nothing else.
    if (result?.refused || result?.readOnly) return;
    // Queued children cannot show the user a review question, so never stamp it as asked.
    const automated = result?.skipReview || Object.hasOwn(parseFlags(rest), 'expected-shelf');
    const review = REVIEW_CMDS.has(cmd) && !result?.forgeFlushFailed && !automated ? takeReview(cmd, rest) : null;
    // writeHandoff already reported the failure and saved the stdin body.
    if (!result?.forgeFlushFailed) await flushForge();
    if (MOVE_CMDS.has(cmd)) maybeAutoList(rest);
    if (review) console.log(review);
  }
  else {
    // Extension dispatch, ext resolved above. ctx is a STABILITY CONTRACT (additive-only).
    try {
      const mod = await import(pathToFileURL(ext).href);
      if (typeof mod.default !== 'function') throw new Error('no default export function');
      const ownParent = EXTENSIONS[cmd] ?? null;
      // Both stores, always: a shelved package is still live, so an active-only read would
      // report it as missing.
      //
      // Through `entries`, NOT `readStore`: readStore is a whole-file JSON reader, kept at its
      // packed shape for the published extension context, so reading records through it here
      // would name a file that no longer exists and serve learn.mjs a silent
      // empty list - every live entry reported as missing, at exit 0.
      const ownEntries = () => {
        const grab = (which) => (ownParent ? entries(which).filter((e) => e.parent === ownParent) : []);
        return { active: grab('active'), shelved: grab('backlog') };
      };
      // Read-only authority for extensions that run child GTG commands. Re-open Forge rather
      // than reuse this process's startup snapshot. Leave FORGE (and any pending writes) alone.
      const projectEntries = async () => {
        const cfg = forgeConfig(ROOT);
        const fresh = cfg ? await openForge(cfg) : null;
        if (fresh?.stale) throw new Error('Cannot verify project state: the hub is unreachable and its cached copy is stale.');
        const grab = (shelf) => (fresh ? fresh.entries(shelf) : readCollection(ROOT, COLLECTIONS[shelf], { name: 'gtg' }))
          .map((e) => ({ ...e, shelf }));
        return [...grab('active'), ...grab('backlog')];
      };
      // ownParent rides the ctx as well as being closed over by ownEntries: an extension that
      // WRITES an entry needs the same namespace its reader filters on, and deriving it a
      // second time on the writer side is exactly the drift class this closes.
      await mod.default({
        root: ROOT, args: rest, readStore, writeStore, commit, countHandoffFiles,
        ownEntries, ownParent, projectEntries, sessionId: PROGRESS_SESSION_ID || undefined,
      });
      await flushForge();
    } catch (e) {
      console.error(`gtg: extension '${cmd}' failed: ${(e?.message || String(e)).split('\n')[0]}`);
      process.exit(1);
    }
  }
}

// Real paths on both sides. Through a junction argv[1] keeps the link while node resolves this
// module to its target, and a plain compare would never run main (runbooks #32).
if (isMain(import.meta.url)) await main(process.argv.slice(2));
