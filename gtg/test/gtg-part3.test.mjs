// gtg self-check, part 3 of 6 - assert-based, no framework. Runs every command against
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

// --- 20. Finding I4 (part 1): parking a NEW idea gets an unambiguous commit
// subject ('gtg backlog: new ...'), distinct from `back` shelving an active
// entry ('gtg backlog: park ...', unchanged - historical commits use it) ---
{
  const repo = tempRepo();
  const rp = gtg(repo, ['backlog', '--project', 'Fresh Idea', '--slug', 'fresh-idea', '--next', 'TBD'], { input: BODY });
  assert.equal(rp.status, 0, rp.stderr);
  let subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^gtg backlog: new Fresh Idea - session 1$/, `got: ${subject}`);

  gtg(repo, HANDOFF_ARGS('proj-shelve', 'Project Shelve'), { input: BODY });
  const rb = gtg(repo, ['back', 'proj-shelve']);
  assert.equal(rb.status, 0, rb.stderr);
  subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^gtg backlog: park Project Shelve$/,
    'shelving an active entry must keep its historical subject unchanged');
  console.log('ok 20 - Finding I4a: new-idea park has its own unambiguous commit subject');
}

// --- 21. list does not create a shelf commit (only the review's nudge stamp); explicit back names the project ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('s-one', 'S One'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('s-two', 'S Two'), { input: BODY });
  patchActive(repo, (h) => { for (const e of h) e.updated = new Date(Date.now() - 8 * 86400000).toISOString(); });

  const r = gtg(repo, ['list']);
  assert.equal(r.status, 0, r.stderr);
  let subject = execSync('git log -1 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^gtg nudge: S One$/, `list writes only the review's stamp, got: ${subject}`);
  const parked = gtg(repo, ['back', 's-one', '--no-list']);
  assert.equal(parked.status, 0, parked.stderr);
  // The park, then the stamp from the question back asked about S Two.
  subject = execSync('git log -2 --format=%s', { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(subject, /^gtg nudge: S Two\ngtg backlog: park S One$/);
  console.log('ok 21 - stale list only stamps its question; explicit shelf names its project');
}

// --- 22. minor: firstHandoffDate() emits the same local-offset suffix nowIso()
// does (both aware, not one bare/one aware) ---
{
  const repo = tempRepo();
  const dir = join(repo, 'docs/handoffs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-03-10-0900-off-proj.md'), '# old\n');

  const r = gtg(repo, HANDOFF_ARGS('off-proj', 'Off Proj'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const e = active(repo)[0];
  const createdOffset = e.created.match(/([+-]\d{2}:\d{2})$/);
  const updatedOffset = e.updated.match(/([+-]\d{2}:\d{2})$/);
  assert.ok(createdOffset, `created must carry a local-offset suffix like nowIso(), got: ${e.created}`);
  assert.ok(updatedOffset, `updated (nowIso) must carry a local-offset suffix, got: ${e.updated}`);
  assert.equal(createdOffset[1], updatedOffset[1], 'firstHandoffDate() and nowIso() must agree on the offset format');
  console.log('ok 22 - minor: created/updated offset format matches between firstHandoffDate and nowIso');
}

// --- 23. minor: dirtyCount() failure renders '?', distinct from a clean (0)
// worktree which renders nothing ---
{
  const repo = tempRepo();
  const r = gtg(repo, [...HANDOFF_ARGS('unreachable-wt', 'Unreachable Wt'),
    '--worktree', join(repo, 'no-such-worktree-dir')], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const rl = gtg(repo, ['list'], { tty: true });
  assert.equal(rl.status, 0, rl.stderr);
  assert.match(rl.stdout, /●\s*\?\s*uncommitted/,
    `an unreachable explicit worktree must render '?', not silently show nothing, got:\n${rl.stdout}`);
  console.log('ok 23 - minor: unreachable worktree renders ? instead of silence');
}

// --- 23b. minor: entries with worktree 'repo root' (or legacy-undefined) must
// NEVER show a dirty flag, even when the hub itself is dirty - that count
// belongs to the hub, not to any one project (misattribution fix) ---
{
  const repo = tempRepo();
  const r = gtg(repo, HANDOFF_ARGS('hub-entry', 'Hub Entry'), { input: BODY }); // worktree: 'repo root'
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(repo, 'unrelated-hub-churn.txt'), 'noise'); // dirty the HUB, not any project's worktree
  const rl = gtg(repo, ['list'], { tty: true });
  assert.equal(rl.status, 0, rl.stderr);
  assert.doesNotMatch(rl.stdout, /uncommitted/,
    `a 'repo root' entry must not be flagged dirty from hub churn, got:\n${rl.stdout}`);
  console.log('ok 23b - minor: repo-root entries never misattributed with hub dirty count');
}

// --- 24. minor: `list()`'s resolveDir duplication is gone - both the dirty-map
// build and per-entry render agree on where a project's worktree resolves,
// proven end-to-end via the SAME dirty flag appearing for the entry that owns it ---
{
  const repo = tempRepo();
  const wt = tempRepo();
  execSync('git commit -q --allow-empty -m init', { cwd: wt });
  writeFileSync(join(wt, 'dirty.txt'), 'x');
  const r = gtg(repo, [...HANDOFF_ARGS('own-wt-proj', 'Own Wt Proj'), '--worktree', wt], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const rl = gtg(repo, ['list'], { tty: true });
  assert.equal(rl.status, 0, rl.stderr);
  assert.match(rl.stdout, /Own Wt Proj[\s\S]*?● 1 uncommitted/, 'dirty count for the entry\'s own worktree must resolve consistently');
  console.log('ok 24 - minor: resolveDir consistent between dirty-map build and render');
}

// --- 24c. #96: a piped list is read by a tool, not a person, so it skips the per-worktree
// `git status`. The same list on a TTY still runs it and flags the dirty worktree. ---
{
  const repo = tempRepo();
  const wt = tempRepo();
  execSync('git commit -q --allow-empty -m init', { cwd: wt });
  writeFileSync(join(wt, 'dirty.txt'), 'x');
  const r = gtg(repo, [...HANDOFF_ARGS('piped-wt', 'Piped Wt'), '--worktree', wt], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  const statusCalls = (res) => JSON.parse(res.stderr.match(/^GTG_SPAWNS (.*)$/m)[1])
    .filter((a) => a[0] === 'git' && a.includes('status'));
  const piped = gtg(repo, ['list'], { spawnLog: true });
  assert.equal(piped.status, 0, piped.stderr);
  assert.match(piped.stdout, /Piped Wt/);
  assert.doesNotMatch(piped.stdout, /uncommitted/, 'a piped list shows no dirty flag');
  assert.deepEqual(statusCalls(piped), [], 'a piped list spawns no git status');
  const tty = gtg(repo, ['list'], { tty: true, spawnLog: true });
  assert.equal(tty.status, 0, tty.stderr);
  assert.match(tty.stdout, /Piped Wt[\s\S]*?● 1 uncommitted/);
  assert.equal(statusCalls(tty).length, 1, 'a TTY list runs one git status per distinct worktree');
  console.log('ok 24c - #96: piped list skips git status, TTY list keeps the dirty flag');
}

// --- 25. I2's ctx extension surface: `stats` (a bundled extension, receiving
// ONLY the documented ctx) also gets `countHandoffFiles` and uses it for the
// same legacy-entry fallback, instead of a hardcoded 1 ---
{
  const repo = tempRepo();
  const dir = join(repo, 'docs/handoffs');
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 4; i++) writeFileSync(join(dir, `2026-02-0${i}-0900-legacy-stats.md`), '# old\n');
  seedActive(repo, [{ project: 'Legacy Stats', slug: 'legacy-stats', next: 'x', file: 'f', updated: new Date().toISOString() }]);

  const r = gtg(repo, ['stats']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /deepest: Legacy Stats \(4\)/,
    `stats extension must use ctx.countHandoffFiles for a legacy entry's true count, got:\n${r.stdout}`);
  console.log('ok 25 - ctx contract: countHandoffFiles reaches the stats extension');
}

