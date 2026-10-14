// gtg self-check, part 6 of 6 - assert-based, no framework. Runs every command against
// throwaway temp git repos. Non-zero exit on any failure. One file was ~97 s on its own, so the
// cases are split across gtg-part1..6.test.mjs, which the runner runs side by side (#128).
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readCollection, writeCollection } from '../skills/gtg/lib/store.mjs';
import { CLI, SHIM, ageFetchHead, tempRepo, tempRepoNoIdentity, gtg, HANDOFF_ARGS, BODY, ACTIVE, BACKLOG, active, backlog, PACKED_ACTIVE, PACKED_BACKLOG, seedActive, nameStatus, patchActive } from './gtg-harness.mjs';

// --- 71. report and stats read the SHARDED store ---
// The silent one. history.mjs used to read records through ctx.readStore, a whole-file JSON
// reader, and `readStore('docs/handoffs/_active.json')?.handoffs ?? []` degrades to [] with no
// error whatsoever once the records live one per file - so `report` and `stats` printed a
// clean, plausible, empty answer. This fixture has NO packed file at all, which is the state
// every hub created after the migration is in, and both expected counts are derived from the
// store rather than written down, so a reader that goes back through readStore reports zero
// against a non-zero store and fails here instead of lying.
{
  const repo = tempRepo();
  for (const [slug, project] of [['ra', 'R A'], ['rb', 'R B'], ['rc', 'R C']]) {
    const r = gtg(repo, HANDOFF_ARGS(slug, project), { input: BODY });
    assert.equal(r.status, 0, r.stderr);
  }
  gtg(repo, ['back', 'rc', '--no-list']);

  assert.ok(!existsSync(join(repo, PACKED_ACTIVE)), 'setup: no packed active file may exist here');
  assert.ok(!existsSync(join(repo, PACKED_BACKLOG)), 'setup: no packed backlog file may exist here');
  const nActive = active(repo).length;
  const nBacklog = backlog(repo).length;
  assert.equal(nActive, 2, 'setup: two records left active');   // GUARD
  assert.equal(nBacklog, 1, 'setup: one record parked');        // GUARD

  const rs = gtg(repo, ['stats']);
  assert.equal(rs.status, 0, rs.stderr);
  assert.match(rs.stdout, new RegExp(`^${nActive} active, ${nBacklog} backlog$`, 'm'),
    `stats must count the sharded store, got:\n${rs.stdout}`);

  const rr = gtg(repo, ['report']);
  assert.equal(rr.status, 0, rr.stderr);
  const doc = JSON.parse(readFileSync(join(repo, 'docs/handoffs/_report.json'), 'utf8'));
  assert.equal(doc.counts.active, nActive, 'report must count the sharded active store');
  assert.equal(doc.counts.backlog, nBacklog, 'report must count the sharded backlog store');
  assert.deepEqual(doc.perProject.map((pp) => pp.project).sort(), ['R A', 'R B', 'R C'],
    'every project must reach the report through the sharded store');
  console.log('ok 71 - report and stats read the sharded store with no packed file present');
}

