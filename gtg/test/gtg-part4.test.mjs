// gtg self-check, part 4 of 6 - assert-based, no framework. Runs every command against
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

// --- 39. log reads git, filters by project, and survives a rename ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY });
  gtg(repo, ['rename', 'proj-a', 'alpha', '--no-list']);

  const all = gtg(repo, ['log']);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /gtg rename: proj-a to alpha/);
  assert.match(all.stdout, /Project B/, 'bare log covers every project');

  // Subjects carry the NAME, not the slug, so filtering by the new slug still finds history
  // written under the old one. That is why rename leaves names alone.
  const one = gtg(repo, ['log', 'alpha']);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /Project A/);
  assert.doesNotMatch(one.stdout, /Project B/, 'the filter is per project');

  assert.equal(gtg(repo, ['log', 'nope']).status, 2, 'an unknown project is a usage error');
  const bounded = gtg(repo, ['log', '-n', '1']);
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.equal(bounded.stdout.trim().split('\n').length, 1, '-n bounds the output');
  console.log('ok 39 - log reads git, filters by project, and survives a rename');
}

// --- 40. an inherited Object key is not a verb ---
{
  const repo = tempRepo();
  // These resolved up the prototype chain off the builtins literal, so each called something
  // that is not a verb and reported success instead of reaching the unknown-command error.
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    const r = gtg(repo, [key]);
    assert.equal(r.status, 2, `${key} must be refused, got ${r.status}`);
  }
  console.log('ok 40 - an inherited Object key is not a verb');
}


// --- 41. rename repairs a stale parent reference when nothing carries that slug ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('bali-trip', 'Bali Trip'), { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('bali-shopping', 'Bali Shopping'), '--parent', 'bali-trip-2026'],
    { input: BODY });
  // Simulate what a PORTFOLIO rename leaves behind: entries pointing at a portfolio slug that no
  // longer exists, while no gtg entry carries that slug itself.
  patchActive(repo, (h) => { for (const e of h) if (e.slug === 'bali-trip') e.parent = 'bali-trip-2026'; });

  const r = gtg(repo, ['rename', 'bali-trip-2026', 'bali-trip', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Re-pointed 2 entries from parent 'bali-trip-2026' to 'bali-trip'/);
  const after = active(repo);
  assert.equal(after.filter((e) => e.parent === 'bali-trip-2026').length, 0, 'no dangle left');
  assert.equal(after.filter((e) => e.parent === 'bali-trip').length, 2);
  // The target already existing as a slug is normal here, and must NOT be refused: that is the
  // opposite of what renaming an entry requires.
  assert.equal(after.filter((e) => e.slug === 'bali-trip').length, 1, 'no slug was harmed');
  assert.equal(after.filter((e) => e.slug === 'bali-shopping').length, 1);

  // A slug that is neither an entry nor any parent is still an error.
  const nothing = gtg(repo, ['rename', 'not-a-thing-anywhere', 'whatever']);
  assert.equal(nothing.status, 2);
  assert.match(nothing.stderr, /No project or parent reference matching/);
  console.log('ok 41 - rename repairs a stale parent reference when nothing carries that slug');
}