// --- 26. history: classify handoff (both formats), prune backfill, noise ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');

  // both handoff formats
  assert.deepEqual(H.classify('handoff: Project A — session 3'),
    { type: 'handoff', project: 'Project A', sessions: 3 });
  assert.deepEqual(H.classify('handoff: Legacy Proj — executing'),
    { type: 'handoff', project: 'Legacy Proj', sessions: undefined });

  // project name containing an em-dash must not be split by it
  assert.deepEqual(H.classify('handoff: Widget — parts catalog — session 2'),
    { type: 'handoff', project: 'Widget — parts catalog', sessions: 2 });

  // Hyphen twins. Every em-dash assertion in this case is a backward-compatibility
  // guard over commit subjects already in git history, so none of them may be swept.
  // These mirror them in the hyphen format gtg has written since 2026-08-05.
  assert.deepEqual(H.classify('handoff: Project A - session 3'),
    { type: 'handoff', project: 'Project A', sessions: 3 });
  assert.deepEqual(H.classify('handoff: Legacy Proj - executing'),
    { type: 'handoff', project: 'Legacy Proj', sessions: undefined });
  // the anchored session tail saves a project name that contains the separator
  assert.deepEqual(H.classify('handoff: Widget - parts catalog - session 2'),
    { type: 'handoff', project: 'Widget - parts catalog', sessions: 2 });
  // The legacy fallback has no anchor, so it must bind to the LAST separator.
  // Widening only the separator of the old negated-class pattern, and leaving the
  // negated class itself on the em dash, passes every other line in this case and
  // fails exactly here: it would strip from the FIRST separator and yield 'Widget'.
  assert.deepEqual(H.classify('handoff: Widget - parts catalog - executing'),
    { type: 'handoff', project: 'Widget - parts catalog', sessions: undefined });
  // a hyphen with no spaces around it is part of the name, not a separator
  assert.deepEqual(H.classify('handoff: gtg-extensions - session 4'),
    { type: 'handoff', project: 'gtg-extensions', sessions: 4 });
  assert.equal(H.classify('gtg backlog: new Idea Z - session 1').type, 'park');
  assert.equal(H.classify('gtg resume: Picked Up - handoff consumed').type, 'resume');
  assert.equal(H.classify('gtg resume: Picked Up - backlog handoff consumed').type, 'resume');

  // the other verbs
  assert.equal(H.classify('gtg backlog: new Idea Z — session 1').type, 'park');
  assert.equal(H.classify('gtg backlog: park Shelf Me').type, 'shelve');
  assert.equal(H.classify('gtg backlog: auto-park 2 stale (>7d): A, B').type, 'autoshelf');
  assert.equal(H.classify('gtg activate: Bring Back').type, 'activate');
  assert.equal(H.classify('gtg prune: remove Done Thing - confirmed done').type, 'prune');
  assert.equal(H.classify('gtg resume: Picked Up — handoff consumed').type, 'resume');
  assert.equal(H.classify("gtg undo: revert 'handoff: X — session 1'").type, 'undo');
  assert.equal(H.classify('Merge branch main into feature').type, 'noise');

  // slugify matches CLI conventions
  assert.equal(H.slugify('Widget — parts catalog'), 'widget-parts-catalog');
  assert.equal(H.slugify('Bench & Bar'), 'bench-bar');

  // backfill: a prune that recurs later is a resume; one that never returns shipped.
  // rawLog is newest-first, like `git log`.
  const raw = [
    { date: '2026-07-10T00:00:00+08:00', subject: 'handoff: Recurring — session 2' }, // later
    { date: '2026-07-08T00:00:00+08:00', subject: 'gtg prune: remove Recurring - confirmed done' },
    { date: '2026-07-05T00:00:00+08:00', subject: 'handoff: Recurring — session 1' },
    { date: '2026-07-04T00:00:00+08:00', subject: 'gtg prune: remove Gone Forever - confirmed done' },
    { date: '2026-07-03T00:00:00+08:00', subject: 'handoff: Gone Forever — session 1' },
  ];
  const ev = H.classifyEvents(raw);
  const recurringPrune = ev.find((e) => e.type === 'prune' && e.project === 'Recurring');
  const goneForeverPrune = ev.find((e) => e.type === 'prune' && e.project === 'Gone Forever');
  assert.equal(recurringPrune.resumed, true, 'a prune with a later handoff is a resume');
  assert.equal(recurringPrune.shipped, undefined);
  assert.equal(goneForeverPrune.shipped, true, 'a prune that never recurs is a ship');
  assert.equal(goneForeverPrune.resumed, undefined);

  console.log('ok 26 - history classifier + backfill');
}