// --- 72. readStore keeps its packed shape for the published extension ctx ---
// Case 6 pins that ctx.readStore EXISTS; this pins what it returns. Nothing bundled reads
// records through it since Task 4 - buildReport calls readCollection - so the contract now
// rests on no bundled caller at all, and a future edit could "simplify" readStore into
// returning a bare array with the whole suite still green. Third-party extensions in
// .gtg/commands/ are the real callers, and they index the wrapper key themselves, so
// `readStore('...')?.handoffs ?? []` over a bare array yields [] with no error whatsoever -
// exactly the silence that emptied `report` and `stats`, which case 71 caught from the other
// side. Case 71 is now indifferent to readStore's shape; this case is the only thing holding it.
{
  const repo = tempRepo();
  mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });
  mkdirSync(join(repo, '.gtg/commands'), { recursive: true });
  // Packed on purpose, and written by the FIXTURE rather than left behind by anything gtg
  // does. This used to lean on the startup migration sharding the file and leaving it in
  // place; there is no migration and no packed file in a real hub since 3.3.0, and neither
  // matters to what is under test. readStore is a whole-file JSON reader handed a path by a
  // third-party extension, so what this pins is the SHAPE it returns for whatever file it is
  // given - the one thing a "simplify readStore to a bare array" edit would break silently.
  writeFileSync(join(repo, PACKED_ACTIVE),
    JSON.stringify({ handoffs: [{ project: 'Shape', slug: 'shape', next: 'x' }] }, null, 2) + '\n');
  writeFileSync(join(repo, '.gtg/commands/shape.mjs'),
    `export default ({ readStore }) => {
      const s = readStore('docs/handoffs/_active.json');
      console.log(JSON.stringify({
        isArray: Array.isArray(s),
        wrapped: Array.isArray(s?.handoffs),
        slugs: (s?.handoffs ?? []).map((e) => e.slug),
      }));
    }\n`);

  const r = gtg(repo, ['shape']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.isArray, false,
    'readStore must NOT return a bare array - an extension indexing .handoffs on one gets undefined');
  assert.equal(out.wrapped, true,
    'readStore must return the packed wrapper object, so `readStore(rel)?.handoffs` resolves');
  assert.deepEqual(out.slugs, ['shape'], 'and the records inside it must be reachable');
  console.log('ok 72 - readStore keeps its packed shape on the published extension ctx');
}

// --- 73. resume fast-forwards from the mirror BEFORE it reads the store ---
// The sync's whole value is its POSITION. It first shipped in .gtg/after-resume.mjs, which runs
// after entries() has read, the handoff has printed and the consume has committed, so it could
// only ever succeed when there was nothing to pull (2026-09-01, docs/runbooks/git-parity.md).
// So this case pins the ordering rather than the call: the resumed record exists ONLY in the
// commit sitting on the mirror, which makes it resolvable if and only if the fetch already ran.
// A fetch anywhere after the read cannot make this pass, which is exactly the property wanted.
//
// A local bare repo stands in for a Forgejo server: same git, no network.
{
  const mirror = mkdtempSync(join(tmpdir(), 'gtg-mirror-'));
  execSync('git init -q --bare -b master', { cwd: mirror });
  const url = mirror.split('\\').join('/');
  const fromMirror = (dir, sh) => execSync(sh, { cwd: dir, encoding: 'utf8' }).trim();

  // The hub, on master: the branch the sync fast-forwards, and the branch home actually sits on.
  const repo = tempRepo();
  execSync('git checkout -q -b master', { cwd: repo });
  assert.equal(gtg(repo, HANDOFF_ARGS('local-a', 'Local A'), { input: BODY }).status, 0);
  assert.equal(gtg(repo, HANDOFF_ARGS('local-c', 'Local C'), { input: BODY }).status, 0);
  const FALLBACK = { GTG_SYNC_REMOTE: 'backup', GTG_SYNC_BRANCH: 'master' };
  execSync(`git remote add backup "${url}"`, { cwd: repo });
  execSync('git push -q backup master', { cwd: repo });
  // No -u, deliberately: this fixture is HOME's shape, where nothing sets branch.*.remote, so
  // the whole case runs down the fallback pair, GTG_SYNC_REMOTE/GTG_SYNC_BRANCH set by FALLBACK
  // to backup/master. Case 74 covers the upstream lookup that comes first. Asserted, not
  // assumed - a push that quietly set an
  // upstream would move this case onto the other path and neither would be tested twice over.
  assert.throws(() => execSync('git config --get branch.master.remote', { cwd: repo, stdio: 'ignore' }),
    'fixture: master must have NO upstream here, or this stops testing the fallback');

  // The other machine: clone the mirror, wrap a project there, push. The hub has never seen it.
  const other = mkdtempSync(join(tmpdir(), 'gtg-other-'));
  execSync(`git clone -q "${url}" "${other.split('\\').join('/')}"`, { cwd: tmpdir() });
  execSync('git config user.email test@test', { cwd: other });
  execSync('git config user.name test', { cwd: other });
  assert.equal(gtg(other, HANDOFF_ARGS('remote-b', 'Remote B'), { input: BODY }).status, 0);
  execSync('git push -q origin master', { cwd: other });
  assert.ok(!active(repo).some((e) => e.slug === 'remote-b'),
    'fixture: the hub must not hold the record yet, or the case proves nothing');

  const r = gtg(repo, ['resume', 'remote-b'], { env: FALLBACK });
  assert.equal(r.status, 0,
    `resume could not see a record that exists only on the mirror - the fetch ran after the read, or not at all: ${r.stderr}`);
  assert.match(r.stdout, /RESUME: "Remote B"/);
  assert.match(r.stdout, /- stuff/, 'and the handoff BODY came down with it');
  assert.match(r.stdout, /fast-forward/i, 'a real fast-forward is the ONE case that speaks on stdout');

  // Up to date: silence. A line on every resume is noise, and noise is how a real one goes unread.
  // Each later resume here stands for one a while after the last, so the fetch is aged past the
  // one-minute skip (#101, case 74b).
  ageFetchHead(repo);
  const q = gtg(repo, ['resume', 'local-a'], { env: FALLBACK });
  assert.equal(q.status, 0, q.stderr);
  assert.doesNotMatch(q.stdout, /fast-forward/i, 'nothing to pull must say nothing');

  // Diverged: both sides hold commits the other lacks. --ff-only refuses, and refusing is the
  // point - auto-merging a divergence is what caused the 2026-08-02 fork. The resume still
  // runs, on local state, and the notice goes to stderr so stdout keeps its one rule.
  writeFileSync(join(repo, 'local.txt'), 'local only'); // no trailing LF: git's autocrlf warning is not test output
  execSync('git add local.txt', { cwd: repo });
  execSync('git commit -q -m "local only"', { cwd: repo });
  assert.equal(gtg(other, HANDOFF_ARGS('remote-d', 'Remote D'), { input: BODY }).status, 0);
  execSync('git push -q origin master', { cwd: other });
  ageFetchHead(repo);
  const d = gtg(repo, ['resume', 'local-c'], { env: FALLBACK });
  assert.equal(d.status, 0, `a divergence must not fail the resume: ${d.stderr}`);
  assert.match(d.stdout, /RESUME: "Local C"/, 'and it resumes from local state');
  assert.doesNotMatch(d.stdout, /fast-forward/i, 'stdout stays silent when nothing moved');
  assert.match(d.stderr, /will not fast-forward/, 'but a real fork has to surface somewhere');
  assert.ok(!active(repo).some((e) => e.slug === 'remote-d'),
    'and nothing from the diverged mirror was merged in');
  assert.equal(fromMirror(repo, 'git rev-parse --abbrev-ref HEAD'), 'master',
    'no rebase, no detach: the branch is where it was');
  console.log('ok 73 - resume fast-forwards from the mirror before reading the store');
}