// --- 42. undo is scoped to the calling session ---
// The 2026-07-14 hazard: session A removes an entry, session B parks something,
// A's undo reverted B's park and left A's entry gone. Two concurrent sessions on
// one checkout is the normal setup here, so this is the default case, not an edge.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY, session: 'sess-A' });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY, session: 'sess-B' });

  // B's handoff is the tip, so A has a change in history but not the latest one.
  const crossA = gtg(repo, ['undo'], { session: 'sess-A' });
  assert.equal(crossA.status, 2, 'undo must refuse when another session committed after ours');
  assert.match(crossA.stderr, /another session changed the store after yours/);
  assert.equal(active(repo).length, 2, 'a refused undo must not touch the stores');

  // A session that never mutated anything has nothing of its own to revert.
  const stranger = gtg(repo, ['undo'], { session: 'sess-C' });
  assert.equal(stranger.status, 2, 'undo must refuse a session with no change of its own');
  assert.match(stranger.stderr, /no change from this session to undo/);
  assert.equal(active(repo).length, 2, 'a refused undo must not touch the stores');

  // No session identity at all: refuse rather than revert a stranger's commit.
  const anon = gtg(repo, ['undo'], { session: null });
  assert.equal(anon.status, 2, 'undo must refuse without a session id');
  assert.match(anon.stderr, /no session id/);
  assert.equal(active(repo).length, 2, 'a refused undo must not touch the stores');

  // B owns the tip, so B's undo is the one that goes through.
  const ownB = gtg(repo, ['undo'], { session: 'sess-B' });
  assert.equal(ownB.status, 0, ownB.stderr);
  const slugs = active(repo).map((e) => e.slug);
  assert.deepEqual(slugs, ['proj-a'], 'B\'s undo must revert B\'s own handoff only');
  console.log('ok 42 - undo is scoped to the calling session');
}

// --- 43. supersede is neither a ship nor an abandonment ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('slice-1', 'Slice One'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('parent-proj', 'Parent Proj'), { input: BODY });

  assert.equal(gtg(repo, ['supersede']).status, 2, 'supersede needs a target');
  assert.equal(gtg(repo, ['supersede', 'slice-1', '--into']).status, 2, '--into needs a value');
  assert.equal(gtg(repo, ['supersede', 'nope']).status, 2, 'an unknown project is a usage error');
  assert.equal(gtg(repo, ['supersede', 'slice-1', '--into', 'slice-1']).status, 2,
    'an entry cannot supersede itself');

  const r = gtg(repo, ['supersede', 'slice-1', '--into', 'parent-proj']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Superseded: Slice One -> Parent Proj/);
  assert.deepEqual(active(repo).map((e) => e.slug), ['parent-proj'], 'entry not removed');

  const subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(subject, 'gtg supersede: Slice One into Parent Proj');

  // The point of the verb: the roll-up must not read as a ship or an abandonment.
  const { classify } = await import('../skills/gtg/extensions/lib/history.mjs');
  const c = classify(subject);
  assert.equal(c.type, 'supersede');
  assert.equal(c.project, 'Slice One');
  assert.equal(c.into, 'Parent Proj');
  assert.equal(classify('gtg supersede: Filed In Error').type, 'supersede');
  assert.equal(classify('gtg supersede: Filed In Error').into, undefined);
  console.log('ok 43 - supersede is neither a ship nor an abandonment');
}

// --- 44. a superseded slug stops counting as abandoned ---
{
  const { classifyEvents, health } = await import('../skills/gtg/extensions/lib/history.mjs');
  const raw = [
    { date: '2026-07-25T12:12:00+08:00', subject: 'gtg supersede: Slice One into Parent Proj' },
    { date: '2026-07-25T12:00:00+08:00', subject: 'gtg backlog: new Slice One — session 1' },
    { date: '2026-07-25T11:00:00+08:00', subject: 'gtg backlog: new Dropped Thing — session 1' },
  ];
  const events = classifyEvents(raw);
  // No rows: both slugs were parked and then left the stores, which is exactly the
  // shape that used to report every consolidated slice as abandoned forever.
  // 2 parked slugs, 1 of them genuinely dropped. Before the fix this read 1.0.
  const { abandonmentRate } = health(events, []);
  assert.equal(abandonmentRate, 0.5, 'only the genuinely dropped slug should count as abandoned');
  console.log('ok 44 - a superseded slug stops counting as abandoned');
}

// --- 45. an entry in a registered extension namespace does not render in `list` ---
// Extensions (learn) own handoff entries and render their own separated
// list, so leaving them in `gtg list` shows the same work twice and buries the
// projects the list exists for. Asserted on the project NAME, which is what the
// renderer prints, not the slug.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('learning-go', 'Learning: Go'), '--parent', 'learning'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('real-project', 'Real Project'), '--parent', 'gtg'], { input: BODY });
  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('Learning: Go'), 'learning sprint leaked into gtg list');
  assert.ok(r.stdout.includes('Real Project'), 'a real project was wrongly excluded');
  // The families the header counts must not include the excluded namespaces either.
  assert.doesNotMatch(r.stdout, /▸ learning/, 'an extension namespace rendered as a family group');
  console.log('ok 45 - an extension namespace does not render in list');
}

