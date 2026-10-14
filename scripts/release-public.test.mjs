// scripts/release-public.mjs against throwaway repos: a bare "public" remote and a private clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { release } from './release-public.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } }).trim();
const put = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const commitAll = (root, msg) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', msg); };

// Made-up private terms, so nothing real is named here.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'rel-'));
  const terms = join(dir, 'terms.txt');
  writeFileSync(terms, 'machine name | \\bhal9000\\b\n');
  const pub = join(dir, 'public.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', pub);
  const root = join(dir, 'private');
  git(dir, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.email', 'a@example.invalid');
  git(root, 'config', 'user.name', 'A');
  git(root, 'remote', 'add', 'github', pub);
  put(root, 'README.md', '# tools\n');
  put(root, 'gtg/.claude-plugin/plugin.json', '{"version":"1.0.0"}\n');
  commitAll(root, 'first, reviewed at http://forge.example.invalid/x');
  git(root, 'push', '-q', 'github', 'main');
  return { root, pub, env: { PUBLIC_TREE_TERMS: terms } };
}
const run = (s, opts = {}) => {
  const lines = [];
  const commit = release({ root: s.root, env: s.env, log: (l) => lines.push(l), ...opts });
  return { commit, out: lines.join('\n') };
};

test('a release is one new commit on the public main, minus excluded paths, with a clean message', () => {
  const s = setup();
  put(s.root, 'internal/notes.md', 'deployed on hal9000\n');
  put(s.root, '.public-exclude', '# never public\ninternal/\n');
  put(s.root, 'gtg/.claude-plugin/plugin.json', '{"version":"1.1.0"}\n');
  commitAll(s.root, 'more, reviewed at http://forge.example.invalid/y');

  const { commit, out } = run(s);
  assert.match(out, /scan clean, excluded: internal\//);
  assert.match(out, /not pushed/);
  assert.equal(git(s.root, 'rev-parse', `${commit}^`), git(s.root, 'rev-parse', 'github/main'));
  const files = git(s.root, 'ls-tree', '-r', '--name-only', commit).split('\n');
  assert.ok(!files.includes('internal/notes.md'));
  const msg = git(s.root, 'log', '-1', '--format=%B', commit);
  assert.match(msg, /^Release \d{4}-\d{2}-\d{2}\n\ngtg 1\.1\.0\n\nRelease-Source: [0-9a-f]{40}\nRelease-Tree: [0-9a-f]{40}$/);
  assert.equal(git(s.pub, 'rev-parse', 'main'), git(s.root, 'rev-parse', 'github/main'), 'nothing pushed without --push');

  run(s, { push: true });
  assert.equal(git(s.pub, 'log', '-1', '--format=%s', 'main'), msg.split('\n')[0]);
  assert.match(run(s).out, /nothing to release/);

  // After a release the public main is no ancestor, so the next one goes by the recorded tree.
  put(s.root, 'gtg/README.md', 'new\n');
  commitAll(s.root, 'next');
  assert.ok(run(s).commit);
});

test('a private term or generic match anywhere kept refuses, naming the line', () => {
  const s = setup();
  // Assembled at runtime, so this file holds no literal address for the real scan to find.
  const ip = ['100', '70', '1', '2'].join('.');
  put(s.root, 'gtg/x.mjs', `const HOST = 'hal9000'\nconst IP = '${ip}'\n`);
  commitAll(s.root, 'leak');
  assert.throws(() => run(s), /2 private match\(es\):\ngtg\/x\.mjs:1: machine name.*\ngtg\/x\.mjs:2: Tailscale address/);
});

test('refuses without the private terms, with a dirty tree, or after a web edit to the public main', () => {
  const s = setup();
  assert.throws(() => run(s, { env: { PUBLIC_TREE_TERMS: join(s.root, 'none.txt') } }), /no private terms at/);

  put(s.root, 'dirty.md', 'x\n');
  assert.throws(() => run(s), /uncommitted changes/);
  git(s.root, 'clean', '-fq');

  const web = join(dirname(s.root), 'web');
  git(dirname(s.root), 'clone', '-q', s.pub, web);
  git(web, 'config', 'user.email', 'a@example.invalid');
  git(web, 'config', 'user.name', 'A');
  put(web, 'README.md', '# tools, typo fixed\n');
  commitAll(web, 'web edit');
  git(web, 'push', '-q', 'origin', 'main');
  assert.throws(() => run(s), /neither a release nor in/);
});