// --- 27. history readers against a throwaway repo ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });

  // two handoff docs (readSessions reads filenames) + commits (readEvents reads subjects)
  writeFileSync(join(repo, 'docs/handoffs/2026-07-05-0900-alpha.md'), '# h');
  writeFileSync(join(repo, 'docs/handoffs/2026-07-06-1830-alpha.md'), '# h');
  execSync('git add -A', { cwd: repo });
  execSync('git commit -q -m "handoff: Alpha — session 2"', { cwd: repo });
  // A real prune touches the store under docs/handoffs/ - since the shard that is
  // active/<slug>.json, not the packed file this fixture writes. Either satisfies readEvents,
  // whose pathspec is the whole docs/handoffs/ directory; what the fixture must avoid is a
  // commit touching NOTHING under it (an --allow-empty prune), which the pathspec filters out.
  // Left packed deliberately: this case classifies a historical subject, and the real hub's
  // history has prune commits from both sides of the migration.
  writeFileSync(join(repo, 'docs/handoffs/_active.json'), '{"handoffs":[]}');
  execSync('git add -A', { cwd: repo });
  execSync('git commit -q -m "gtg prune: remove Alpha - confirmed done"', { cwd: repo });

  const { events, available } = H.readEvents(repo);
  assert.equal(available, true, 'a real repo must report available');
  assert.ok(events.some((e) => e.type === 'handoff' && e.project === 'Alpha'), 'handoff event missing');
  assert.ok(events.some((e) => e.type === 'prune'), 'prune event missing');

  const sessions = H.readSessions(repo);
  assert.equal(sessions.length, 2, 'two handoff files → two sessions');
  assert.deepEqual(sessions.map((s) => s.hour).sort((a, b) => a - b), [9, 18]);
  assert.ok(sessions.every((s) => s.slug === 'alpha'));

  // a non-git dir degrades, never throws. GIT_CEILING_DIRECTORIES pins git's
  // upward search at tmpdir - readEvents() is called in-process here (unlike the
  // gtg() CLI helper above), so it inherits process.env directly; without the
  // ceiling, git would walk up and resolve the enclosing dev-machine repo.
  const bare = mkdtempSync(join(tmpdir(), 'gtg-nogit-'));
  const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  let r;
  try { r = H.readEvents(bare); } finally {
    if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
  }
  assert.equal(r.available, false, 'non-git dir → available:false');
  assert.deepEqual(r.events, []);

  console.log('ok 27 - history readers');
}