// --- 46. the same exclusion applies to `backlog` ---
{
  const repo = tempRepo();
  gtg(repo, ['backlog', '--project', 'Learning P8: y', '--slug', 'learning-p8-y',
    '--next', 'TBD', '--parent', 'learning'], { input: '## The Idea\nsomething\n' });
  gtg(repo, ['backlog', '--project', 'Parked Idea', '--slug', 'parked-idea',
    '--next', 'TBD'], { input: '## The Idea\nsomething\n' });
  const r = gtg(repo, ['backlog']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('Learning P8: y'), 'learning sprint leaked into gtg backlog');
  assert.ok(r.stdout.includes('Parked Idea'), 'a real backlog item was wrongly excluded');
  assert.match(r.stdout, /^1 backlogged project\b/m, 'the shelf count still includes extension entries');
  // b<n> is what `gtg active <n>` resolves, so it has to number the rows shown.
  assert.match(r.stdout, /b1\. Parked Idea/, 'shelf numbering must run 1..N over the rows rendered');
  console.log('ok 46 - the exclusion applies to backlog too');
}

// --- 47. the count in the rendered summary agrees with what was rendered ---
// A banner or header saying 17 while the rows show 12 is the whole defect this
// exclusion exists to prevent.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('learning-p9-x', 'Learning P9: x'), '--parent', 'learning'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('real-project', 'Real Project'), '--parent', 'gtg'], { input: BODY });
  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 active gtg project\b/, 'the count still includes extension entries');
  console.log('ok 47 - the rendered count agrees with the rendered rows');
}

// --- 48. extension entries stay addressable by slug for explicit shelving ---
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('learning-p9-x', 'Learning P9: x'), '--parent', 'learning'], { input: BODY });
  const r = gtg(repo, ['back', 'learning-p9-x', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  const bl = backlog(repo);
  assert.ok(bl.some((e) => e.slug === 'learning-p9-x'),
    'the extension entry was not explicitly shelved by slug');
  assert.equal(active(repo).length, 0, 'the shelved entry is gone from active');
  console.log('ok 48 - explicit shelving reaches extension entries');
}

// --- 49. ctx.ownEntries hands an extension both its shelves, and only its own ---
// The interface the learn extension reads its own entries through. A user extension
// overrides it here so this tests the ctx rather than the extension's output.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('learning-p9-x', 'Learning P9: x'), '--parent', 'learning'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('real-project', 'Real Project'), '--parent', 'gtg'], { input: BODY });
  gtg(repo, ['backlog', '--project', 'Learning P8: y', '--slug', 'learning-p8-y',
    '--next', 'TBD', '--parent', 'learning'], { input: '## The Idea\nsomething\n' });
  gtg(repo, ['backlog', '--project', 'Parked Idea', '--slug', 'parked-idea',
    '--next', 'TBD'], { input: '## The Idea\nsomething\n' });
  const probe = 'export default async ({ ownEntries }) => {\n'
    + '  const { active, shelved } = ownEntries();\n'
    + '  console.log(JSON.stringify({ active: active.map((e) => e.slug), shelved: shelved.map((e) => e.slug) }));\n'
    + '};\n';
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg/commands/learn.mjs'), probe);
  const r = gtg(repo, ['learn']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { active: ['learning-p9-x'], shelved: ['learning-p8-y'] },
    'ownEntries must return only the calling command\'s namespace, from BOTH stores');
  // A command that owns no namespace gets two empty arrays, never undefined.
  writeFileSync(join(repo, '.gtg/commands/nomad.mjs'), probe);
  const r2 = gtg(repo, ['nomad']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout.trim()), { active: [], shelved: [] },
    'a command that owns no namespace must get empty arrays');
  console.log('ok 49 - ctx.ownEntries returns the calling extension\'s own entries');
}

