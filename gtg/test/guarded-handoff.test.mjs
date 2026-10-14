// Guarded handoffs must fail before any body, progress, record or git mutation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CLI, tempRepo, gtg, HANDOFF_ARGS, BODY, active } from './gtg-harness.mjs';

const digest = (body) => createHash('sha256').update(body, 'utf8').digest('hex');
const guard = (record) => ['--expected-body-sha256', digest(record.handoff), '--expected-shelf', record.shelf];
const read = (root) => JSON.parse(gtg(root, ['list', '--json']).stdout).active[0];
function snapshot(root) {
  const files = {};
  const walk = (dir) => {
    if (!existsSync(join(root, dir))) return;
    for (const name of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${name.name}`;
      if (name.isDirectory()) walk(path);
      else files[path] = readFileSync(join(root, path)).toString('base64');
    }
  };
  walk('docs/handoffs');
  return { files, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }),
    status: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }) };
}
function fixture(t) {
  const root = tempRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = gtg(root, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  return root;
}

test('version discovery runs outside a hub and identifies guarded handoff support', () => {
  const r = spawnSync(process.execPath, [CLI, '--version'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, GTG_HUB: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\r?\n$/);
  const [major, minor, patch] = r.stdout.trim().split('.').map(Number);
  assert.ok(major > 4 || major === 4 && (minor > 8 || minor === 8 && patch >= 1));
});

test('guarded handoff updates an unchanged exact record using the JSON body', (t) => {
  const root = fixture(t);
  const record = read(root);
  const r = gtg(root, [...HANDOFF_ARGS('alpha', 'Alpha'), '--next', 'Guarded next', ...guard(record)], { input: '## Next Action\nGuarded next\n' });
  assert.equal(r.status, 0, r.stderr);
  const next = read(root);
  assert.equal(next.sessions, record.sessions + 1);
  assert.equal(next.next, 'Guarded next');
  assert.match(next.handoff, /Guarded next/);
});

test('invalid, partial and stale handoff guards reject without any mutation', (t) => {
  const root = fixture(t);
  const record = read(root);
  const hash = digest(record.handoff);
  const cases = [
    ['--expected-body-sha256', '0'.repeat(64), '--expected-shelf', 'active'],
    ['--expected-body-sha256', hash, '--expected-shelf', 'backlog'],
    ['--expected-body-sha256', hash], ['--expected-shelf', 'active'],
    ['--expected-body-sha256', '--expected-shelf', 'active'],
    ['--expected-body-sha256', 'not-a-hash', '--expected-shelf', 'active'],
    ['--expected-body-sha256', hash, '--expected-shelf'],
    ['--expected-body-sha256', hash, '--expected-shelf', 'closed'],
  ];
  for (const flags of cases) {
    const before = snapshot(root);
    const r = gtg(root, [...HANDOFF_ARGS('alpha', 'Alpha'), ...flags, '--wip'], { input: BODY });
    assert.equal(r.status, 2, `${flags.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /stuff|What Was Done/);
    assert.deepEqual(snapshot(root), before);
  }
});

test('a handoff changed after the caller read is preserved and rejects the old hash', (t) => {
  const root = fixture(t);
  const old = read(root);
  assert.equal(gtg(root, HANDOFF_ARGS('alpha', 'Alpha'), { input: '## Next Action\nNewer notes\n' }).status, 0);
  const before = snapshot(root);
  const r = gtg(root, [...HANDOFF_ARGS('alpha', 'Alpha'), ...guard(old)], { input: BODY });
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(snapshot(root), before);
});

test('missing, closed and ambiguous exact slugs reject without creating a body', (t) => {
  const root = fixture(t);
  const record = read(root);
  for (const slug of ['missing', 'Alpha', 'alph']) {
    const before = snapshot(root);
    assert.equal(gtg(root, [...HANDOFF_ARGS(slug, 'Alpha'), ...guard(record)], { input: BODY }).status, 2);
    assert.deepEqual(snapshot(root), before);
  }
  // A duplicate exact slug across shelves cannot lend authority to either record.
  mkdirSync(join(root, 'docs/handoffs/backlog'), { recursive: true });
  writeFileSync(join(root, 'docs/handoffs/backlog/alpha.json'), JSON.stringify(active(root)[0]));
  const before = snapshot(root);
  assert.equal(gtg(root, [...HANDOFF_ARGS('alpha', 'Alpha'), ...guard(record)], { input: BODY }).status, 2);
  assert.deepEqual(snapshot(root), before);
  rmSync(join(root, 'docs/handoffs/backlog/alpha.json'));
  assert.equal(gtg(root, ['complete', 'alpha', '--no-list']).status, 0);
  const closed = snapshot(root);
  assert.equal(gtg(root, [...HANDOFF_ARGS('alpha', 'Alpha'), ...guard(record)], { input: BODY }).status, 2);
  assert.deepEqual(snapshot(root), closed);
});

test('an exact backlog guard retains ordinary handoff reactivation semantics', (t) => {
  const root = fixture(t);
  assert.equal(gtg(root, ['back', 'alpha', '--no-list']).status, 0);
  const record = JSON.parse(gtg(root, ['list', '--json']).stdout).backlog[0];
  const r = gtg(root, [...HANDOFF_ARGS('alpha', 'Alpha'), ...guard(record)], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(root).shelf, 'active');
});