// --- 28. readEvents walk-up guard: a subdir of a real repo that is NOT itself
// a repo must NOT inherit the enclosing repo's history as its own. Without the
// guard, `git -C <subdir> log` walks up and returns the OUTER repo's commits
// with available:true - a wrong answer presented as good data.
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const outer = tempRepo();
  mkdirSync(join(outer, 'docs/handoffs'), { recursive: true });
  writeFileSync(join(outer, 'docs/handoffs/2026-07-05-0900-alpha.md'), '# h');
  execSync('git add -A', { cwd: outer });
  execSync('git commit -q -m "handoff: Alpha — session 1"', { cwd: outer });

  // subdir inside outer's worktree, deliberately NOT its own repo (no git init)
  const sub = join(outer, 'scratch-hub');
  mkdirSync(sub, { recursive: true });

  const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
  delete process.env.GIT_CEILING_DIRECTORIES; // must NOT block the walk-up; the guard must
  let r, rOuter;
  try {
    r = H.readEvents(sub);
    rOuter = H.readEvents(outer);
  } finally {
    if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
  }
  assert.equal(r.available, false, 'non-repo subdir of a real repo must degrade, not inherit outer history');
  assert.deepEqual(r.events, []);
  assert.equal(rOuter.available, true, 'the real repo top-level itself must still report available');

  console.log('ok 28 - readEvents walk-up guard');
}

// --- 29. habit + throughput derivations (pure, injected data) ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');

  const ev = [ // newest-first
    { date: '2026-07-10T18:00:00+08:00', type: 'prune', project: 'P', slug: 'p', shipped: true },
    { date: '2026-07-09T09:00:00+08:00', type: 'handoff', project: 'P', slug: 'p', sessions: 2 },
    { date: '2026-07-08T11:00:00+08:00', type: 'handoff', project: 'P', slug: 'p', sessions: 1 },
    { date: '2026-07-05T14:00:00+08:00', type: 'park', project: 'Q', slug: 'q' },
  ];
  const sessions = [
    { date: '2026-07-08', hour: 11, slug: 'p' },
    { date: '2026-07-09', hour: 9, slug: 'p' },
  ];

  const h = H.habit(ev, sessions);
  assert.equal(h.activeDays, 4, 'four distinct active days');
  // 07-08, 07-09 (handoffs) and 07-10 (the ship/prune day, also an active
  // type per spec) are three calendar-consecutive days -> streak of 3.
  assert.equal(h.longestStreak, 3, '07-08, 07-09 & 07-10 (ship day) are consecutive');
  assert.equal(h.byHour[11], 1);
  assert.equal(h.byHour[9], 1);
  assert.equal(h.grid[0].date, '2026-07-05', 'grid starts at the earliest active day');
  assert.equal(h.grid[h.grid.length - 1].date, '2026-07-10', 'grid ends at the latest');

  const t = H.throughput(ev);
  assert.equal(t.shipped, 1);
  assert.equal(t.parked, 1);
  assert.equal(t.lastShip.project, 'P');
  // P shipped 07-10, first handoff 07-08 → 2 days to ship
  assert.equal(t.medianDaysToShip, 2);
  assert.equal(t.shipRate, null, 'shipRate is filled by the assembler, not here');

  console.log('ok 29 - habit + throughput');
}

// --- 30. family / per-project / health / fun derivations ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const ev = [
    { date: '2026-07-12T10:00:00+08:00', type: 'prune', project: 'Widget Stats', slug: 'widget-stats', shipped: true },
    { date: '2026-07-11T10:00:00+08:00', type: 'handoff', project: 'Widget Stats', slug: 'widget-stats', sessions: 1 },
    { date: '2026-07-06T10:00:00+08:00', type: 'activate', project: 'Old Idea', slug: 'old-idea' },
    { date: '2026-07-05T10:00:00+08:00', type: 'park', project: 'Old Idea', slug: 'old-idea' },
    { date: '2026-07-04T10:00:00+08:00', type: 'resume', project: 'Widget Data', slug: 'widget-data' },
    { date: '2026-07-02T10:00:00+08:00', type: 'handoff', project: 'Widget Data', slug: 'widget-data', sessions: 1 },
  ];
  const sessions = [
    { date: '2026-07-11', hour: 10, slug: 'widget-stats' },
    { date: '2026-07-02', hour: 10, slug: 'widget-data' },
  ];
  const active = [{ slug: 'old-idea', project: 'Old Idea', parent: undefined, updated: '2026-07-06T10:00:00+08:00' }];
  const backlog = [];

  const rows = H.perProject(ev, sessions, active, backlog);
  const stats = rows.find((r) => r.slug === 'widget-stats');
  assert.equal(stats.status, 'shipped');
  assert.equal(stats.daysToShip, 1, 'handoff 07-11 → ship 07-12');
  const idea = rows.find((r) => r.slug === 'old-idea');
  assert.equal(idea.status, 'active', 'in the active store → active');

  // family grouping needs parent on the rows; assign via a fake INDEX join
  rows.forEach((r) => { if (r.slug.startsWith('widget')) r.parent = 'widget'; });
  const fams = H.families(rows);
  const widget = fams.find((f) => f.parent === 'widget');
  assert.equal(widget.subProjects, 2, 'widget-stats + widget-data');
  assert.equal(widget.shipped, 1);
  assert.equal(widget.first, '2026-07-02', 'earliest born date across the family');
  assert.equal(widget.latest, '2026-07-12', 'latest activity across the family');
  assert.equal(widget.totalHours, 0, 'no effort passed → no hours claimed');

  // effort join: rows carry minutes off the REAL slug, families sum them exactly
  const effort = { bySlug: { 'widget-stats': [45, 45], 'widget-data': [30] } };
  const timed = H.perProject(ev, sessions, active, backlog, effort);
  timed.forEach((r) => { if (r.slug.startsWith('widget')) r.parent = 'widget'; });
  assert.equal(timed.find((r) => r.slug === 'widget-stats').minutes, 90);
  assert.equal(timed.find((r) => r.slug === 'old-idea').minutes, null, 'untimed → null, not 0');
  assert.equal(H.families(timed).find((f) => f.parent === 'widget').totalHours, 2, '120min across the family');

  const hl = H.health(ev, rows);
  assert.equal(hl.resurrectionRate, 1, 'one activate, one park → 1.0');

  const fn = H.fun(ev, rows);
  assert.equal(fn.mostResumed.slug, 'widget-data', 'widget-data has the resume');

  console.log('ok 30 - family / per-project / health / fun');
}