// --- 50. an explicit query finds an extension entry, the bare listing still hides it ---
// Decluttering is not lookup. SKILL.md's exit procedure probes with `list <candidate>` before
// slugifying and reuses the matched entry's slug, so a blind probe would mint a SECOND entry
// beside a live issue package rather than updating it in place. The bare listing must still
// hide them, and the row numbers on a queried listing must keep meaning the same rows that
// `gtg back <n>` resolves, which is why a queried extension entry carries its slug instead of
// a number it has no claim to.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('alpha-widget', 'Alpha Widget'), '--parent', 'gtg'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('beta-widget', 'Beta Widget'), '--parent', 'gtg'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('learning-p9-widget', 'Learning P9: widget'), '--parent', 'learning'],
    { input: BODY });

  // Exact slug, the form the reuse probe and every other verb use.
  const rs = gtg(repo, ['list', 'learning-p9-widget']);
  assert.equal(rs.status, 0, rs.stderr);
  assert.ok(rs.stdout.includes('Learning P9: widget'),
    'an exact-slug query must find an extension entry');
  assert.match(rs.stdout, /1 active gtg project\b.*matching 'learning-p9-widget'/,
    'a queried extension entry must be counted in the header it appears under');

  // Fuzzy project name, the form the exit procedure actually probes with.
  const rn = gtg(repo, ['list', 'Learning P9']);
  assert.equal(rn.status, 0, rn.stderr);
  assert.ok(rn.stdout.includes('Learning P9: widget'),
    'a project-name query must find an extension entry');

  // A query matching both kinds: real entries keep their canonical numbers, the extension
  // entry is labelled by slug because it has no position in the list those numbers index.
  const rq = gtg(repo, ['list', 'widget']);
  assert.equal(rq.status, 0, rq.stderr);
  assert.match(rq.stdout, /1\. Alpha Widget/, 'a queried real entry keeps its canonical number');
  assert.match(rq.stdout, /2\. Beta Widget/, 'a queried real entry keeps its canonical number');
  assert.match(rq.stdout, /learning-p9-widget: Learning P9: widget/,
    'a queried extension entry must be labelled by slug');
  assert.doesNotMatch(rq.stdout, /\d+\. Learning P9: widget/,
    'a queried extension entry must NOT carry a row number, it would address a different row');

  // The bare listing is unchanged: still hidden, still numbered the same way.
  const rb = gtg(repo, ['list']);
  assert.equal(rb.status, 0, rb.stderr);
  assert.ok(!rb.stdout.includes('Learning P9: widget'), 'the bare listing must still hide it');
  assert.match(rb.stdout, /1\. Alpha Widget/, 'bare and queried numbering must agree');
  assert.match(rb.stdout, /2\. Beta Widget/, 'bare and queried numbering must agree');

  // The consistency that matters: `<n>` resolves to the row the listing numbered <n>.
  const rback = gtg(repo, ['back', '2', '--no-list']);
  assert.equal(rback.status, 0, rback.stderr);
  assert.match(rback.stdout, /Parked: Beta Widget/,
    'back <n> must target the row both listings numbered <n>');

  // And an extension entry stays reachable by slug, which is what its label tells you to use.
  const rbe = gtg(repo, ['back', 'learning-p9-widget', '--no-list']);
  assert.equal(rbe.status, 0, rbe.stderr);
  assert.match(rbe.stdout, /Parked: Learning P9: widget/,
    'an extension entry must stay reachable by slug');
  // The hint on that same line must name something that resolves. sortByProject is filtered, so
  // indexOf is -1 and the number would be a 0 that `gtg active` cannot resolve.
  assert.match(rbe.stdout, /Bring back: gtg active learning-p9-widget/,
    'the bring-back hint must name the slug, not the 0 the filtered order yields');
  assert.doesNotMatch(rbe.stdout, /gtg active 0\b/, 'a 0 hint is not a resolvable target');
  console.log('ok 50 - an explicit query finds an extension entry, the bare listing hides it');
}

