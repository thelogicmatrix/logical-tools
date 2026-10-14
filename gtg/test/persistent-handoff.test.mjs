import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCollection } from '../skills/gtg/lib/store.mjs';
import { perProject, readDurations } from '../skills/gtg/extensions/lib/history.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');
const ACTIVE = 'docs/handoffs/active';
const BACKLOG = 'docs/handoffs/backlog';
const BODY = '## What Was Done This Session\n- checkpoint\n\n## Next Action\nContinue\n';

function hub() {
  const root = mkdtempSync(join(tmpdir(), 'gtg-persistent-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  appendFileSync(join(root, '.git', 'config'), '\n[user]\n\temail = test@test\n\tname = test\n');
  return root;
}

function gtg(root, args, input = '') {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      GTG_HUB: root,
      GTG_NO_SYNC: '1',
      GTG_SESSION_ID: 'persistent-test',
      GIT_CEILING_DIRECTORIES: tmpdir(),
    },
  });
}

function handoff(root, slug = 'alpha', project = 'Alpha', body = BODY) {
  return gtg(root, ['handoff', '--project', project, '--slug', slug, '--next', 'Continue'], body);
}

const active = (root) => readCollection(root, ACTIVE);
const backlog = (root) => readCollection(root, BACKLOG);

test('one canonical handoff path is updated by every checkpoint and git retains each checkpoint event', () => {
  const root = hub();
  let result = handoff(root);
  assert.equal(result.status, 0, result.stderr);
  const path = result.stdout.split('\n').find((line) => line.startsWith('docs/handoffs/'));
  assert.equal(path, 'docs/handoffs/current/alpha.md');
  assert.equal(active(root)[0].sessions, 1);

  result = handoff(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\n').find((line) => line.startsWith('docs/handoffs/')), path);
  assert.equal(active(root)[0].sessions, 2);
  assert.deepEqual(readdirSync(join(root, 'docs', 'handoffs', 'current')), ['alpha.md']);
  const subjects = execFileSync('git', ['log', '--format=%s', '--', ACTIVE, path], { cwd: root, encoding: 'utf8' })
    .trim().split('\n');
  assert.deepEqual(subjects, ['handoff: Alpha - session 2', 'handoff: Alpha - session 1']);
});

test('resume repeatedly reads the current handoff without consuming active or shelved work', () => {
  const root = hub();
  assert.equal(handoff(root).status, 0);
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  for (const args of [['resume', 'alpha'], ['resume', 'alpha', '--keep']]) {
    const result = gtg(root, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESUME: "Alpha"/);
    assert.match(result.stdout, /Kept: Alpha \(current handoff retained\)/);
    assert.equal(active(root).length, 1);
  }
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), before);

  assert.equal(gtg(root, ['back', 'alpha', '--no-list']).status, 0);
  const shelved = gtg(root, ['resume', 'alpha']);
  assert.equal(shelved.status, 0, shelved.stderr);
  assert.match(shelved.stdout, /Kept on backlog: Alpha \(current handoff retained\)/);
  assert.equal(backlog(root).length, 1);
});

