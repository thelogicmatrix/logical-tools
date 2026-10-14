// The resume pick-up and the hub sync ahead of it. Moved out of gtg.mjs (#30) so both can be tested
// in-process. resumeConsume takes its collaborators on a ctx instead of gtg.mjs module state:
//   ctx.root, ctx.forge (null on the file store), ctx.entries(which), ctx.commandFileFor(token),
//   ctx.readStore / writeStore / commit (handed on to the after-resume hook),
//   ctx.listAll() (the bare list), ctx.onPick(slug) (the entry the review line must skip).
// A choice (1) or nothing to resume (2) is RETURNED, and the dispatcher exits with it straight
// away, so the order of output and exit is what it was when this called process.exit itself.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { firstMeaningfulLine, runGit } from './git.mjs';
import { readProgress, renderProgress } from './progress.mjs';
import { displayOrder, nowIso, parseFlags, resolveEntry, userVisible } from './view.mjs';
// Fallback sync target, used only when the branch has no upstream - the reasoning lives at
// syncTarget() below, beside the code that consults it.
const SYNC_REMOTE = process.env.GTG_SYNC_REMOTE || 'origin'; // fallback only: the hub's mirror
const SYNC_BRANCH = process.env.GTG_SYNC_BRANCH || 'main';   // fallback only: the branch that mirror carries
// syncHub runs once per process, called from resumeConsume. The memo outlived the second caller
// that needed it - an import-time sync ahead of the self-migration, removed in 3.3.0 with the
// migration itself - and is kept because it is what makes the call idempotent for any future
// caller: a second fetch costs another 5-second timeout with the hub unreachable.
let synced = false;
// The machine a handoff is written on, recorded so a resume elsewhere can say where its worktree is.
// A container reports its own hostname, which is the container id unless it was started with one.
export const thisDevice = () => hostname().toLowerCase();
const FETCH_FRESH_MS = 60000;