// --- 51. a targeted query reaches a SHELVED extension entry ---
// Explicit shelving can park an issue package between fix sessions, and `backlog` hides
// extension entries. So without this, the moment a
// package is shelved no builtin listing shows it, `list <candidate>` goes blind again, and a
// departure mints the duplicate case 50 exists to prevent.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('learning-p9-shelved', 'Learning P9: shelved'), '--parent', 'learning'],
    { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('real-shelved', 'Real Shelved'), '--parent', 'gtg'], { input: BODY });
  assert.equal(gtg(repo, ['back', 'learning-p9-shelved', '--no-list']).status, 0);
  assert.equal(gtg(repo, ['back', 'real-shelved', '--no-list']).status, 0);
  const bl = backlog(repo);
  assert.equal(bl.length, 2, 'setup: both entries must be on the shelf');            // GUARD
  assert.equal(active(repo).length, 0, 'setup: nothing left active');       // GUARD

  // The "No active gtg projects matching '<filter>'" line echoes the query back, so each
  // assertion below deliberately looks for the OTHER identifier: querying by slug asserts on the
  // project name, querying by name asserts on the slug. Asserting on the echoed one would pass
  // with no fix at all.
  // FAIL-PRE-FIX: exact slug, the form the reuse probe uses.
  const rs = gtg(repo, ['list', 'learning-p9-shelved']);
  assert.equal(rs.status, 0, rs.stderr);
  assert.ok(rs.stdout.includes('Learning P9: shelved'),
    'a targeted query must reach a shelved extension entry');
  assert.match(rs.stdout, /gtg active learning-p9-shelved/,
    'the shelved line must name the command that brings it back');
  // FAIL-PRE-FIX: fuzzy project name, the form the exit procedure probes with.
  const rn = gtg(repo, ['list', 'Learning P9']);
  assert.equal(rn.status, 0, rn.stderr);
  assert.ok(rn.stdout.includes('learning-p9-shelved'),
    'a project-name query must reach a shelved extension entry');

  // GUARD: the bare listing is still the decluttered view and says nothing is active.
  const rb = gtg(repo, ['list']);
  assert.match(rb.stdout, /No active gtg projects/, 'the bare listing must not gain shelved rows');
  assert.ok(!rb.stdout.includes('learning-p9-shelved'), 'the bare listing must not name it');

  // GUARD, and the scope boundary: a shelved NORMAL project is still invisible to a query. That
  // hole predates the extension model and widening it is a documented-behaviour change.
  const rr = gtg(repo, ['list', 'Real Shelved']);
  assert.ok(!rr.stdout.includes('real-shelved'),
    'the generic shelved-project case is deliberately unchanged');

  // The co-occurrence case, and the one that was missing: a query matching ACTIVE work AND a
  // shelved extension entry. printShelved was called only on the `!shown.length` branch, so any
  // query that also hit active work silently dropped the shelved entry, which is exactly when
  // SKILL.md's "reuse the slug if EXACTLY ONE matches" rule does damage: two matches look like
  // one, and it is the wrong one. Live example: `gtg list Issues` matched an active package plus
  // two shelved ones and printed only the active rows.
  gtg(repo, [...HANDOFF_ARGS('learning-tracker-rewrite', 'Learning Tracker Rewrite'), '--parent', 'gtg'],
    { input: BODY });
  const rc = gtg(repo, ['list', 'Learning']);
  assert.equal(rc.status, 0, rc.stderr);
  // GUARD: the active match still renders as a numbered row on the normal path.
  assert.match(rc.stdout, /1\. Learning Tracker Rewrite/,
    'the active match must still render as a numbered row');
  // FAIL-PRE-FIX: the shelved hit must survive a query that also matched active work.
  assert.ok(rc.stdout.includes('Learning P9: shelved'),
    'a shelved extension entry was dropped because the query also matched active work');
  assert.match(rc.stdout, /gtg active learning-p9-shelved/,
    'the shelved line must still name its bring-back command on the non-empty path');

  // GUARD: `activate` resolves by slug and always did, so this only pins that the command the
  // shelved line advertises is a real one.
  const ra = gtg(repo, ['active', 'learning-p9-shelved', '--no-list']);
  assert.equal(ra.status, 0, ra.stderr);
  assert.match(ra.stdout, /Activated: Learning P9: shelved/);
  console.log('ok 51 - a targeted query reaches a shelved extension entry');
}

