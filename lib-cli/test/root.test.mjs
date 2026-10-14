import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitTop, hubRoot, configuredRoot } from '../root.mjs';

const same = (a, b) => {
  const n = (p) => resolve(realpathSync.native(p));
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), 'libcli-root-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  return d;
};

test('gitTop returns the toplevel of the repo that holds cwd', () => {
  const d = repo();
  assert.ok(same(gitTop(d), d));
});

test('gitTop returns null for a folder that does not exist', () => {
  assert.equal(gitTop(join(tmpdir(), 'libcli-no-such-folder-8c1f')), null);
});

test('hubRoot prefers a set variable, and an empty one falls through to git', () => {
  const d = repo();
  assert.equal(hubRoot('X_HUB', { env: { X_HUB: 'C:/somewhere' }, cwd: d }), 'C:/somewhere');
  assert.ok(same(hubRoot('X_HUB', { env: { X_HUB: '' }, cwd: d }), d));
  assert.ok(same(hubRoot('X_HUB', { env: {}, cwd: d }), d));
  assert.equal(hubRoot('X_HUB', { env: {}, cwd: join(tmpdir(), 'libcli-no-such-folder-8c1f') }), null);
});

test('projects persisted root works for existing processes, with environment taking precedence', () => {
  const home = repo(); mkdirSync(join(home, '.projects'));
  writeFileSync(join(home, '.projects/store.json'), JSON.stringify({ root: 'C:/dev/projects-store' }));
  assert.equal(configuredRoot('PROJECTS_ROOT', { env: {}, home }), 'C:/dev/projects-store');
  assert.equal(configuredRoot('PROJECTS_ROOT', { env: { PROJECTS_ROOT: 'override' }, home }), 'override');
  assert.equal(configuredRoot('GTG_HUB', { env: {}, home }), null);
});