// --- 31. health(): wipByDay must not invert spans (Finding 1), abandonmentRate
// must be computed over distinct parked slugs, not raw park/shelve events (Finding 2) ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');

  // Finding 1: resume-before-handoff must not produce an inverted (empty) span.
  const wipEvents = [
    { date: '2026-07-01T09:00:00+08:00', type: 'resume', project: 'Resumed No Ship', slug: 'resumed-no-ship' },
    { date: '2026-07-05T09:00:00+08:00', type: 'handoff', project: 'Resumed No Ship', slug: 'resumed-no-ship' },
    { date: '2026-07-10T09:00:00+08:00', type: 'handoff', project: 'Shipped After', slug: 'shipped-after' },
    { date: '2026-07-12T09:00:00+08:00', type: 'prune', project: 'Shipped After', slug: 'shipped-after', shipped: true },
  ];
  const wipHealth = H.health(wipEvents, []);
  assert.ok(wipHealth.wipByDay.length > 0,
    'wipByDay must not come back empty when a slug has resume-before-handoff (old code inverted the span)');
  const handoffDay = wipHealth.wipByDay.find((d) => d.date === '2026-07-05');
  assert.ok(handoffDay && handoffDay.count >= 1,
    'the resumed-then-handed-off project must be counted as in-progress on its first handoff day');
  const shipDay = wipHealth.wipByDay.find((d) => d.date === '2026-07-12');
  assert.ok(shipDay, "the genuinely-shipped project's ship day must fall within the wipByDay range");
  for (const d of wipHealth.wipByDay) assert.ok(d.count >= 0, `negative/garbage count at ${d.date}`);

  // Finding 2: abandonmentRate/resurrectionRate must share a distinct-slug denominator.
  const abEvents = [
    { date: '2026-06-01T09:00:00+08:00', type: 'park', project: 'Parked Twice', slug: 'parked-twice' },
    { date: '2026-06-10T09:00:00+08:00', type: 'park', project: 'Parked Twice', slug: 'parked-twice' },
    { date: '2026-06-01T09:00:00+08:00', type: 'park', project: 'Parked Recovered', slug: 'parked-recovered' },
    { date: '2026-06-05T09:00:00+08:00', type: 'activate', project: 'Parked Recovered', slug: 'parked-recovered' },
  ];
  const abRows = [
    { slug: 'parked-twice', status: 'dormant' },
    { slug: 'parked-recovered', status: 'active' },
  ];
  const abHealth = H.health(abEvents, abRows);
  assert.equal(abHealth.abandonmentRate, 0.5,
    'abandonmentRate must be 1 abandoned / 2 distinct parked slugs, not 1/3 raw park events');
  assert.equal(abHealth.resurrectionRate, 0.5,
    'resurrectionRate must share the same distinct-parked-slug denominator');

  console.log('ok 31 - health(): wipByDay non-inversion + abandonment/resurrection distinct-slug units');
}

// --- 32. effort: recover committed durations from _active.json diffs ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });
  const write = (obj) => writeFileSync(join(repo, 'docs/handoffs/_active.json'), JSON.stringify(obj, null, 2) + '\n');

  write({ handoffs: [{ project: 'P', slug: 'p', duration_min: 45 }] });
  execSync('git add -A && git commit -q -m "handoff: P — session 1"', { cwd: repo });
  write({ handoffs: [{ project: 'P', slug: 'p', duration_min: 90 }] });
  execSync('git add -A && git commit -q -m "handoff: P — session 2"', { cwd: repo });
  write({ handoffs: [{ project: 'Q', slug: 'q', duration_min: 30 }] });
  execSync('git add -A && git commit -q -m "handoff: Q — session 1"', { cwd: repo });

  const d = H.readDurations(repo);
  assert.equal(d.total, 45 + 90 + 30, 'sum of all committed durations');
  assert.equal(d.sessionsTimed, 3);
  assert.deepEqual(d.bySlug.p.sort((a, b) => a - b), [45, 90]);
  assert.deepEqual(d.bySlug.q, [30]);

  // derived roll-ups
  assert.equal(d.avgSessionMin, 55, '(45+90+30)/3');
  assert.equal(d.longestSessionMin, 90);
  assert.equal(d.hoursBySlug.p, 2.3, '135min -> 2.3h (1dp)');
  const weekHours = Object.values(d.hoursByWeek).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(weekHours - 165 / 60) < 0.11, 'weekly buckets account for the whole total');

  // no git → empty, no throw
  const bare = mkdtempSync(join(tmpdir(), 'gtg-nod-'));
  const bareResult = H.readDurations(bare);
  assert.equal(bareResult.total, 0);
  assert.equal(bareResult.sessionsTimed, 0);
  assert.deepEqual(bareResult.bySlug, {});
  assert.equal(bareResult.avgSessionMin, null, 'no data → null, never 0');

  // walk-up guard: a non-repo subdir nested in an outer repo that HAS committed
  // durations (tracked at a path that lines up with cwd-relative pathspec
  // resolution - git's pathspec is relative to cwd, so the nested file's repo
  // path must physically match "scratch-hub/docs/handoffs/_active.json" for the
  // leak to be reachable at all) must yield the empty result, never that data.
  const outer = tempRepo();
  mkdirSync(join(outer, 'scratch-hub/docs/handoffs'), { recursive: true });
  writeFileSync(join(outer, 'scratch-hub/docs/handoffs/_active.json'),
    JSON.stringify({ handoffs: [{ project: 'Leak', slug: 'leak', duration_min: 999 }] }, null, 2) + '\n');
  execSync('git add -A && git commit -q -m "handoff: Leak — session 1"', { cwd: outer });
  const sub = join(outer, 'scratch-hub'); // deliberately NOT its own repo (no git init)

  const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
  delete process.env.GIT_CEILING_DIRECTORIES; // must NOT block the walk-up; the guard must
  let subResult;
  try { subResult = H.readDurations(sub); } finally {
    if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
  }
  assert.equal(subResult.total, 0, 'non-repo subdir of a real repo must degrade, not inherit outer durations');
  assert.deepEqual(subResult.bySlug, {});

  console.log('ok 32 - effort durations');
}

