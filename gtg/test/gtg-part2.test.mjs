// gtg self-check, part 2 of 6 - assert-based, no framework. Runs every command against
// throwaway temp git repos. Non-zero exit on any failure. One file was ~97 s on its own, so the
// cases are split across gtg-part1..6.test.mjs, which the runner runs side by side (#128).
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, symlinkSync, mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readCollection, writeCollection } from '../skills/gtg/lib/store.mjs';
import { CLI, SHIM, ageFetchHead, tempRepo, tempRepoNoIdentity, gtg, HANDOFF_ARGS, BODY, ACTIVE, BACKLOG, active, backlog, PACKED_ACTIVE, PACKED_BACKLOG, seedActive, nameStatus, patchActive } from './gtg-harness.mjs';

// --- 9. phase is gone; sessions counts up; created is stable ---
{
  const repo = tempRepo();
  let r = gtg(repo, HANDOFF_ARGS('proj-s', 'Project S'), { input: BODY });
  assert.equal(r.status, 0, `handoff failed: ${r.stderr}`);

  let e = active(repo)[0];
  assert.equal(e.sessions, 1, 'first handoff should be session 1');
  assert.ok(!('phase' in e), 'phase must not be written');
  assert.match(e.created, /^\d{4}-\d{2}-\d{2}T/, 'created must be an ISO stamp');
  const firstCreated = e.created;

  const doc = readFileSync(join(repo, e.file), 'utf8');
  assert.ok(!/^Phase:/m.test(doc), 'handoff doc must not carry a Phase: line');

  let subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^handoff: Project S - session 1$/, `got: ${subject}`);

  // second handoff for the same slug: sessions increments, created is carried
  r = gtg(repo, HANDOFF_ARGS('proj-s', 'Project S'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo)[0];
  assert.equal(e.sessions, 2, 'second handoff should be session 2');
  assert.equal(e.created, firstCreated, 'created must not move on later handoffs');
  subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^handoff: Project S - session 2$/, `got: ${subject}`);

  // --phase is no longer required
  r = gtg(repo, ['handoff', '--project', 'Project T', '--slug', 'proj-t',
    '--next', 'thing'], { input: BODY });
  assert.equal(r.status, 0, `handoff without --phase must succeed: ${r.stderr}`);

  console.log('ok 9 - phase dropped, sessions counts, created is stable');
}

// --- 10. created backfills from disk when handoff files exist but no store entry does
// (a real legacy project whose store entry is missing, now handed off again) ---
{
  const repo = tempRepo();
  const dir = join(repo, 'docs/handoffs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-01-05-0900-old-proj.md'), '# old\n');
  writeFileSync(join(dir, '2026-01-10-1200-old-proj.md'), '# old\n');

  const r = gtg(repo, HANDOFF_ARGS('old-proj', 'Old Proj'), { input: BODY });
  assert.equal(r.status, 0, `handoff failed: ${r.stderr}`);
  const e = active(repo)[0];
  // minor fix: firstHandoffDate() now carries the same local-offset suffix
  // nowIso() uses (a bare vs aware datetime otherwise breaks Python fromisoformat
  // comparisons) - assert via regex so the test isn't tied to the CI box's own tz.
  assert.match(e.created, /^2026-01-05T00:00:00[+-]\d{2}:\d{2}$/,
    'created must backfill to the EARLIEST pre-existing handoff file, not today, with a local-offset suffix');
  assert.equal(e.sessions, 3, 'sessions must count the 2 pre-existing files plus this one');
  console.log('ok 10 - created backfills from disk when no store entry exists');
}