test('complete explicitly clears an entry but leaves its handoff and independent progress record', () => {
  const root = hub();
  assert.equal(handoff(root).status, 0);
  const init = gtg(root, [
    'progress', 'init', 'alpha', '--project', 'Alpha', '--plan', 'docs/plans/alpha.md',
  ], JSON.stringify([{ id: 'task-1', purpose: 'Still pending' }]));
  assert.equal(init.status, 0, init.stderr);
  const path = active(root)[0].file;

  const result = gtg(root, ['complete', 'alpha', '--no-list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Completed: Alpha/);
  assert.equal(active(root).length, 0);
  assert.equal(existsSync(join(root, path)), true);
  const progress = JSON.parse(readFileSync(join(root, 'docs', 'handoffs', 'progress', 'alpha.json'), 'utf8'));
  assert.equal(progress.tasks[0].status, 'pending');
  assert.match(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' }),
    /^gtg prune: remove Alpha - confirmed done/);
});

test('list is read-only and never auto-shelves stale active work', () => {
  const root = hub();
  assert.equal(handoff(root).status, 0);
  const file = join(root, ACTIVE, 'alpha.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.updated = '2020-01-01T00:00:00+00:00';
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  execFileSync('git', ['add', '--', ACTIVE], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'test: age active record'], { cwd: root });
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const result = gtg(root, ['list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Alpha/);
  assert.doesNotMatch(result.stdout, /shelves in|Auto-shelved/);
  assert.equal(active(root).length, 1);
  assert.equal(backlog(root).length, 0);
  // The one write is the review's stamp on the entry it asked about.
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: root, encoding: 'utf8' }).trim(), before);
  assert.match(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' }), /^gtg nudge: Alpha/);
});

test('a valid legacy dated handoff path is reused and old legacy files are preserved', () => {
  const root = hub();
  const legacy = 'docs/handoffs/2026-09-01-0900-alpha.md';
  mkdirSync(join(root, 'docs', 'handoffs'), { recursive: true });
  writeFileSync(join(root, legacy), '# Handoff: Alpha\n\nold body\n');
  mkdirSync(join(root, ACTIVE), { recursive: true });
  writeFileSync(join(root, ACTIVE, 'alpha.json'), JSON.stringify({
    project: 'Alpha', slug: 'alpha', next: 'old', file: legacy,
    created: '2026-09-01T09:00:00+08:00', updated: '2026-09-01T09:00:00+08:00',
  }, null, 2) + '\n');
  execFileSync('git', ['add', '--', 'docs/handoffs'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'test: legacy handoff'], { cwd: root });

  const result = handoff(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\n').find((line) => line.startsWith('docs/handoffs/')), legacy);
  assert.match(readFileSync(join(root, legacy), 'utf8'), /checkpoint/);
  assert.equal(active(root)[0].sessions, 2);
  assert.equal(existsSync(join(root, 'docs', 'handoffs', 'current', 'alpha.md')), false);
});

test('an unsafe or unrelated stored file path is never overwritten', () => {
  const root = hub();
  writeFileSync(join(root, 'README.md'), 'leave me alone\n');
  mkdirSync(join(root, ACTIVE), { recursive: true });
  writeFileSync(join(root, ACTIVE, 'alpha.json'), JSON.stringify({
    project: 'Alpha', slug: 'alpha', next: 'old', file: 'README.md', sessions: 4,
    created: '2026-09-01T09:00:00+08:00', updated: '2026-09-01T09:00:00+08:00',
  }, null, 2) + '\n');
  execFileSync('git', ['add', '--', 'README.md', ACTIVE], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'test: malformed legacy record'], { cwd: root });

  const result = handoff(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(active(root)[0].file, 'docs/handoffs/current/alpha.md');
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'leave me alone\n');
});

test('checkpoint handoffs do not double-count cumulative session duration', () => {
  const root = hub();
  mkdirSync(join(root, 'docs', 'handoffs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'handoffs', '_session.json'), JSON.stringify({
    sessions: { [root]: new Date(Date.now() - 10 * 60_000).toISOString() },
  }, null, 2) + '\n');

  let result = gtg(root, [
    'handoff', '--project', 'Alpha', '--slug', 'alpha', '--next', 'Continue', '--checkpoint',
  ], BODY);
  assert.equal(result.status, 0, result.stderr);
  assert.equal('duration_min' in active(root)[0], false);
  assert.equal(readDurations(root).sessionsTimed, 0);

  result = handoff(root);
  assert.equal(result.status, 0, result.stderr);
  const duration = active(root)[0].duration_min;
  assert.ok(duration >= 9 && duration <= 11, `unexpected duration: ${duration}`);
  const history = readDurations(root);
  assert.equal(history.sessionsTimed, 1);
  assert.equal(history.total, duration);
});

test('renaming a current handoff moves its canonical path before the old slug is reused', () => {
  const root = hub();
  assert.equal(handoff(root, 'alpha', 'Old work', BODY.replace('checkpoint', 'OLD BODY')).status, 0);
  const renamed = gtg(root, ['rename', 'alpha', 'beta', '--no-list']);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.equal(active(root).find((entry) => entry.slug === 'beta').file,
    'docs/handoffs/current/beta.md');

  const fresh = gtg(root, [
    'handoff', '--project', 'New work', '--slug', 'alpha', '--next', 'Continue', '--exact',
  ], BODY.replace('checkpoint', 'NEW BODY'));
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(active(root).map((entry) => entry.file).sort(), [
    'docs/handoffs/current/alpha.md',
    'docs/handoffs/current/beta.md',
  ]);
  assert.match(gtg(root, ['resume', 'beta']).stdout, /OLD BODY/);
  assert.match(gtg(root, ['resume', 'alpha']).stdout, /NEW BODY/);
  const oldHistory = execFileSync('git', [
    'log', '--follow', '--format=%s', '--', 'docs/handoffs/current/beta.md',
  ], { cwd: root, encoding: 'utf8' });
  assert.match(oldHistory, /handoff: Old work - session 1/);
});

test('stored checkpoint count overrides legacy filename count in project history', () => {
  const events = [1, 2, 3].map((sessions) => ({
    date: `2026-09-0${sessions}T09:00:00+08:00`, type: 'handoff',
    project: 'Alpha', slug: 'alpha', sessions,
  }));
  const legacyFiles = [{ date: '2026-09-01', hour: 9, slug: 'alpha' }];
  const rows = perProject(events, legacyFiles, [{
    project: 'Alpha', slug: 'alpha', sessions: 3, updated: '2026-09-03T09:00:00+08:00',
  }], []);
  assert.equal(rows[0].sessions, 3);
});

test('rename refuses a slug with bound progress before mutating either record', () => {
  const root = hub();
  assert.equal(handoff(root).status, 0);
  const initialized = gtg(root, [
    'progress', 'init', 'alpha', '--project', 'Alpha', '--plan', 'docs/plans/alpha.md',
  ], JSON.stringify([{ id: 'task-1', purpose: 'Keep identity stable' }]));
  assert.equal(initialized.status, 0, initialized.stderr);
  const activePath = join(root, ACTIVE, 'alpha.json');
  const progressPath = join(root, 'docs', 'handoffs', 'progress', 'alpha.json');
  const before = [readFileSync(activePath, 'utf8'), readFileSync(progressPath, 'utf8')];

  const result = gtg(root, ['rename', 'alpha', 'beta', '--no-list']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /progress.*alpha.*cannot rename/i);
  assert.deepEqual([readFileSync(activePath, 'utf8'), readFileSync(progressPath, 'utf8')], before);
  assert.equal(existsSync(join(root, ACTIVE, 'beta.json')), false);
});

test('rename refuses a case-insensitive target progress collision before mutation', () => {
  const root = hub();
  assert.equal(handoff(root).status, 0);
  const initialized = gtg(root, [
    'progress', 'init', 'BeTa', '--project', 'Other work', '--plan', 'docs/plans/other.md',
  ], JSON.stringify([{ id: 'other-1', purpose: 'Unrelated tasks' }]));
  assert.equal(initialized.status, 0, initialized.stderr);
  const activePath = join(root, ACTIVE, 'alpha.json');
  const before = readFileSync(activePath, 'utf8');

  const result = gtg(root, ['rename', 'alpha', 'beta', '--no-list']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /progress.*BeTa.*cannot rename/i);
  assert.equal(readFileSync(activePath, 'utf8'), before);
  assert.equal(existsSync(join(root, ACTIVE, 'beta.json')), false);
  assert.equal(existsSync(join(root, 'docs', 'handoffs', 'current', 'alpha.md')), true);
});

test('rename rejects leading punctuation before moving a canonical handoff', () => {
  const root = hub();
  assert.equal(handoff(root).status, 0);
  const activePath = join(root, ACTIVE, 'alpha.json');
  const handoffPath = join(root, 'docs', 'handoffs', 'current', 'alpha.md');
  const before = [readFileSync(activePath, 'utf8'), readFileSync(handoffPath, 'utf8')];
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  for (const slug of ['_bad', '.bad', '-bad']) {
    const result = gtg(root, ['rename', 'alpha', slug, '--no-list']);
    assert.equal(result.status, 2, `rename unexpectedly accepted ${slug}`);
    assert.match(result.stderr, /must start with a letter or digit/);
    assert.deepEqual([readFileSync(activePath, 'utf8'), readFileSync(handoffPath, 'utf8')], before);
    assert.equal(existsSync(join(root, ACTIVE, `${slug}.json`)), false);
    assert.equal(existsSync(join(root, 'docs', 'handoffs', 'current', `${slug}.md`)), false);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head);
  }
});

