import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { syncStore } from '../skills/logical-projects/store-sync.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', PROJECTS_STORE_SYNC: '1' },
}).trim();
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'projects-forge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git'), a = join(dir, 'a'), b = join(dir, 'b');
  mkdirSync(remote); git(remote, 'init', '--bare', '--initial-branch=main');
  mkdirSync(a); git(a, 'init', '--initial-branch=main');
  const identity = root => { git(root, 'config', 'user.name', 'Store Test'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'core.autocrlf', 'false'); };
  identity(a);
  mkdirSync(join(a, 'docs/projects/entries'), { recursive: true });
  writeFileSync(join(a, '.projects-store.json'), '{"version":1}\n');
  writeFileSync(join(a, '.gitattributes'), 'docs/projects/INDEX.md -merge\ndocs/projects/entries/*.json -text\n');
  writeFileSync(join(a, 'docs/projects/entries/.gitkeep'), '');
  writeFileSync(join(a, 'docs/projects/INDEX.md'), 'empty initial index\n');
  git(a, 'add', '.'); git(a, 'commit', '-m', 'initial');
  git(a, 'remote', 'add', 'origin', remote); git(a, 'push', '-u', 'origin', 'main');
  git(dir, '-c', 'core.autocrlf=false', 'clone', remote, b); identity(b);
  assert.equal(git(b, 'status', '--porcelain'), '', 'fixture clone must start clean');
  return { dir, remote, a, b };
}
function add(root, slug, name = slug) {
  writeFileSync(join(root, `docs/projects/entries/${slug}.json`), JSON.stringify({ slug, name, page: `${slug}.md`, theme: 'tooling', status: 'active', where: '', repo: '', lastTouched: '2026-10-06' }) + '\n');
  writeFileSync(join(root, 'docs/projects/INDEX.md'), `generated ${slug} ${name}\n`);
  git(root, 'add', 'docs/projects'); git(root, 'commit', '-m', `change ${slug}`);
}

test('automatic transport pushes a committed update and another checkout pulls it', t => {
  const { a, b } = fixture(t); add(a, 'one');
  assert.equal(syncStore(a), 'pushed');
  assert.equal(syncStore(b), 'pulled');
  assert.equal(readFileSync(join(a, 'docs/projects/entries/one.json'), 'utf8'), readFileSync(join(b, 'docs/projects/entries/one.json'), 'utf8'));
});
test('disjoint edits merge with a regenerated index containing both projects', t => {
  const { a, b } = fixture(t); add(a, 'one'); add(b, 'two');
  assert.equal(syncStore(a), 'pushed');
  assert.equal(syncStore(b), 'pushed');
  assert.equal(syncStore(a), 'pulled');
  const idx = readFileSync(join(a, 'docs/projects/INDEX.md'), 'utf8');
  assert.match(idx, /one\.md/); assert.match(idx, /two\.md/);
  assert.equal(git(a, 'status', '--porcelain'), '');
});
test('same-project conflict aborts and retains both local and remote commits', t => {
  const { a, b } = fixture(t); add(a, 'same', 'first'); add(b, 'same', 'second');
  syncStore(a); const local = git(b, 'rev-parse', 'HEAD');
  assert.equal(syncStore(b), 'conflict');
  assert.equal(git(b, 'rev-parse', 'HEAD'), local);
  assert.equal(git(b, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(b, 'docs/projects/entries/same.json'), 'utf8').includes('second'), true);
  assert.match(readFileSync(join(b, '.git/projects-sync.log'), 'utf8'), /same\.json/);
  assert.equal(existsSync(join(b, '.git/MERGE_HEAD')), false);
});
test('dirty checkout is preserved while committed work remains pending', t => {
  const { a, b } = fixture(t); add(a, 'one'); syncStore(a);
  writeFileSync(join(b, 'docs/projects/INDEX.md'), 'unfinished narrative work\n');
  assert.equal(syncStore(b), 'dirty');
  assert.equal(readFileSync(join(b, 'docs/projects/INDEX.md'), 'utf8'), 'unfinished narrative work\n');
});
test('offline remote keeps local committed updates and reports offline', t => {
  const { a, dir } = fixture(t); add(a, 'one'); const before = git(a, 'rev-parse', 'HEAD');
  git(a, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
  assert.equal(syncStore(a), 'offline'); assert.equal(git(a, 'rev-parse', 'HEAD'), before);
});
test('expired lock owned by a living process is not stolen', t => {
  const { a } = fixture(t); const lock = join(a, '.git/projects-sync.lock'); mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  const old = new Date(Date.now() - 700000); utimesSync(lock, old, old);
  assert.equal(syncStore(a, { waitMs: 0 }), 'locked'); assert.equal(existsSync(lock), true);
});

test('a write waits for a sync already holding the lock instead of failing', t => {
  const { a } = fixture(t); add(a, 'one'); const lock = join(a, '.git/projects-sync.lock'); mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  // A separate process releases the lock, as the background sync started by the previous commit would.
  execFile(process.execPath, ['-e', `setTimeout(()=>require('fs').rmSync(${JSON.stringify(lock)},{recursive:true}),800)`]);
  assert.equal(syncStore(a, { waitMs: 10000 }), 'pushed');
});

test('a write gives up once the wait runs out', t => {
  const { a } = fixture(t); const lock = join(a, '.git/projects-sync.lock'); mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  const start = Date.now();
  assert.equal(syncStore(a, { waitMs: 500 }), 'locked');
  assert.ok(Date.now() - start >= 500);
});

test('concurrent recovery gives one process ownership of an abandoned lock', async t => {
  const { a } = fixture(t), lock = join(a, '.git/projects-sync.lock');
  mkdirSync(lock);
  const old = new Date(Date.now() - 700000); utimesSync(lock, old, old);
  const module = new URL('../skills/logical-projects/store-sync.mjs', import.meta.url).href;
  const code = `import {acquireStoreLock} from ${JSON.stringify(module)}; import {writeFileSync,rmSync} from 'node:fs'; const lock=${JSON.stringify(lock)}; const acquired=acquireStoreLock(lock); console.log(acquired?'acquired':'locked'); if(acquired){writeFileSync(lock+'/owner.json',JSON.stringify({pid:process.pid}));setTimeout(()=>rmSync(lock,{recursive:true}),2000);}`;
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  })));
  assert.equal(results.filter(result => result === 'acquired').length, 1);
  assert.equal(existsSync(lock), false);
});