// --- 11. worktree + branch land on the entry; branch is read FROM the worktree ---
{
  const repo = tempRepo();

  // a separate repo standing in for a project worktree, on a distinctive branch
  const wt = tempRepo();
  execSync('git commit -q --allow-empty -m init', { cwd: wt });
  execSync('git checkout -q -b feat/elsewhere', { cwd: wt });

  let r = gtg(repo, [...HANDOFF_ARGS('proj-w', 'Project W'), '--worktree', wt], { input: BODY });
  assert.equal(r.status, 0, `handoff failed: ${r.stderr}`);
  let e = active(repo)[0];
  assert.equal(e.worktree, wt, 'worktree must be stored on the entry');
  assert.equal(e.branch, 'feat/elsewhere',
    `branch must come from the worktree, not the storage root, got: ${e.branch}`);

  // explicit --branch wins over detection
  r = gtg(repo, [...HANDOFF_ARGS('proj-w2', 'Project W2'), '--worktree', wt,
    '--branch', 'stated/branch'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'proj-w2');
  assert.equal(e.branch, 'stated/branch');

  // no --worktree: defaults to 'repo root' and detects in the storage root
  r = gtg(repo, HANDOFF_ARGS('proj-w3', 'Project W3'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'proj-w3');
  assert.equal(e.worktree, 'repo root');
  assert.equal(e.branch, 'main', `storage-root branch expected, got: ${e.branch}`);

  // a worktree path that does not exist must not throw
  r = gtg(repo, [...HANDOFF_ARGS('proj-w4', 'Project W4'),
    '--worktree', join(repo, 'no-such-dir')], { input: BODY });
  assert.equal(r.status, 0, `missing worktree must not fail the handoff: ${r.stderr}`);
  e = active(repo).find((x) => x.slug === 'proj-w4');
  assert.equal(e.branch, '?', `unresolvable branch should be '?', got: ${e.branch}`);

  console.log('ok 11 - worktree and branch stored, detected in the right repo');
}

// --- 12. parent: explicit flag wins, INDEX.md prefix match is the fallback ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/projects'), { recursive: true });
  writeFileSync(join(repo, 'docs/projects/INDEX.md'), [
    '| Project | Status |',
    '|---|---|',
    '| [atlas](atlas.md) | active |',
    '| [Bench & Bar](bench-and-bar.md) | paused |',
    '| [Widget — parts catalog](widget.md) | paused |',
    '| [Widget Ads](widget-ads.md) | paused |',
    '',
  ].join('\n'));

  // explicit --parent wins, even when it matches nothing in INDEX.md
  let r = gtg(repo, [...HANDOFF_ARGS('sub-project', 'Ships Worldbuilding'),
    '--parent', 'atlas'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  let e = active(repo).find((x) => x.slug === 'sub-project');
  assert.equal(e.parent, 'atlas', 'explicit --parent must be honoured verbatim');

  // fallback: slug prefix matches an INDEX.md page slug
  r = gtg(repo, HANDOFF_ARGS('widget-stats-page', 'Widget Stats Page'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'widget-stats-page');
  assert.equal(e.parent, 'widget', 'widget-* should infer the widget family');

  // fallback: two pages qualify ('widget' and 'widget-ads') - longest wins,
  // not whichever the shorter page happened to be listed first in INDEX.md
  r = gtg(repo, HANDOFF_ARGS('widget-ads-report', 'Widget Ads Report'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'widget-ads-report');
  assert.equal(e.parent, 'widget-ads', 'longest matching page slug must win the tie-break, not the first one found');

  // fallback: exact match - a project that IS the family
  r = gtg(repo, HANDOFF_ARGS('bench-and-bar', 'Bench & Bar'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'bench-and-bar');
  assert.equal(e.parent, 'bench-and-bar', 'an exact slug match is its own family');

  // no match: undefined, NOT a wrong guess
  r = gtg(repo, HANDOFF_ARGS('budget-planner', 'Budget Planner'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'budget-planner');
  assert.equal(e.parent, undefined, 'an unmatched slug must be standalone, not mis-assigned');

  // a partial word must not match: 'widgeteer' is not in the 'widget' family
  r = gtg(repo, HANDOFF_ARGS('widgeteer-thing', 'Widgeteer Thing'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo).find((x) => x.slug === 'widgeteer-thing');
  assert.equal(e.parent, undefined, 'prefix match must respect the hyphen boundary');

  // no INDEX.md at all must not throw
  const bare = tempRepo();
  r = gtg(bare, HANDOFF_ARGS('anything', 'Anything'), { input: BODY });
  assert.equal(r.status, 0, `missing INDEX.md must not fail the handoff: ${r.stderr}`);

  console.log('ok 12 - parent inferred from flag then INDEX.md, never guessed wrong');
}

// --- 13. duration_min computed from _session.json, absent when unavailable ---
{
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });

  // a session that started 90 minutes ago, keyed by THIS session's cwd (the repo,
  // which is where gtg() spawns the CLI). The stamp is a per-cwd map so concurrent
  // worktree sessions don't clobber each other's clock.
  const started = new Date(Date.now() - 90 * 60000).toISOString();
  writeFileSync(join(repo, 'docs/handoffs/_session.json'),
    JSON.stringify({ sessions: { [repo]: started } }, null, 2));

  let r = gtg(repo, HANDOFF_ARGS('proj-d', 'Project D'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  let e = active(repo)[0];
  assert.ok(e.duration_min >= 89 && e.duration_min <= 92,
    `expected ~90 minutes, got: ${e.duration_min}`);

  // concurrency isolation: a stamp keyed to a DIFFERENT cwd must be ignored -
  // this session's clock is absent, not another session's.
  const other = tempRepo();
  mkdirSync(join(other, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(other, 'docs/handoffs/_session.json'),
    JSON.stringify({ sessions: { 'C:/some/other/session': started } }, null, 2));
  r = gtg(other, HANDOFF_ARGS('proj-o', 'Project O'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(active(other)[0].duration_min, undefined,
    "another session's stamp must not be borrowed");

  // no _session.json: the field is absent, NOT zero and NOT guessed
  const bare = tempRepo();
  r = gtg(bare, HANDOFF_ARGS('proj-e', 'Project E'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(bare)[0];
  assert.equal(e.duration_min, undefined, 'no stamp must mean no figure, not zero');

  // a stale stamp (>24h) is ignored rather than reported as a 3-day session
  const stale = tempRepo();
  mkdirSync(join(stale, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(stale, 'docs/handoffs/_session.json'),
    JSON.stringify({ sessions: { [stale]: new Date(Date.now() - 72 * 3600000).toISOString() } }));
  r = gtg(stale, HANDOFF_ARGS('proj-f', 'Project F'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(stale)[0];
  assert.equal(e.duration_min, undefined, 'a stale stamp must be discarded');

  // a malformed stamp must not throw
  const bad = tempRepo();
  mkdirSync(join(bad, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(bad, 'docs/handoffs/_session.json'), 'not json at all');
  r = gtg(bad, HANDOFF_ARGS('proj-g', 'Project G'), { input: BODY });
  assert.equal(r.status, 0, `malformed _session.json must not fail: ${r.stderr}`);

  console.log('ok 13 - duration_min from the session stamp, absent when unknown');
}

// --- 14. grouped list: families, location, dirty flag, collision warning ---
{
  const repo = tempRepo();
  const wt = tempRepo();
  execSync('git commit -q --allow-empty -m init', { cwd: wt });

  // two projects in the SAME family
  let r = gtg(repo, [...HANDOFF_ARGS('fam-one', 'Fam One'), '--parent', 'fam'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  r = gtg(repo, [...HANDOFF_ARGS('fam-two', 'Fam Two'), '--parent', 'fam'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  // two standalone projects sharing one worktree AND branch - a collision
  r = gtg(repo, [...HANDOFF_ARGS('solo-a', 'Solo A'), '--worktree', wt], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  r = gtg(repo, [...HANDOFF_ARGS('solo-b', 'Solo B'), '--worktree', wt], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  // a standalone project sorting BEFORE the family alphabetically. Numbering
  // follows DISPLAY order (family group first, then standalone) - NOT full-sorted
  // order - so AAA First, though alphabetically first, numbers AFTER the two
  // family members. displayOrder = [Fam One, Fam Two, AAA First, Solo A, Solo B].
  r = gtg(repo, HANDOFF_ARGS('aaa-first', 'AAA First'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);

  r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;

  assert.match(out, /▸ fam/, 'family header missing');
  assert.match(out, /▸ standalone/, 'standalone group missing');
  // assert on the warning LINE, not just the project name - the name also
  // appears in the listing above, which would pass a weaker match vacuously.
  const warnLine = out.split('\n').find((l) => /projects share/.test(l) && /Solo A/.test(l));
  assert.ok(warnLine, `no collision warning naming Solo A; got:\n${out}`);
  assert.match(warnLine, /Solo B/, 'collision warning must name both colliding projects');

  // numbering contract: numbers run 1..N in DISPLAY order AND round-trip via
  // resolveEntry. Fam One heads the family group -> 1; AAA First is alphabetically
  // first but standalone, so it sits after both family members -> 3. That gap
  // (1 vs a sorted-order 2) is what proves display order, not sorted position.
  const numOf = (proj) => out.split('\n').find((l) => l.includes(proj)).match(/(\d+)\./)[1];
  assert.equal(numOf('Fam One'), '1', `expected Fam One numbered 1 (display order), got ${numOf('Fam One')}`);
  assert.equal(numOf('AAA First'), '3', `expected AAA First numbered 3 (display order), got ${numOf('AAA First')}`);
  const num = numOf('Fam One');
  r = gtg(repo, ['back', num]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Parked: Fam One/,
    `number ${num} shown next to Fam One resolved to a different project`);

  // dirty worktree is flagged
  writeFileSync(join(wt, 'scratch.txt'), 'uncommitted');
  r = gtg(repo, ['list'], { tty: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /uncommitted/, 'dirty worktree not flagged');

  console.log('ok 14 - grouped list with location, dirty flag, collision warning');
}

// --- 15. Finding C1: undo anchors on whichever store the last commit touched,
// not the active one alone - a backlog-only mutation (park a new idea) undoes
// itself, not an unrelated older active-list commit ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY });
  const rp = gtg(repo, ['backlog', '--project', 'Idea X', '--slug', 'idea-x', '--next', 'TBD'], { input: BODY });
  assert.equal(rp.status, 0, rp.stderr);

  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  // Match on WHICH commit got undone (Idea X's park, not Project B's unrelated
  // handoff) rather than the exact subject wording - that wording is Finding I4's
  // concern, this test's concern is purely the anchor-commit selection (C1).
  assert.match(ru.stdout, /Undone:.*Idea X/,
    `undo must target the backlog-only park commit, not an unrelated active-list commit, got: ${ru.stdout}`);
  assert.doesNotMatch(ru.stdout, /Undone:.*Project B/,
    'undo must not revert the unrelated Project B handoff commit');

  const names = active(repo).map((e) => e.project).sort();
  assert.deepEqual(names, ['Project A', 'Project B'],
    'undo of a backlog-only park must leave the active list untouched');
  assert.equal(backlog(repo).length, 0,
    'undo must remove the parked idea, not leave the backlog wiped-but-stale or untouched');
  console.log('ok 15 - Finding C1: undo targets a backlog-only mutation correctly');
}

// --- 15b. explicit completion of backlog work is undoable without touching active work ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, ['backlog', '--project', 'Idea Y', '--slug', 'idea-y', '--next', 'TBD'], { input: BODY });
  const rr = gtg(repo, ['complete', 'idea-y', '--no-list']);
  assert.equal(rr.status, 0, rr.stderr);

  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, ru.stderr);
  assert.match(ru.stdout, /Undone: gtg prune: remove Idea Y from backlog - confirmed done/,
    `undo must target the backlog-completion commit, got: ${ru.stdout}`);
  assert.equal(active(repo).length, 1, 'undo of backlog completion must not touch the active list');
  const bl = backlog(repo);
  assert.equal(bl.length, 1, 'undo must restore the completed backlog entry');
  assert.equal(bl[0].slug, 'idea-y');
  console.log('ok 15b - undo restores an explicitly completed backlog entry');
}

// --- 16. Finding C1: undoing the very first-ever handoff removes the record file
// entirely (no last^ to restore) rather than exiting 2 - the intended behaviour
// change called out in the finding ---
{
  const repo = tempRepo();
  const r = gtg(repo, HANDOFF_ARGS('only-one', 'Only One'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const rec = join(repo, ACTIVE, 'only-one.json');
  assert.ok(existsSync(rec));

  const ru = gtg(repo, ['undo']);
  assert.equal(ru.status, 0, `undoing the first-ever handoff must succeed, not exit 2: ${ru.stderr}`);
  assert.match(ru.stdout, /Active entries now \(0\)/);
  assert.ok(!existsSync(rec),
    'the record file must be removed entirely, since it never existed before this commit');
  const st = execSync('git status --porcelain', { cwd: repo, encoding: 'utf8' });
  assert.equal(st.trim(), '', `the undo left the removal uncommitted:\n${st}`);
  console.log('ok 16 - Finding C1: undo of the first-ever handoff removes the record file, not exit 2');
}

// --- 17. Finding I1: parent and eta carry forward from the prior entry when
// --parent / --eta are omitted on a later handoff for the same slug ---
{
  const repo = tempRepo();
  let r = gtg(repo, [...HANDOFF_ARGS('sub-proj', 'Sub Proj'), '--parent', 'atlas', '--eta', '~3h'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  let e = active(repo)[0];
  assert.equal(e.parent, 'atlas');
  assert.equal(e.eta, '~3h');

  // second handoff, same slug, NEITHER flag passed
  r = gtg(repo, ['handoff', '--project', 'Sub Proj', '--slug', 'sub-proj', '--next', 'more work'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo)[0];
  assert.equal(e.parent, 'atlas', 'parent must carry forward from the prior entry when --parent is omitted');
  assert.equal(e.eta, '~3h', 'eta must carry forward from the prior entry when --eta is omitted');

  // explicit --parent/--eta on a later handoff still overrides the carried value
  r = gtg(repo, ['handoff', '--project', 'Sub Proj', '--slug', 'sub-proj', '--next', 'x',
    '--parent', 'other-fam', '--eta', '~10m'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  e = active(repo)[0];
  assert.equal(e.parent, 'other-fam', 'an explicit --parent must still override the carried-forward value');
  assert.equal(e.eta, '~10m', 'an explicit --eta must still override the carried-forward value');
  console.log('ok 17 - Finding I1: parent and eta carry forward when the flags are omitted');
}

// --- 18. Finding I2: `list()` falls back to the TRUE handoff-file count for a
// legacy entry (no `sessions` field), not a hardcoded 1 ---
{
  const repo = tempRepo();
  const dir = join(repo, 'docs/handoffs');
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 9; i++) writeFileSync(join(dir, `2026-01-0${i}-0900-legacy-proj.md`), '# old\n');
  seedActive(repo, [{ project: 'Legacy Proj', slug: 'legacy-proj', next: 'x', file: 'f', updated: new Date().toISOString() }]);

  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Legacy Proj s9/,
    `legacy entry with 9 handoff files on disk must render s9, not a hardcoded s1, got:\n${r.stdout}`);
  console.log('ok 18 - Finding I2: list() computes true session count for legacy entries');
}

// --- 19. Finding I3: sessions is monotonic - Math.max(disk count, prior + 1)
// so deleted handoff files (or a same-minute filename collision) never make the
// next handoff report a LOWER session number than one already recorded ---
{
  const repo = tempRepo();
  let r = gtg(repo, HANDOFF_ARGS('proj-mono', 'Project Mono'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(active(repo)[0].sessions, 1);

  // Simulate the regression: bump the stored `sessions` far ahead (as a real
  // history of handoffs would have done), then delete the handoff .md files
  // (plain docs, the README explicitly says fine to prune) so the on-disk
  // count no longer agrees with what was already recorded.
  patchActive(repo, (h) => { h[0].sessions = 5; });
  const handoffDoc = active(repo)[0].file;
  execSync(`git rm -q ${handoffDoc}`, { cwd: repo });
  execSync('git commit -q -m "prune old handoff docs"', { cwd: repo });

  r = gtg(repo, HANDOFF_ARGS('proj-mono', 'Project Mono'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const sessions = active(repo)[0].sessions;
  assert.equal(sessions, 6, `sessions must never go backwards from a prior high-water mark, got: ${sessions}`);
  console.log('ok 19 - Finding I3: sessions counter never regresses');
}

// --- 20. a hub reached through a junction (C:/Users/<alias> -> C:/Users/<real>) is
// still the hub. git reports the real path, so a resolve()-only compare stored the real path as a
// worktree and every master handoff there warned "projects share master".
{
  const repo = tempRepo();
  const link = join(mkdtempSync(join(tmpdir(), 'gtg-link-')), 'hub');
  symlinkSync(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
  const r = gtg(repo, HANDOFF_ARGS('via-link', 'Via Link'), { input: BODY, hub: link });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(active(repo)[0].worktree, 'repo root', 'a junctioned hub must record repo root');
  console.log('ok 20 - hub reached through a junction records repo root');
}

console.log('ALL PASS (part 2)');