test('rename rejects case-insensitive store collisions before moving either handoff', () => {
  const root = hub();
  assert.equal(handoff(root).status, 0);
  const legacy = 'docs/handoffs/2026-09-01-0900-beta.md';
  writeFileSync(join(root, legacy), '# Handoff: Existing beta\n');
  mkdirSync(join(root, ACTIVE), { recursive: true });
  writeFileSync(join(root, ACTIVE, 'beta.json'), JSON.stringify({
    project: 'Existing beta', slug: 'beta', sessions: 1, next: 'Keep', file: legacy,
    created: '2026-09-01T09:00:00+08:00', updated: '2026-09-01T09:00:00+08:00',
  }, null, 2) + '\n');
  execFileSync('git', ['add', '--', ACTIVE, legacy], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'test: existing beta'], { cwd: root });
  const alphaRecord = join(root, ACTIVE, 'alpha.json');
  const betaRecord = join(root, ACTIVE, 'beta.json');
  const alphaBody = join(root, 'docs', 'handoffs', 'current', 'alpha.md');
  const before = [alphaRecord, betaRecord, alphaBody, join(root, legacy)]
    .map((file) => readFileSync(file, 'utf8'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const result = gtg(root, ['rename', 'alpha', 'BeTa', '--no-list']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /already used by another project/);
  assert.deepEqual([alphaRecord, betaRecord, alphaBody, join(root, legacy)]
    .map((file) => readFileSync(file, 'utf8')), before);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head);
});