// --- 74. the sync target is the branch's own upstream, not a hardcoded pair ---
// The other machine's shape is a CLONE: its remote is `origin`, its branch can be `main`, and neither
// half matches the backup/master pair the first cut named. That made the sync
// one-directional - home pulled the server's work, the server's every resume fetched nothing and said
// nothing - and handing entries BOTH ways is the whole reason the store is git. So the target
// comes from branch.<b>.remote + branch.<b>.merge, and this case stands on the far side of the
// exchange: nothing named backup exists anywhere in it.
{
  const mirror = mkdtempSync(join(tmpdir(), 'gtg-mirror2-'));
  execSync('git init -q --bare -b main', { cwd: mirror });
  const url = mirror.split('\\').join('/');
  const clone = (prefix) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    execSync(`git clone -q "${url}" "${d.split('\\').join('/')}"`, { cwd: tmpdir() });
    execSync('git config user.email test@test', { cwd: d });
    execSync('git config user.name test', { cwd: d });
    return d;
  };

  // Seed the mirror so there is something to clone.
  const seed = tempRepo();
  assert.equal(gtg(seed, HANDOFF_ARGS('seed-a', 'Seed A'), { input: BODY }).status, 0);
  execSync(`git remote add origin "${url}"`, { cwd: seed });
  execSync('git push -q origin main', { cwd: seed });

  const server = clone('gtg-server-');
  assert.equal(execSync('git config --get branch.main.remote', { cwd: server, encoding: 'utf8' }).trim(),
    'origin', 'fixture: a clone tracks origin, which is precisely what the hardcoded pair missed');
  assert.equal(execSync('git rev-parse --abbrev-ref HEAD', { cwd: server, encoding: 'utf8' }).trim(),
    'main', 'fixture: and it is not on master either');
  assert.equal(execSync('git remote', { cwd: server, encoding: 'utf8' }).trim(), 'origin',
    'fixture: no backup remote exists here at all');

  // The laptop wraps a project and pushes. The server has never seen it.
  const laptop = clone('gtg-laptop-');
  assert.equal(gtg(laptop, HANDOFF_ARGS('from-laptop', 'From Laptop'), { input: BODY }).status, 0);
  execSync('git push -q origin main', { cwd: laptop });

  const r = gtg(server, ['resume', 'from-laptop']);
  assert.equal(r.status, 0,
    `the far side of the exchange saw nothing - the target was not resolved from its upstream: ${r.stderr}`);
  assert.match(r.stdout, /RESUME: "From Laptop"/);
  assert.match(r.stdout, /Synced origin\/main: fast-forwarded/,
    'and it names the upstream it actually used, not the fallback pair');

  // A feature branch with no upstream: nothing to resolve, nothing to fall back to, so the sync
  // skips. This is the guard the old branch comparison held, now carried by the lookup itself.
  execSync('git checkout -q -b feat/y', { cwd: server });
  assert.equal(gtg(laptop, HANDOFF_ARGS('later-work', 'Later Work'), { input: BODY }).status, 0);
  execSync('git push -q origin main', { cwd: laptop });
  const f = gtg(server, ['resume', 'seed-a']);
  assert.equal(f.status, 0, f.stderr);
  assert.doesNotMatch(f.stdout, /fast-forward/i, 'a branch with no upstream must not be moved');
  assert.equal(f.stderr, '', 'and must not be narrated either');
  assert.ok(!active(server).some((e) => e.slug === 'later-work'),
    'nothing was pulled onto the feature branch');
  console.log('ok 74 - the sync target comes from the branch upstream, with the named pair as fallback');
}

