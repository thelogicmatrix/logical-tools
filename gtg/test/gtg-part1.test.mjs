// gtg self-check, part 1 of 6 - assert-based, no framework. Runs every command against
// throwaway temp git repos. Non-zero exit on any failure. One file was ~97 s on its own, so the
// cases are split across gtg-part1..6.test.mjs, which the runner runs side by side (#128).
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readCollection, writeCollection } from '../skills/gtg/lib/store.mjs';
import { CLI, SHIM, ageFetchHead, tempRepo, tempRepoNoIdentity, gtg, HANDOFF_ARGS, BODY, ACTIVE, BACKLOG, active, backlog, PACKED_ACTIVE, PACKED_BACKLOG, seedActive, nameStatus, patchActive } from './gtg-harness.mjs';

// --- 1. handoff writes doc + an active record, commits ---
{
  const repo = tempRepo();
  const r = gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  assert.equal(r.status, 0, `handoff failed: ${r.stderr}`);
  const rel = r.stdout.split('\n')[0].trim();
  assert.equal(rel, 'docs/handoffs/current/proj-a.md');
  assert.ok(existsSync(join(repo, rel)), 'handoff doc missing');
  const doc = readFileSync(join(repo, rel), 'utf8');
  assert.match(doc, /^# Handoff: Project A/);
  assert.match(doc, /## Resume Prompt\nSay: "gtg proj-a"/);
  const entries = active(repo);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].slug, 'proj-a');
  assert.equal(entries[0].file, rel);
  const subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^handoff: Project A/);
  // dedupe by slug: second handoff for same slug replaces, not appends
  const r2 = gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(active(repo).length, 1, 'dedupe by slug failed');
  console.log('ok 1 - handoff');
}

// --- 1b. backlog park lands on the backlog store ---
{
  const repo = tempRepo();
  const r = gtg(repo, ['backlog', '--project', 'Idea X', '--slug', 'idea-x',
    '--eta', '~1h', '--next', 'TBD'], { input: '## The Idea\nsomething\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PARKED on backlog/);
  const bl = backlog(repo);
  assert.equal(bl.length, 1);
  assert.equal(bl[0].slug, 'idea-x');
  assert.ok(!existsSync(join(repo, ACTIVE)), 'backlog park must not touch the active store');
  console.log('ok 1b - backlog park');
}

// --- 5. GTG_HUB override: handoff lands in the hub, not the cwd repo ---
{
  const hub = tempRepo();
  const other = tempRepo();
  const r = gtg(other, HANDOFF_ARGS('hub-proj', 'Hub Project'), { input: BODY, hub });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(active(hub).map((e) => e.slug), ['hub-proj'], 'entry not in hub');
  assert.ok(!existsSync(join(other, 'docs/handoffs')), 'entry leaked into cwd repo');
  const subject = execSync('git log -1 --format=%s', { cwd: hub, encoding: 'utf8' }).trim();
  assert.match(subject, /^handoff: Hub Project/, 'commit not in hub repo');
  console.log('ok 5 - GTG_HUB');
}

// --- error cases: no repo + no hub; missing flags; empty body ---
{
  const bare = mkdtempSync(join(tmpdir(), 'gtg-bare-'));
  const r = gtg(bare, ['list']);
  assert.equal(r.status, 2, 'expected exit 2 outside a repo without GTG_HUB');
  assert.match(r.stderr, /GTG_HUB/);
  const repo = tempRepo();
  const r2 = gtg(repo, ['handoff', '--project', 'X'], { input: BODY });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /missing --/);
  const r3 = gtg(repo, HANDOFF_ARGS('x', 'X'), { input: '' });
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /empty body/);
  // slug must not traverse paths or inject shell - rejected before any write
  // '_lead' and '.lead' are here because the store's SLUG_OK demands an alphanumeric first
  // character and this check has to be at least as strict, or the .md lands and the store throws.
  for (const bad of ['../evil', 'a/b', 'a;rm -rf', 'a b', '_lead', '.lead']) {
    const rb = gtg(repo, HANDOFF_ARGS(bad, 'X'), { input: BODY });
    assert.equal(rb.status, 2, `bad slug '${bad}' should exit 2`);
    assert.match(rb.stderr, /--slug must start with a letter or digit/);
  }
  console.log('ok - error cases');
}