// Fast-forward the hub from whatever it tracks before anything reads the store. POSITION IS THE WHOLE
// POINT (2026-09-01): this shipped first inside .gtg/after-resume.mjs, which runs AFTER
// entries() has read, the handoff has printed and the consume has committed - so home was
// always one commit ahead and --ff-only aborted in exactly the case the sync exists for, a
// mirror carrying the other machine's work. A fetch after the read cannot change what the
// read returned. Handing entries between two machines is why this store is git at all.
// Background: docs/runbooks/git-parity.md.
//
// A convenience, NEVER a gate. Every git failure is swallowed and each call capped at 5s, so
// a resume offline, off Tailscale, in a repo with no such remote, or mid-rebase behaves
// exactly as it did before this existed. And stdout speaks only on a real fast-forward: a
// line on every resume is noise, and noise on the hot path is how a real one goes unread.
// WHERE to sync from is resolved per branch, not named (2026-09-01 fix round). The first cut
// hardcoded one remote/branch pair, which made the feature one-directional: the other machine's
// clone calls the same repo `origin` and may sit on `main`, so its every resume fetched nothing and said
// nothing - half of the two-machine handoff this plan exists for was simply not implemented.
//
// branch.<b>.remote + branch.<b>.merge rather than `rev-parse @{u}`: @{u} answers with
// "<remote>/<branch>" as ONE string, and either half may itself contain a slash, so splitting it
// guesses. The config keys hold the two halves already separated.
//
// No upstream falls back to GTG_SYNC_REMOTE / GTG_SYNC_BRANCH (default origin/main), and only on
// that branch. A feature branch with no
// upstream must never be moved, gtg runs from feature worktrees, and a detached HEAD (mid-rebase,
// mid-bisect) reports 'HEAD' and skips. Where an upstream DOES exist it is always the right
// target, so the lookup carries the guard the branch comparison used to.
export function syncTarget(git) {
  let branch;
  try { branch = git('rev-parse', '--abbrev-ref', 'HEAD'); } catch { return null; }
  if (!branch || branch === 'HEAD') return null;
  try {
    const remote = git('config', '--get', `branch.${branch}.remote`);
    const merge = git('config', '--get', `branch.${branch}.merge`);
    // Anchored: branch.<b>.merge is a full ref, so the prefix is only ever at the START. Unanchored,
    // a branch legitimately named `x/refs/heads/y` gets mangled into `x/y`.
    if (remote && merge) return { remote, branch: merge.replace(/^refs\/heads\//, '') };
  } catch { /* --get exits 1 when unset: no upstream, try the fallback below */ }
  return branch === SYNC_BRANCH ? { remote: SYNC_REMOTE, branch: SYNC_BRANCH } : null;
}
export function syncHub(root) {
  if (synced) return; // once per process - see `synced` up by the migration block
  synced = true;
  if (process.env.GTG_NO_SYNC) return; // isolated tests and explicit offline callers
  // stderr piped, not inherited: execFileSync forwards a child's stderr to ours otherwise,
  // and git narrates a refused fast-forward in nine hint: lines - five of git's own above every
  // line of ours. The after-resume hook piped it for the same reason before this moved here.
  const git = (...args) => execFileSync('git', args,
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).toString().trim();
  const target = syncTarget(git);
  if (!target) return; // detached, or a branch with neither an upstream nor the fallback's name
  const name = `${target.remote}/${target.branch}`;
  let before;
  try {
    let fetchHead;
    [before, fetchHead] = git('rev-parse', 'HEAD', '--git-path', 'FETCH_HEAD').split('\n');
    // #101: a fetch under a minute old means another resume (or session) just synced, so skip the
    // fetch and the merge. The whole sync, not just the fetch: FETCH_HEAD may hold another branch
    // from a manual fetch, and merging that would be wrong. A missing FETCH_HEAD throws: fetch.
    let fresh = false;
    try { fresh = Date.now() - statSync(resolve(root, fetchHead)).mtimeMs < FETCH_FRESH_MS; } catch { /* never fetched */ }
    if (fresh) return;
    git('fetch', '--quiet', target.remote, target.branch);
  } catch { return; } // no remote, host down, offline, not a repo: local state stands, silently
  try {
    // FETCH_HEAD, not <remote>/<branch>: the fetch above just set it to exactly what came down,
    // so nothing here rests on the remote's refspec having updated a tracking ref - and a
    // branch.<b>.remote holding a URL rather than a name has no tracking ref at all.
    // runGit, so a commit in another session holding index.lock is waited out (#101). Capped
    // at 5 s like the other calls here.
    runGit(['merge', '--ff-only', '--quiet', 'FETCH_HEAD'], { cwd: root, timeout: 5000 });
  } catch {
    // The fetch landed and the fast-forward was refused. Home being AHEAD of the mirror is the
    // normal state and says nothing. The mirror holding commits home does not have means a
    // genuine fork or a dirty tree in the way, and resolving either is the user's call, not a
    // resume's - auto-merging a divergence is what caused the 2026-08-02 fork. On stderr, so
    // "stdout speaks only on a real fast-forward" still holds.
    try { git('merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'); } catch {
      console.error(`gtg: ${name} will not fast-forward (diverged, or local changes in the way) - resuming from local state`);
    }
    return;
  }
  try {
    const after = git('rev-parse', 'HEAD');
    if (after !== before) console.log(`Synced ${name}: fast-forwarded to ${after.slice(0, 7)}`);
  } catch { /* the merge already succeeded; failing to name it is not worth a word */ }
}

export async function resumeConsume(argv, ctx) {
  const a = parseFlags(argv);
  const t = argv.find((x) => !x.startsWith('--'));
  // Before the reads below, deliberately. See syncHub: after them it is decoration.
  // On the forge store too (4.5.0): the forge holds records and handoffs, but the progress record
  // (which supersedes the handoff snapshot) and the portfolio rows the after-resume hook flips are
  // still files in the hub's git, as stale as the last scheduled pull without this.
  syncHub(ctx.root);
  const act = ctx.entries('active');
  const bl = ctx.entries('backlog');
  let match = null;
  let fromBacklog = false;
  if (!t) {
    // Bare `gtg` at session start: one open project is not a choice, several are.
    const vis = userVisible(act);
    if (vis.length === 1) match = vis[0];
    else {
      ctx.listAll();
      console.log(vis.length ? '\nWhich? gtg <project>' : '\nNothing to resume.');
      return vis.length ? 1 : 2;
    }
  } else {
    match = resolveEntry(act, t, displayOrder);
    // A name fragment that fits several projects is a question, not a guess. A number or an
    // exact slug is never ambiguous.
    const nameHits = act.filter((e) => e.project.toLowerCase().includes(t.toLowerCase()));
    if (match && !/^\d+$/.test(t) && match.slug !== t && nameHits.length > 1) {
      console.log(`'${t}' matches ${nameHits.length} active projects:`);
      nameHits.forEach((e, i) => console.log(`  ${i + 1}. ${e.project} (${e.slug}) - ${e.next}`));
      console.log('Which? gtg <slug>');
      return 1;
    }
    if (!match) {
      match = resolveEntry(bl, t.replace(/^[bB](?=\d+$)/, ''));
      fromBacklog = !!match;
    }
    if (!match) {
      console.error(ctx.commandFileFor(t)
        ? `No project matching '${t}'; '${t}' is a command - run gtg ${t}.`
        : `No project matching '${t}'. Try 'gtg list' or 'gtg backlog'.`);
      return 2;
    }
    // Session-start collision: a project AND a command share the token (a project called
    // `learn`, say). Both are real; picking silently made one of them unreachable.
    if (!/^\d+$/.test(t) && ctx.commandFileFor(t)) {
      console.log(`'${t}' is both a project and a command:`);
      console.log(`  1. ${match.project} (${match.slug}) - ${match.next}`);
      console.log(`  2. run the \`${t}\` command`);
      console.log('Which?');
      return 1;
    }
  }
  ctx.onPick(match.slug);
  // A resume touches the entry, so no later session calls it stale. `resumedAt`, not `updated`: list's
  // age stays the last handoff. A stale forge read has no hub copy to write to, so it skips the stamp.
  // Touched within the day, the stamp would change nothing the review reads, so it costs no write.
  const seen = Math.max(...['updated', 'reviewed', 'resumedAt'].map((k) => Date.parse(match[k]) || 0));
  if (!ctx.forge?.stale && Date.now() - seen >= 864e5) {
    try {
      match.resumedAt = nowIso();
      ctx.commit(ctx.saveEntries(fromBacklog ? 'backlog' : 'active', fromBacklog ? bl : act), `gtg resumed: ${match.project}`);
    } catch (e) {
      console.error(`gtg: resume not recorded - ${firstMeaningfulLine(e)}`);
    }
  }
  const file = match.file ? join(ctx.root, match.file) : null;
  const body = ctx.forge ? await ctx.forge.latestHandoff(match)
    : file && existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  const progress = readProgress(ctx.root, match.slug, { optional: true });
  const when = typeof match.updated === 'string' ? match.updated.slice(0, 16).replace('T', ' ') : '?';
  const where = ctx.forge ? ctx.forge.locationOf(match) : match.file;
  console.log(`RESUME: "${match.project}" - handoff of ${when}${where ? ` (${where})` : ''}`);
  // A worktree path only exists on the machine that made it (2026-10-02: a desktop path resumed on
  // the laptop, found out by a failed cd). Said here, on the line after RESUME, before the body is read.
  if (match.worktree && match.worktree !== 'repo root' && !existsSync(match.worktree)) {
    const here = thisDevice();
    const from = match.device && match.device !== here ? ` The handoff was written on ${match.device}.` : '';
    console.log(`Worktree ${match.worktree} is not on this device (${here}).${from}`);
  }
  if (progress) {
    console.log(`CURRENT PROGRESS (supersedes handoff snapshot)\n${renderProgress(progress)}`);
  }
  console.log(body ?? `(no handoff at ${where ?? 'none'}; the entry's next action is all there is: ${match.next})`);
  console.log(fromBacklog
    ? `Kept on backlog: ${match.project} (current handoff retained)`
    : `Kept: ${match.project} (current handoff retained)`);
  // After-resume hook: <root>/.gtg/after-resume.mjs, the resume-side twin of after-handoff.
  // Replaces the markdown on-resume.md the model used to probe for and read.
  const hook = join(ctx.root, '.gtg', 'after-resume.mjs');
  if (existsSync(hook)) {
    try {
      const mod = await import(pathToFileURL(hook).href);
      if (typeof mod.default !== 'function') throw new Error('no default export function');
      // `kept` is now always true because resume never consumes. `resumed`
      // preserves the old distinction hooks need: normal pickup versus an
      // explicit --keep read that should not run pickup side effects.
      await mod.default({ root: ctx.root, entry: match, file: match.file ?? null, body: body ?? '', kept: true, resumed: !a.keep,
        readStore: ctx.readStore, writeStore: ctx.writeStore, commit: ctx.commit });
    } catch (e) {
      console.error(`gtg: after-resume hook failed - ${firstMeaningfulLine(e)}`);
      process.exitCode = 1;
    }
  }
}