// --- 32b. effort: a non-handoff commit that re-adds an entry must NOT re-bill
// its duration. `gtg activate` (backlog -> active) and `gtg undo` both rewrite
// the whole entry with duration_min unchanged; counting those double-billed
// sessions that only ever happened once. ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });
  const write = (obj) => writeFileSync(join(repo, 'docs/handoffs/_active.json'), JSON.stringify(obj, null, 2) + '\n');
  const entry = { project: 'R', slug: 'r', duration_min: 60 };

  write({ handoffs: [entry] });
  execSync('git add -A && git commit -q -m "handoff: R — session 1"', { cwd: repo });
  write({ handoffs: [] });                                   // shelved to the backlog
  execSync('git add -A && git commit -q -m "gtg backlog: park R"', { cwd: repo });
  write({ handoffs: [entry] });                              // reactivated, same duration
  execSync('git add -A && git commit -q -m "gtg activate: R"', { cwd: repo });

  const d = H.readDurations(repo);
  assert.equal(d.total, 60, 'one real session, counted once - the activate re-add must not re-bill it');
  assert.equal(d.sessionsTimed, 1);
  assert.deepEqual(d.bySlug.r, [60]);

  console.log('ok 32b - effort ignores non-handoff re-adds');
}

// --- 32c. effort: the duration pathspec spans the packed-to-sharded migration ---
// readDurations reads HISTORY, and history crosses the shard. A pathspec naming only the
// packed file zeroes every duration recorded after the migration; one naming only the
// directory zeroes every duration recorded before it. Neither failure raises anything - the
// figure just reads low - so both halves are committed here in one repo and the total is the
// assertion. The slug scan needs no per-file reset to make this work, and history.mjs records
// why: a handoff commits exactly ONE active record, and that record's own "slug" line always
// lands in the hunk with its duration_min. Q's 30 minutes landing on Q rather than on P is the
// half of this case that measures it.
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });

  // Pre-shard: one duration committed to the packed file.
  writeFileSync(join(repo, PACKED_ACTIVE),
    JSON.stringify({ handoffs: [{ project: 'P', slug: 'p', duration_min: 45 }] }, null, 2) + '\n');
  execSync('git add -A && git commit -q -m "handoff: P — session 1"', { cwd: repo });

  // Post-shard: P re-timed, then Q added, as per-record files.
  writeCollection(repo, ACTIVE, [{ project: 'P', slug: 'p', duration_min: 90 }]);
  execSync('git add -A && git commit -q -m "handoff: P — session 2"', { cwd: repo });
  writeCollection(repo, ACTIVE, [{ project: 'P', slug: 'p', duration_min: 90 },
    { project: 'Q', slug: 'q', duration_min: 30 }]);
  execSync('git add -A && git commit -q -m "handoff: Q — session 1"', { cwd: repo });

  const d = H.readDurations(repo);
  assert.equal(d.total, 45 + 90 + 30,
    `every duration on both sides of the migration must be recovered, got ${d.total}`);
  assert.equal(d.sessionsTimed, 3);
  assert.deepEqual(d.bySlug.p.sort((a, b) => a - b), [45, 90], 'P is timed across the migration');
  assert.deepEqual(d.bySlug.q, [30], "Q's duration must be billed to Q, not carried over from P");
  console.log('ok 32c - effort spans the packed-to-sharded migration');
}