// --- 2. list shows entries; list <project> filters ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY });
  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 active gtg projects/);
  assert.match(r.stdout, /Project A/);
  assert.match(r.stdout, /Project B/);
  const rf = gtg(repo, ['list', 'proj-a']);
  assert.match(rf.stdout, /Project A/);
  assert.doesNotMatch(rf.stdout, /Project B/, 'filter leaked other project');
  console.log('ok 2 - list + filter');
}

// --- 2b. stale active work stays active until explicitly shelved ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('stale-proj', 'Stale Project'), { input: BODY });
  // Backdate the entry 8 days
  patchActive(repo, (h) => { h[0].updated = new Date(Date.now() - 8 * 86400000).toISOString(); });
  const r = gtg(repo, ['list']);
  assert.doesNotMatch(r.stdout, /Auto-shelved|shelves in/);
  assert.match(r.stdout, /Stale Project/);
  assert.equal(backlog(repo).length, 0);
  assert.equal(active(repo).length, 1);
  const parked = gtg(repo, ['back', 'stale-proj', '--no-list']);
  assert.equal(parked.status, 0, parked.stderr);
  const bl = backlog(repo);
  assert.equal(bl[0].slug, 'stale-proj');
  const rb = gtg(repo, ['backlog']);
  assert.match(rb.stdout, /b1\. Stale Project/);
  console.log('ok 2b - stale work needs explicit shelving');
}

// --- 2c. list numbering matches resolveEntry's full-list order (not filtered subset) ---
// resolveEntry (used by remove/back/active) resolves a numeric "<n>" against the
// FULL sorted active list - so `list <filter>` must number entries by their
// position in that full list, not by their index within the filtered subset.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('bravo', 'Bravo'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('charlie', 'Charlie'), { input: BODY });
  const r = gtg(repo, ['list', 'bravo']);
  assert.equal(r.status, 0, r.stderr);
  // Full sorted order is Alpha, Bravo, Charlie - Bravo is position 2, even though
  // it's the only entry shown here. Numbering by filtered-subset index would wrongly show "1.".
  assert.match(r.stdout, /^\s*2\. Bravo/m, 'list <filter> must number by full sorted-list position, not filtered index');
  console.log('ok 2c - list numbering matches resolve order');
}