// --- 74b. #101: a resume within a minute of the last fetch skips the sync, and the fast-forward
// waits out another session's index.lock instead of failing silently. ---
{
  const mirror = mkdtempSync(join(tmpdir(), 'gtg-mirror-'));
  execSync('git init -q --bare -b main', { cwd: mirror });
  const url = mirror.split('\\').join('/');
  const clone = (prefix) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    execSync(`git clone -q "${url}" "${d.split('\\').join('/')}"`, { cwd: tmpdir() });
    execSync('git config user.email test@test', { cwd: d });
    execSync('git config user.name test', { cwd: d });
    return d;
  };
  const seed = tempRepo();
  assert.equal(gtg(seed, HANDOFF_ARGS('seed-a', 'Seed A'), { input: BODY }).status, 0);
  execSync(`git remote add origin "${url}"`, { cwd: seed });
  execSync('git push -q origin main', { cwd: seed });
  const hub = clone('gtg-hub-');
  const laptop = clone('gtg-laptop-');
  const push = (slug) => {
    assert.equal(gtg(laptop, HANDOFF_ARGS(slug, slug), { input: BODY }).status, 0);
    execSync('git push -q origin main', { cwd: laptop });
  };
  const gitCalls = (res, verb) => JSON.parse(res.stderr.match(/^GTG_SPAWNS (.*)$/m)[1])
    .filter((a) => a[0] === 'git' && a[1] === verb);

  push('first');
  const one = gtg(hub, ['resume', 'seed-a'], { spawnLog: true });
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /Synced origin\/main: fast-forwarded/);
  assert.equal(gitCalls(one, 'fetch').length, 1);

  push('second');
  const two = gtg(hub, ['resume', 'seed-a'], { spawnLog: true });
  assert.equal(two.status, 0, two.stderr);
  assert.equal(gitCalls(two, 'fetch').length, 0, 'a second resume within a minute ran another fetch');
  assert.doesNotMatch(two.stdout, /fast-forward/);

  ageFetchHead(hub);
  const three = gtg(hub, ['resume', 'seed-a'], { spawnLog: true, lockMerge: true });
  assert.equal(three.status, 0, three.stderr);
  assert.equal(gitCalls(three, 'fetch').length, 1, 'a fetch over a minute old runs again');
  assert.equal(gitCalls(three, 'merge').length, 2, 'the merge that met index.lock was not retried');
  assert.match(three.stdout, /Synced origin\/main: fast-forwarded/, `the retried fast-forward did not land:\n${three.stderr}`);
  assert.ok(active(hub).some((e) => e.slug === 'second'), 'the pushed record did not come down');
  assert.ok(!existsSync(join(hub, '.git', 'index.lock')), 'fixture: the lock is released');
  console.log('ok 74b - #101: a fresh fetch skips the sync, and the fast-forward retries on index.lock');
}