// --- 33. buildReport assembler + report/stats commands ---
{
  const repo = tempRepo();
  // one shipped project, one active
  let r = gtg(repo, HANDOFF_ARGS('live-one', 'Live One'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  r = gtg(repo, HANDOFF_ARGS('shipme', 'Ship Me'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  r = gtg(repo, ['remove', 'shipme']); // ships it
  assert.equal(r.status, 0, r.stderr);

  // stats prints without crashing and reports the ship
  r = gtg(repo, ['stats']);
  assert.equal(r.status, 0, `stats failed: ${r.stderr}`);
  assert.match(r.stdout, /1 active, 0 backlog/);
  assert.match(r.stdout, /shipped/i);

  // report writes JSON to the default path and prints it
  r = gtg(repo, ['report']);
  assert.equal(r.status, 0, `report failed: ${r.stderr}`);
  const path = r.stdout.trim().split('\n').find((l) => l.includes('_report.json'));
  assert.ok(path, 'report must print the json path');
  const doc = JSON.parse(readFileSync(join(repo, 'docs/handoffs/_report.json'), 'utf8'));
  assert.equal(doc.historyAvailable, true);
  assert.equal(doc.counts.active, 1);
  assert.equal(doc.throughput.shipped, 1);
  assert.ok(doc.habit && doc.perProject && doc.families && doc.health && doc.fun, 'all sections present');
  assert.ok(doc.effort, 'effort section present');
  assert.equal(doc.coverage.sessionHoursByClock,
    'legacy-dated-handoff-files-only',
    'report JSON must disclose that canonical current revisions have no filename clock');
  assert.ok(typeof doc.throughput.shipRate === 'number', 'assembler fills shipRate');

  // The ONLY assertion tying the subject gtg.mjs WRITES to the regex history.mjs PARSES.
  // Everything above is store-derived or survives a broken parse: counts.active reads the
  // store, and a prune with no later handoff counts as shipped either way. Case 26 cannot
  // cover this either, because its subjects are string literals rather than this writer's
  // output. Break the separator or the session suffix in one place only and the session
  // number folds into the project NAME, so the handoff joins to no store entry and appears
  // as an extra phantom row here. That is the corruption the separator sweep existed to
  // prevent, and the row count is what detects it.
  assert.equal(doc.perProject.length, 2, 'a phantom project row means the subject no longer parses');
  assert.ok(doc.perProject.some((p) => p.project === 'Live One' && p.sessions === 1),
    'the handoff subject did not round-trip from writer to report');

  // --json override
  r = gtg(repo, ['report', '--json', join(repo, 'custom.json')]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(repo, 'custom.json')));

  console.log('ok 33 - buildReport + report/stats commands');
}

// --- 34. perProject: canonicalise the join key to slugify(project). An event's
// slug comes from the commit subject (slugify(project)); a store entry's slug is
// the hand-chosen --slug. When they diverge, the old code (keyed store maps by
// entry.slug) produced a phantom event-row PLUS a separate store-row for one
// project. Keying both sides by slugify(project) merges them into one row. ---
{
  const H = await import('../skills/gtg/extensions/lib/history.mjs');
  const rawLog = [
    { date: '2026-07-20T10:00:00+08:00', subject: 'handoff: GTG Stats History Upgrade — session 2' },
    { date: '2026-07-18T10:00:00+08:00', subject: 'handoff: GTG Stats History Upgrade — session 1' },
    { date: '2026-07-15T10:00:00+08:00', subject: 'handoff: Same Slug Project — session 1' },
  ];
  const events = H.classifyEvents(rawLog);
  assert.ok(events.some((e) => e.slug === 'gtg-stats-history-upgrade'),
    'sanity: event slug is slugify(project), not the store slug');

  const active = [
    { project: 'GTG Stats History Upgrade', slug: 'gtg-stats-history', parent: 'gtg', updated: '2026-07-20T10:00:00+08:00' },
    { project: 'Same Slug Project', slug: 'same-slug-project', parent: undefined, updated: '2026-07-15T10:00:00+08:00' },
  ];
  const rows = H.perProject(events, [], active, []);

  // divergent slug ("gtg-stats-history" vs slugify → "gtg-stats-history-upgrade")
  const upgradeRows = rows.filter((r) => r.project === 'GTG Stats History Upgrade');
  assert.equal(upgradeRows.length, 1,
    'divergent slug must merge into ONE row, not a phantom dormant row + a separate active row');
  assert.equal(upgradeRows[0].status, 'active');
  assert.equal(upgradeRows[0].slug, 'gtg-stats-history', 'display slug is the store\'s REAL slug');
  assert.equal(upgradeRows[0].parent, 'gtg');

  // matching slug (slugify(project) already equals the store slug) - unaffected
  const sameRows = rows.filter((r) => r.project === 'Same Slug Project');
  assert.equal(sameRows.length, 1, 'matching-slug case must still yield exactly one row');
  assert.equal(sameRows[0].status, 'active');
  assert.equal(sameRows[0].slug, 'same-slug-project');

  console.log('ok 34 - perProject canonicalises the join key to slugify(project)');
}

// --- 35. tuned collision warning: master/main @ repo root is the sanctioned home
// for docs/meta work (home-repo doctrine) and must NOT warn; a genuine
// feature-branch collision (even at repo root) still does ---
{
  const repo = tempRepo(); // inits on -b main
  gtg(repo, HANDOFF_ARGS('meta-a', 'Meta A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('meta-b', 'Meta B'), { input: BODY });
  let out = gtg(repo, ['list']).stdout;
  assert.doesNotMatch(out, /projects share/, 'main @ repo root must not be flagged as a collision');

  // two projects sharing a FEATURE branch at repo root - a real tangle
  gtg(repo, [...HANDOFF_ARGS('feat-a', 'Feat A'), '--branch', 'feat/x'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('feat-b', 'Feat B'), '--branch', 'feat/x'], { input: BODY });
  out = gtg(repo, ['list']).stdout;
  const warn = out.split('\n').find((l) => /projects share/.test(l));
  assert.ok(warn && /feat\/x/.test(warn), `feature-branch collision must still warn; got:\n${out}`);
  assert.match(warn, /Feat A/); assert.match(warn, /Feat B/);
  assert.doesNotMatch(warn, /Meta A/, 'base-branch @ repo root entries must be excluded from the warning');
  console.log('ok 35 - collision warning skips master/main @ repo root, still flags a feature branch');
}

// --- 36. auto-list after a move: suppressed when piped (AI / non-TTY, no wasted
// context), forced by --list, muted by --no-list ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY });

  // piped stdout (spawnSync) is not a TTY => no auto-render, just the move's line
  const rb = gtg(repo, ['back', 'proj-a']);
  assert.equal(rb.status, 0, rb.stderr);
  assert.match(rb.stdout, /Parked: Project A/);
  assert.doesNotMatch(rb.stdout, /active gtg project/,
    'a piped move must not dump the list - that is the wasted-context case');

  // --list forces the full render even when piped
  const ra = gtg(repo, ['active', 'proj-a', '--list']);
  assert.equal(ra.status, 0, ra.stderr);
  assert.match(ra.stdout, /Activated: Project A/);
  assert.match(ra.stdout, /active gtg project/, '--list must force the render');
  assert.match(ra.stdout, /Project B/, 'forced render shows the current active list');

  // --no-list suppresses it explicitly
  const rn = gtg(repo, ['back', 'proj-a', '--no-list']);
  assert.equal(rn.status, 0, rn.stderr);
  assert.doesNotMatch(rn.stdout, /active gtg project/);
  console.log('ok 36 - auto-list: off when piped, forced by --list, muted by --no-list');
}


// --- 37. rename: slug changes, children re-point, current handoff path follows ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('fam', 'Family Parent'), { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('kid-one', 'Kid One'), '--parent', 'fam'], { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('kid-two', 'Kid Two'), '--parent', 'fam'], { input: BODY });
  const before = active(repo).find((e) => e.slug === 'fam').file;

  const r = gtg(repo, ['rename', 'fam', 'family']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Renamed: Family Parent \(fam -> family\)/);
  assert.match(r.stdout, /re-pointed 2 sub-project/);
  assert.match(r.stdout, /projects rename fam family/, 'it points at the portfolio half');

  const hs = active(repo);
  assert.equal(hs.filter((e) => e.slug === 'family').length, 1, 'renamed, not duplicated');
  assert.equal(hs.filter((e) => e.slug === 'fam').length, 0);
  assert.deepEqual(hs.filter((e) => e.parent === 'family').map((e) => e.slug).sort(),
    ['kid-one', 'kid-two'], 'both children follow the parent');
  assert.equal(hs.filter((e) => e.parent === 'fam').length, 0,
    'no orphan left pointing at the old slug');

  // The writable current path follows the live slug so a new `fam` line cannot clobber it.
  // Git retains the old path/version in history.
  const after = hs.find((e) => e.slug === 'family').file;
  assert.equal(before, 'docs/handoffs/current/fam.md');
  assert.equal(after, 'docs/handoffs/current/family.md');
  assert.equal(existsSync(join(repo, before)), false, 'the old writable path must be released');
  assert.ok(existsSync(join(repo, after)), 'and that file is still on disk');
  console.log('ok 37 - rename: slug, children, and current handoff path move together');
}

// --- 38. rename: refusals, and a backlog entry renames too ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('proj-b', 'Project B'), { input: BODY });

  assert.equal(gtg(repo, ['rename']).status, 2, 'no args is a usage error');
  assert.equal(gtg(repo, ['rename', 'proj-a']).status, 2, 'a missing target is a usage error');
  const bad = gtg(repo, ['rename', 'proj-a', 'has spaces']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /must start with a letter or digit and match/,
    'a slug becomes a path segment, so it is constrained');
  const taken = gtg(repo, ['rename', 'proj-a', 'proj-b']);
  assert.equal(taken.status, 2);
  assert.match(taken.stderr, /already used by another project/);
  const self = gtg(repo, ['rename', 'proj-a', 'proj-a']);
  assert.equal(self.status, 2);
  assert.match(self.stderr, /already its slug/);
  assert.equal(gtg(repo, ['rename', 'nope', 'whatever']).status, 2);
  assert.deepEqual(active(repo).map((e) => e.slug).sort(), ['proj-a', 'proj-b'],
    'every refusal left both slugs alone');

  // A shelved entry is renameable, since resolve falls through to the backlog.
  gtg(repo, ['back', 'proj-a', '--no-list']);
  const shelved = gtg(repo, ['rename', 'proj-a', 'alpha', '--no-list']);
  assert.equal(shelved.status, 0, shelved.stderr);
  const bl = backlog(repo);
  assert.equal(bl.filter((e) => e.slug === 'alpha').length, 1, 'the backlog entry was renamed');
  console.log('ok 38 - rename: refusals, and a backlog entry renames too');
}

console.log('ALL PASS (part 3)');