// --- 3. commit() failure discrimination: a genuine (non-"nothing to commit") git
// failure must exit NON-ZERO while still reporting the write that did happen.
//
// This assertion was inverted on 2026-08-18. It previously required exit 0, reasoning
// that the files are written regardless so the verb succeeded. The 2026-08-11 incident
// in docs/issues/2026-08-11-verb-commit-failure-exits-zero.md is the counter-evidence:
// a 39-call `projects set` backfill hit a stale .git/index.lock, and because every call
// warned on stderr and exited 0, the batch ran to completion and ended with 14 rows
// changed-but-uncommitted plus files left staged and ownerless in the shared home
// checkout, which blocks every other session's merges. A caller checking $? could not
// see it. Exit 0 on a partial success is what made the batch undetectable, so the exit
// code now reports the commit while stdout still reports the write - the four
// assertions below are unchanged from the original test.
{
  const repo = tempRepoNoIdentity();
  const noConfig = join(tmpdir(), `gtg-no-such-gitconfig-${process.pid}-${Date.now()}`);
  const r = gtg(repo, HANDOFF_ARGS('proj-c', 'Project C'), {
    input: BODY,
    env: { GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_SYSTEM: noConfig, GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.notEqual(r.status, 0, `a genuine git commit failure must exit non-zero so a batch caller can detect it: ${r.stderr}`);
  assert.match(r.stdout, /^docs\/handoffs\/current\/proj-c\.md$/m, 'handoff success output missing from stdout');
  assert.match(r.stdout, /RESUME: "gtg proj-c"/);
  assert.match(r.stderr, /uncommitted/i, 'genuine git commit failure must be surfaced as a warning, not swallowed');
  // The cause line, via firstMeaningfulLine: never blank (an empty stderr Buffer is TRUTHY and
  // used to shadow e.message, printing a bare dash) and never git's own CRLF warning or the first
  // of nine `hint:` lines, which is what a naive split('\n')[0] hands you on a Windows checkout.
  assert.match(r.stderr, /git commit failed[^\n]*- (?!(?:warning|hint):)\S/,
    `the failure line must name the cause, not advice or nothing at all: ${r.stderr}`);
  assert.equal(active(repo).length, 1, 'entry should still be written to disk despite commit failure');
  console.log('ok 3 - commit failure exits non-zero, write still reported');
}

// --- 3+4. remove empties the active store; undo restores it ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  const r = gtg(repo, ['remove', 'proj-a']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Removed: Project A/);
  assert.equal(active(repo).length, 0, 'remove left entries behind');
  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  assert.equal(active(repo).length, 1, 'undo did not restore');
  assert.equal(active(repo)[0].slug, 'proj-a');
  console.log('ok 3+4 - remove + undo');
}

// --- 4b. back shelves, active reactivates, remove falls through to backlog ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  const rb = gtg(repo, ['back', 'proj-a']);
  assert.match(rb.stdout, /Parked: Project A/);
  assert.equal(active(repo).length, 0);
  const bl = () => backlog(repo);
  assert.equal(bl().length, 1);
  const ra = gtg(repo, ['active', 'b1']);
  assert.match(ra.stdout, /Activated: Project A/);
  assert.equal(active(repo).length, 1);
  assert.equal(bl().length, 0);
  // remove falls through to backlog when not in active
  gtg(repo, ['back', 'proj-a']);
  const rr = gtg(repo, ['remove', 'proj-a']);
  assert.match(rr.stdout, /Removed from backlog: Project A/);
  assert.equal(bl().length, 0);
  console.log('ok 4b - back/active/backlog-remove');
}

// --- Finding C1: shell injection via unvalidated --project must not execute ---
// commit() used to interpolate the commit message (built from --project/--phase) into
// a shell string run via execSync (POSIX: /bin/sh -c). Only --slug was validated.
// NOTE (platform caveat): this proves the fix on POSIX (sh interprets $(...)). On
// Windows, execSync's default shell is cmd.exe, which does NOT interpret $(...), so
// this assertion could pass even against the old vulnerable code when run on Windows.
// Kept anyway as the correct regression guard for POSIX/CI.
{
  const repo = tempRepo();
  const marker = join(repo, 'INJECTED_MARKER');
  const evilProject = 'Pwn$(touch INJECTED_MARKER)Name';
  const r = gtg(repo, HANDOFF_ARGS('inject-test', evilProject), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(marker), 'shell injection via --project executed a command');
  assert.equal(active(repo)[0].project, evilProject,
    'stored project must be the literal string including $(...), untouched');
  console.log('ok - Finding C1: shell injection via --project neutralized');
}

// --- Finding I1: undo must restore BOTH stores, not leave the entry duplicated ---
// back/active commit both stores together in one commit. undo used to restore
// only the active side from the pre-commit parent, leaving the moved entry ALSO present on
// the backlog.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-i1', 'Project I1'), { input: BODY });
  gtg(repo, ['back', 'proj-i1']);
  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  const inActive = active(repo).some((e) => e.slug === 'proj-i1');
  const inBacklog = backlog(repo).some((e) => e.slug === 'proj-i1');
  assert.ok(inActive, 'undo should restore the entry to active');
  assert.ok(!inBacklog, 'undo left the entry duplicated in backlog too');
  console.log('ok - Finding I1: undo restores both stores after back');
}