// --- 76. --dry-run names the record file it WOULD write, in both collections ---
// The whole point of --dry-run is telling the operator which file a handoff is about to write, so
// it is the one output that must not lie about the path. It lied: the preview read
// `COLLECTIONS[which].dir` and COLLECTIONS collapsed to plain directory strings in 3.3.0, so the
// line printed `undefined/<slug>.json` while every other path in the CLI was right. A 19-case
// suite stayed green over it because nothing here had ever run --dry-run at all - `grep -c "DRY
// RUN"` returned 0. Asserted on the LITERAL expected path rather than on the absence of
// "undefined", so the next shape change fails here with the wrong path named rather than passing
// on a differently-wrong one. Both collections, because `which` is the variable that broke.
{
  const repo = tempRepo();
  for (const [args, dir, slug] of [
    [HANDOFF_ARGS('dr-active', 'DR Active'), ACTIVE, 'dr-active'],
    [['backlog', '--project', 'DR Parked', '--slug', 'dr-parked', '--eta', '~1h', '--next', 'TBD'],
      BACKLOG, 'dr-parked'],
  ]) {
    const r = gtg(repo, [...args, '--dry-run'], { input: BODY });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`--- ${dir}/${slug}.json entry ---`),
      `--dry-run must name the record file it would write, got:
${r.stdout}`);
    // The other half of the contract: a preview writes and commits nothing.
    assert.equal(existsSync(join(repo, dir, `${slug}.json`)), false, 'a dry run wrote a record');
    assert.deepEqual(active(repo), [], 'a dry run touched the active store');
    assert.deepEqual(backlog(repo), [], 'a dry run touched the backlog store');
  }
  console.log('ok 76 - --dry-run names the record file it would write, for both collections');
}

// Case 75 lived here: it pinned that the import-time self-migration ran AFTER the resume
// sync, so a second machine on a still-packed tree could not commit its own shard over the
// same records and fork history. Removed in 3.3.0 with the migration itself - there is no
// packed store left to migrate, so the ordering it guarded no longer exists. The sync that
// remains is resumeConsume's, and case 73 pins its position ahead of every read.

// --- 77. rename --name moves the display name, and log still finds the old history ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('jev-ranker', 'Jev for job ranking'), { input: BODY });

  const r = gtg(repo, ['rename', 'jev-ranker', 'memory-router', '--name', 'Memory router', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Renamed: Jev for job ranking -> Memory router \(jev-ranker -> memory-router\)/);

  const e = active(repo).find((x) => x.slug === 'memory-router');
  assert.equal(e.project, 'Memory router', 'the display name moved, not just the slug');
  assert.deepEqual(e.aka, ['Jev for job ranking'], 'the old name is kept, for log');

  // The reason rename left names alone before: `log <slug>` greps commit SUBJECTS for the
  // project name, and every subject written before the rename carries the old one. Renaming
  // without keeping the old name blinds the filtered log to the whole project's history.
  const one = gtg(repo, ['log', 'memory-router']);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /Jev for job ranking/, 'history under the old name still lists');

  // A second rename keeps both prior names, not just the last one.
  gtg(repo, ['rename', 'memory-router', 'router', '--name', 'Router', '--no-list']);
  const e2 = active(repo).find((x) => x.slug === 'router');
  assert.deepEqual(e2.aka, ['Jev for job ranking', 'Memory router']);
  console.log('ok 77 - rename --name moves the display name and log keeps the old history');
}