test('rename fails closed when the progress directory cannot be inspected', () => {
  const root = hub();
  assert.equal(handoff(root).status, 0);
  writeFileSync(join(root, 'docs', 'handoffs', 'progress'), 'not a directory\n');
  execFileSync('git', ['add', '--', 'docs/handoffs/progress'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'test: unreadable progress location'], { cwd: root });
  const activePath = join(root, ACTIVE, 'alpha.json');
  const handoffPath = join(root, 'docs', 'handoffs', 'current', 'alpha.md');
  const before = [readFileSync(activePath, 'utf8'), readFileSync(handoffPath, 'utf8')];
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const result = gtg(root, ['rename', 'alpha', 'beta', '--no-list']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot inspect progress records/);
  assert.deepEqual([readFileSync(activePath, 'utf8'), readFileSync(handoffPath, 'utf8')], before);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head);
});

test('handoff rejects an invalid slug before changing an existing line or git head', () => {
  const root = hub();
  assert.equal(handoff(root).status, 0);
  const activePath = join(root, ACTIVE, 'alpha.json');
  const handoffPath = join(root, 'docs', 'handoffs', 'current', 'alpha.md');
  const before = [readFileSync(activePath, 'utf8'), readFileSync(handoffPath, 'utf8')];
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const result = handoff(root, '_bad', 'Invalid work');
  assert.equal(result.status, 2);
  assert.deepEqual([readFileSync(activePath, 'utf8'), readFileSync(handoffPath, 'utf8')], before);
  assert.equal(existsSync(join(root, 'docs', 'handoffs', 'current', '_bad.md')), false);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head);
});

test('undo restores the prior persistent body and only paths from its handoff commit', () => {
  const root = hub();
  assert.equal(handoff(root, 'alpha', 'Alpha', BODY.replace('checkpoint', 'OLD BODY')).status, 0);
  assert.equal(handoff(root, 'beta', 'Beta', BODY.replace('checkpoint', 'BETA BODY')).status, 0);
  const betaPath = join(root, 'docs', 'handoffs', 'current', 'beta.md');
  const betaBefore = readFileSync(betaPath, 'utf8');
  assert.equal(handoff(root, 'alpha', 'Alpha', BODY.replace('checkpoint', 'NEW BODY')).status, 0);

  const result = gtg(root, ['undo', '--no-list']);
  assert.equal(result.status, 0, result.stderr);
  const alpha = active(root).find((entry) => entry.slug === 'alpha');
  assert.equal(alpha.sessions, 1);
  const resumed = gtg(root, ['resume', 'alpha']);
  assert.match(resumed.stdout, /OLD BODY/);
  assert.doesNotMatch(resumed.stdout, /NEW BODY/);
  assert.equal(readFileSync(betaPath, 'utf8'), betaBefore,
    'undo must not restore another handoff path that the anchor commit did not touch');
});