// --- Finding 1: unresolvable target must exit non-zero and print to stderr ---
{
  const repo = tempRepo();
  const r1 = gtg(repo, ['remove', 'no-such-slug']);
  assert.notEqual(r1.status, 0, 'remove of unknown slug should exit non-zero');
  assert.ok(r1.stderr.length > 0, 'remove of unknown slug should print to stderr');
  const r2 = gtg(repo, ['back', '99']);
  assert.notEqual(r2.status, 0, 'back of out-of-range number should exit non-zero');
  assert.ok(r2.stderr.length > 0, 'back of out-of-range number should print to stderr');
  console.log('ok - Finding 1: unresolvable target exits non-zero');
}

// --- Finding 2: back/active success-message hint must point at the moved entry's
// sorted position in the destination list, not the raw post-push array length ---
{
  const repo = tempRepo();
  // back: shelve Zebra first (backlog = [Zebra]), then shelve Apple.
  // Sorted backlog = [Apple, Zebra] - Apple's hint must be 1, not length (2).
  gtg(repo, HANDOFF_ARGS('zebra', 'Zebra'), { input: BODY });
  gtg(repo, ['back', 'zebra']);
  gtg(repo, HANDOFF_ARGS('apple', 'Apple'), { input: BODY });
  const rb = gtg(repo, ['back', 'apple']);
  assert.equal(rb.status, 0, rb.stderr);
  assert.match(rb.stdout, /Bring back: gtg active 1(?!\d)/, 'back hint must use sorted position (Apple=1), not raw length');
  console.log('ok - Finding 2a: back hint uses sorted position');
}
{
  const repo = tempRepo();
  // active: Zebra stays active, Apple parked straight to backlog, then activated.
  // Sorted active after move = [Apple, Zebra] - Apple's hint must be 1, not length (2).
  gtg(repo, HANDOFF_ARGS('zebra', 'Zebra'), { input: BODY });
  gtg(repo, ['backlog', '--project', 'Apple', '--slug', 'apple',
    '--eta', '~2h', '--next', 'do the next thing'], { input: BODY });
  const ra = gtg(repo, ['active', 'apple']);
  assert.equal(ra.status, 0, ra.stderr);
  assert.match(ra.stdout, /Shelve again: gtg back 1(?!\d)/, 'active hint must use sorted position (Apple=1), not raw length');
  console.log('ok - Finding 2b: active hint uses sorted position');
}