// --- 78. --name survives the next checkpoint, and a bare rename still leaves the name alone ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('proj-a', 'Project A'), { input: BODY });
  gtg(repo, ['rename', 'proj-a', 'alpha', '--name', 'Alpha', '--no-list']);
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  assert.deepEqual(active(repo).find((x) => x.slug === 'alpha').aka, ['Project A'],
    'a checkpoint rebuilds the entry, so it has to carry aka forward');

  // Omitted, the flag changes nothing: the name is the caller's to move, never inferred
  // from the slug.
  const bare = gtg(repo, ['rename', 'alpha', 'beta', '--no-list']);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /Renamed: Alpha \(alpha -> beta\)/);
  const e = active(repo).find((x) => x.slug === 'beta');
  assert.equal(e.project, 'Alpha', 'a bare rename leaves the display name where it was');
  assert.deepEqual(e.aka, ['Project A'], 'and adds nothing to aka');

  assert.equal(gtg(repo, ['rename', 'beta', 'gamma', '--name']).status, 2,
    '--name with no value is a usage error, not an empty name');
  console.log('ok 78 - --name survives a checkpoint, and a bare rename leaves the name alone');
}

// --- 79. a name-only rename: same slug, new title ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('memory-router', 'Jev for job ranking'), { input: BODY });

  // The common case. A long-lived entry keeps a good slug while its title stops describing the
  // work, and without this the only way through was a rename to a throwaway slug and back.
  const r = gtg(repo, ['rename', 'memory-router', 'memory-router', '--name', 'Memory router', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Renamed: Jev for job ranking -> Memory router \(memory-router\)/);
  assert.doesNotMatch(r.stdout, /projects rename/, 'no portfolio slug moved, so nothing to match');

  const e = active(repo).find((x) => x.slug === 'memory-router');
  assert.equal(e.project, 'Memory router');
  assert.deepEqual(e.aka, ['Jev for job ranking']);
  assert.equal(e.file, 'docs/handoffs/current/memory-router.md', 'the handoff path did not move');
  assert.ok(existsSync(join(repo, e.file)), 'and the file is still there');

  // Without a name to move, the same call is still the no-op it always was.
  const noop = gtg(repo, ['rename', 'memory-router', 'memory-router']);
  assert.equal(noop.status, 2);
  assert.match(noop.stderr, /already its slug/);
  console.log('ok 79 - a name-only rename keeps the slug and the handoff path');
}

// --- 80. a record that does not parse is reported under gtg's name ---
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('solid', 'Solid'), { input: BODY });
  writeFileSync(join(repo, 'docs', 'handoffs', 'active', 'broken.json'), '{');
  const r = gtg(repo, ['list']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /gtg: cannot parse docs\/handoffs\/active\/broken\.json/);
  console.log('ok 80 - a record that does not parse is reported under gtg\'s name');
}

// --- 81. a handoff records the device that wrote it ---
// A worktree path only means something on the machine that has it (2026-10-02: a desktop path resumed
// on the laptop). The header carries a Device line beside Worktree and Branch, and the record carries
// the field, so resume can name where the work lives. Both verbs that write a handoff.
{
  const repo = tempRepo();
  const here = hostname().toLowerCase();
  const dry = gtg(repo, [...HANDOFF_ARGS('dev', 'Dev'), '--dry-run'], { input: BODY });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`\nWorktree: .*\nBranch: .*\nDevice: ${here}\n`), dry.stdout);
  assert.match(dry.stdout, new RegExp(`"device": "${here}"`));
  assert.equal(gtg(repo, HANDOFF_ARGS('dev', 'Dev'), { input: BODY }).status, 0);
  assert.equal(active(repo).find((x) => x.slug === 'dev').device, here);
  assert.match(readFileSync(join(repo, 'docs/handoffs/current/dev.md'), 'utf8'), new RegExp(`\nDevice: ${here}\n`));
  const parked = gtg(repo, ['backlog', '--project', 'Idea', '--slug', 'idea', '--next', 'later'], { input: BODY });
  assert.equal(parked.status, 0, parked.stderr);
  assert.equal(backlog(repo).find((x) => x.slug === 'idea').device, here);
  console.log('ok 81 - a handoff records the device that wrote it');
}

console.log('ALL PASS (part 6)');