// --- 52. the hints back and active print are runnable for an extension entry ---
// Not a cosmetic bug: the README now tells you to address an extension entry by slug, so this is
// the documented flow. Before the fix `back <slug>` printed 'gtg active 0', and running it exits
// 2 because resolveEntry indexes arr[-1]. The test executes whatever the hint printed rather than
// asserting a shape, so it cannot pass while the advice is unrunnable.
{
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('learning-p9-round', 'Learning P9: round'), '--parent', 'learning'],
    { input: BODY });

  const rb = gtg(repo, ['back', 'learning-p9-round', '--no-list']);
  assert.equal(rb.status, 0, rb.stderr);
  const backHint = /Bring back: gtg (\S+ \S+)/.exec(rb.stdout);
  assert.ok(backHint, 'back must print a bring-back hint');                          // GUARD
  // FAIL-PRE-FIX: pre-fix this runs `gtg active 0` and exits 2.
  const ra = gtg(repo, [...backHint[1].split(' '), '--no-list']);
  assert.equal(ra.status, 0, `the printed hint 'gtg ${backHint[1]}' failed: ${ra.stderr}`);
  assert.match(ra.stdout, /Activated: Learning P9: round/);

  const activeHint = /Shelve again: gtg (\S+ \S+)/.exec(ra.stdout);
  assert.ok(activeHint, 'active must print a shelve-again hint');                    // GUARD
  // FAIL-PRE-FIX: the mirror-image bug in activate(), 'gtg back 0'.
  const rb2 = gtg(repo, [...activeHint[1].split(' '), '--no-list']);
  assert.equal(rb2.status, 0, `the printed hint 'gtg ${activeHint[1]}' failed: ${rb2.stderr}`);
  assert.match(rb2.stdout, /Parked: Learning P9: round/);
  console.log('ok 52 - the hints back and active print are runnable for an extension entry');
}

// --- 53. the two stores partition: one slug never sits in both ---
// writeHandoff used to dedupe against only the store it was writing, so a handoff for a
// shelved slug appended an active entry and left the backlog copy behind. The two stores
// drive different renderers, so the same project then read as active or shelved depending on
// which command ran. Both directions, because `backlog` writes through the same function.
{
  const repo = tempRepo();
  const backlogOf = (r) => backlog(r);
  const slugs = (xs) => (xs ?? []).map((e) => e.slug);

  gtg(repo, ['backlog', '--project', 'Thing', '--slug', 'thing', '--next', 'TBD'], { input: BODY });
  gtg(repo, HANDOFF_ARGS('thing', 'Thing'), { input: BODY });
  assert.deepEqual(slugs(active(repo)), ['thing'], 'handoff did not unpark the shelved slug');
  assert.deepEqual(slugs(backlogOf(repo)), [], 'the backlog copy survived a handoff for the same slug');

  gtg(repo, ['backlog', '--project', 'Thing', '--slug', 'thing', '--next', 'TBD'], { input: BODY });
  assert.deepEqual(slugs(backlogOf(repo)), ['thing'], 'parking did not land on the backlog');
  assert.deepEqual(slugs(active(repo)), [], 'the active copy survived a park of the same slug');

  const st = execSync('git status --porcelain', { cwd: repo, encoding: 'utf8' });
  assert.equal(st.trim(), '', `the unpark left the tree dirty:\n${st}`);
  console.log('ok 53 - a slug lives in exactly one store, both directions, and the unpark is committed');
}

console.log('ALL PASS (part 4)');