// --- Finding 3: undo of stale work restores it active with exactly one commit ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('stale-undo', 'Stale Undo'), { input: BODY });
  patchActive(repo, (h) => { h[0].updated = new Date(Date.now() - 8 * 86400000).toISOString(); });
  execSync('git add -A && git commit -q -m "backdate for test"', { cwd: repo, stdio: 'ignore' });
  gtg(repo, ['remove', 'stale-undo']);
  const commitsBeforeUndo = execSync('git rev-list --count HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  assert.equal(active(repo).length, 1, 'undo did not restore the stale entry to active');
  assert.equal(active(repo)[0].slug, 'stale-undo');
  assert.equal(backlog(repo).length, 0, 'undo must not re-park the stale entry to backlog');
  const commitsAfterUndo = execSync('git rev-list --count HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(Number(commitsAfterUndo), Number(commitsBeforeUndo) + 1, 'undo must create exactly one commit');
  console.log('ok - Finding 3: undo restores stale work without implicit shelving');
}

// --- 6. extension dispatch + ctx contract ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/ping.mjs'),
    `export default (ctx) => console.log(JSON.stringify({
      hasRoot: !!ctx.root,
      hasArgs: Array.isArray(ctx.args),
      hasReadStore: typeof ctx.readStore === 'function',
      hasWriteStore: typeof ctx.writeStore === 'function',
      hasCommit: typeof ctx.commit === 'function',
      argsThrough: ctx.args.join(','),
    }))\n`);
  const r = gtg(repo, ['ping', 'a', 'b']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  for (const k of ['hasRoot', 'hasArgs', 'hasReadStore', 'hasWriteStore', 'hasCommit']) {
    assert.equal(out[k], true, `ctx contract broken: ${k}`);
  }
  assert.equal(out.argsThrough, 'a,b');
  // built-ins win: an extension named list.mjs must NOT be dispatched
  writeFileSync(join(repo, '.gtg/commands/list.mjs'), `export default () => console.log('EXTENSION-LIST')\n`);
  const rl = gtg(repo, ['list']);
  assert.doesNotMatch(rl.stdout, /EXTENSION-LIST/, 'extension shadowed a builtin');
  // unknown command with no extension file still errors
  const rx = gtg(repo, ['nonesuch']);
  assert.equal(rx.status, 2);
  assert.match(rx.stderr, /unknown command/);
  // #111: the bundled issues extension is gone, so `gtg issues` is an unknown command too.
  const ri = gtg(repo, ['issues']);
  assert.equal(ri.status, 2, ri.stderr);
  assert.match(ri.stderr, /^gtg: unknown command 'issues' - try 'gtg help'/);
  console.log('ok 6 - extension dispatch + ctx contract');
}

// --- Finding T5-1: unknown <cmd> must not traverse paths outside .gtg/commands ---
// `gtg ../evil` builds join(ROOT, '.gtg', 'commands', '../evil.mjs') which path.join
// normalizes to ROOT/.gtg/evil.mjs - outside the commands dir. Unvalidated, this would
// import and execute that file. cmd must be constrained the same way --slug is.
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/evil.mjs'), `export default () => console.log('EVIL-MARKER')\n`);
  const r = gtg(repo, ['../evil']);
  assert.doesNotMatch(r.stdout, /EVIL-MARKER/, 'path traversal executed a file outside .gtg/commands');
  assert.equal(r.status, 2, 'traversal attempt should fall through to the unknown-command exit 2');
  assert.match(r.stderr, /unknown command/);
  console.log('ok - Finding T5-1: cmd path traversal rejected');
}

// --- Finding T5-2: extension import/invoke failures must fail cleanly, not crash raw ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/boom.mjs'), `throw new Error('kaboom')\n`);
  const r = gtg(repo, ['boom']);
  assert.equal(r.status, 1, 'extension throw should exit 1 (controlled), not crash uncontrolled');
  assert.match(r.stderr, /extension 'boom' failed/);
  assert.match(r.stderr, /kaboom/);
  assert.doesNotMatch(r.stderr, /at Object|node:internal|Unhandled/, 'raw node stack/unhandled-rejection dump leaked');
  console.log('ok - Finding T5-2a: extension import throw handled cleanly');
}
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/nodefault.mjs'), `export const x = 1;\n`);
  const r = gtg(repo, ['nodefault']);
  assert.equal(r.status, 1, 'missing default export should exit 1 cleanly');
  assert.match(r.stderr, /extension 'nodefault' failed/);
  assert.doesNotMatch(r.stderr, /TypeError/, 'raw TypeError leaked instead of the clean message');
  console.log('ok - Finding T5-2b: extension missing default export handled cleanly');
}