test('undo refuses before store mutation when the current handoff body is dirty', () => {
  const root = hub();
  assert.equal(handoff(root, 'alpha', 'Alpha', BODY.replace('checkpoint', 'OLD BODY')).status, 0);
  assert.equal(handoff(root, 'alpha', 'Alpha', BODY.replace('checkpoint', 'NEW BODY')).status, 0);
  const activePath = join(root, ACTIVE, 'alpha.json');
  const handoffPath = join(root, 'docs', 'handoffs', 'current', 'alpha.md');
  writeFileSync(handoffPath, 'UNCOMMITTED BODY\n');
  const recordBefore = readFileSync(activePath, 'utf8');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const result = gtg(root, ['undo', '--no-list']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /handoff body has uncommitted changes/);
  assert.equal(readFileSync(activePath, 'utf8'), recordBefore);
  assert.equal(readFileSync(handoffPath, 'utf8'), 'UNCOMMITTED BODY\n');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head);
});

test('undo refuses when a later commit changed only the persistent handoff body', () => {
  const root = hub();
  assert.equal(handoff(root, 'alpha', 'Alpha', BODY.replace('checkpoint', 'OLD BODY')).status, 0);
  const activePath = join(root, ACTIVE, 'alpha.json');
  const handoffPath = join(root, 'docs', 'handoffs', 'current', 'alpha.md');
  writeFileSync(handoffPath, 'LATER COMMITTED BODY\n');
  execFileSync('git', ['add', '--', 'docs/handoffs/current/alpha.md'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'docs: later body edit'], { cwd: root });
  const before = [readFileSync(activePath, 'utf8'), readFileSync(handoffPath, 'utf8')];
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const result = gtg(root, ['undo', '--no-list']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /handoff body changed after the store commit/);
  assert.deepEqual([readFileSync(activePath, 'utf8'), readFileSync(handoffPath, 'utf8')], before);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head);
});

test('undo of a rename restores the original slug and canonical path together', () => {
  const root = hub();
  assert.equal(handoff(root, 'alpha', 'Alpha').status, 0);
  assert.equal(gtg(root, ['rename', 'alpha', 'beta', '--no-list']).status, 0);
  assert.equal(existsSync(join(root, 'docs', 'handoffs', 'current', 'alpha.md')), false);

  const result = gtg(root, ['undo', '--no-list']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(active(root).map((entry) => entry.slug), ['alpha']);
  assert.equal(active(root)[0].file, 'docs/handoffs/current/alpha.md');
  assert.equal(existsSync(join(root, 'docs', 'handoffs', 'current', 'alpha.md')), true);
  assert.equal(existsSync(join(root, 'docs', 'handoffs', 'current', 'beta.md')), false);
  assert.match(gtg(root, ['resume', 'alpha']).stdout, /checkpoint/);
});

test('help documents checkpoint hook intent on the existing handoff command', () => {
  const root = hub();
  const result = gtg(root, ['help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--checkpoint.*current handoff.*hook/i);
});

test('gtg learn never warns that a stale sprint auto-shelves, because list no longer shelves anything', () => {
  const root = hub();
  const r = gtg(root, ['handoff', '--project', 'Learning: Go', '--slug', 'learning-go', '--next', 'Continue', '--parent', 'learning'], BODY);
  assert.equal(r.status, 0, r.stderr);
  const file = join(root, ACTIVE, 'learning-go.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.updated = new Date(Date.now() - 10 * 86400000).toISOString();
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  const learn = gtg(root, ['learn']);
  assert.equal(learn.status, 0, learn.stderr);
  assert.match(learn.stdout, /Learning: Go \(learning-go\).*\(10d ago\)/);
  assert.doesNotMatch(learn.stdout, /auto-shel|auto-park/i);
});