// --- 7. bundled command dispatches with NO user .gtg present ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  const r = gtg(repo, ['stats']);
  assert.equal(r.status, 0, `bundled stats failed: ${r.stderr}`);
  assert.match(r.stdout, /1 active/);
  // Task 6 rewrote stats.mjs on top of buildReport() (history.mjs); the old
  // "sessions: N total · deepest: X (Y)" line is gone. Assert the counts line
  // plus the new session-depth line ("N sessions · deepest: X (Y)"), not the
  // exact total (perProject can split a row when --slug diverges from
  // slugify(project) - a pre-existing Tasks 1-5 quirk, out of scope here).
  const sessLine = r.stdout.match(/(\d+) sessions · deepest: (.+?) \((\d+)\)/);
  assert.ok(sessLine, `session-depth line missing/malformed in stats output: ${r.stdout}`);
  assert.equal(sessLine[2], 'Project A');
  assert.doesNotMatch(r.stdout, /history unavailable/, 'a repo with commits reads its history');
  console.log('ok 7 - bundled stats dispatch');
}

// --- 7b. stats on an empty/absent store prints zeros, never throws ---
{
  const repo = tempRepo();
  const r = gtg(repo, ['stats']);
  assert.equal(r.status, 0, `stats on empty store failed: ${r.stderr}`);
  assert.match(r.stdout, /0 active/);
  assert.match(r.stdout, /0 backlog/);
  console.log('ok 7b - stats empty store');
}

// --- 7b2. #100: stats names missing git history instead of printing a quietly partial
// summary. The hub is a plain dir (GTG_HUB), so `git log` fails there. ---
{
  const hub = mkdtempSync(join(tmpdir(), 'gtg-nohist-'));
  writeCollection(hub, 'docs/handoffs/active', [{ project: 'Solo', slug: 'solo', next: 'x', updated: new Date().toISOString(), sessions: 1 }]);
  const r = gtg(hub, ['stats'], { hub });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^1 active, 0 backlog\nhistory unavailable: /, `no notice under the counts:\n${r.stdout}`);
  console.log('ok 7b2 - #100: stats says when git history is unavailable');
}

// --- 7c. user .gtg/commands/<verb> OVERRIDES a bundled command of the same name ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/stats.mjs'),
    `export default () => console.log('USER-STATS-OVERRIDE')\n`);
  const r = gtg(repo, ['stats']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /USER-STATS-OVERRIDE/, 'user command did not override bundled');
  console.log('ok 7c - user overrides bundled');
}

// --- 7d. update-safety: a user command survives an unrelated bundled command existing ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/mine.mjs'),
    `export default (ctx) => console.log('MINE:' + (typeof ctx.readStore))\n`);
  const r = gtg(repo, ['mine']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MINE:function/, 'user command lost its ctx');
  console.log('ok 7d - user command intact alongside bundled command');
}

// --- 8. resume retains active and backlog entries without a bookkeeping commit ---
{
  const repo = tempRepo();
  let r = gtg(repo, HANDOFF_ARGS('proj-r', 'Project R'), { input: BODY });
  assert.equal(r.status, 0, `handoff failed: ${r.stderr}`);

  r = gtg(repo, ['resume', 'proj-r']);
  assert.equal(r.status, 0, `resume failed: ${r.stderr}`);
  assert.equal(active(repo).length, 1, 'resume must retain the current entry');

  const subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^handoff: Project R - session 1$/,
    `resume must not create a bookkeeping commit, got: ${subject}`);

  // falls back to the backlog when the slug is not active
  r = gtg(repo, ['backlog', '--project', 'Idea Z', '--slug', 'idea-z',
    '--next', 'TBD'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  r = gtg(repo, ['resume', 'idea-z']);
  assert.equal(r.status, 0, `backlog resume failed: ${r.stderr}`);
  const blSubject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(blSubject, /^gtg backlog: new Idea Z - session 1$/);
  assert.equal(backlog(repo).length, 1, 'resume must retain explicitly shelved work');

  // no match exits 2
  r = gtg(repo, ['resume', 'nope']);
  assert.equal(r.status, 2, 'resume on a missing slug should exit 2');

  console.log('ok 8 - resume retains active and backlog work without mutation');
}

console.log('ALL PASS (part 1)');
