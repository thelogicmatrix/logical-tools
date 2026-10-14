import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRoot, loadConfig, resolveDir, settings, loadExtensions, STATE_DIR } from '../scripts/config.mjs';

// Each fixture is its own git repo, so the git top is the project and never a repo the temp dir sits inside.
// realpathSync.native, not realpathSync: only the native call expands a Windows 8.3 short name
// (RUNNER~1), and git hands back the long form, so the plain call made paths that never compared equal.
// Cleanup is registered in t.after so a failing assertion still removes the temp tree.
function fixture(t) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'runbooks-config-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  return { base, project, home, env: {} };
}
const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };
const writeConfig = (root, obj) => writeFileSync(join(root, 'config.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));

test('1. no .runbooks anywhere: findRoot null, dir is project docs/runbooks', (t) => {
  const f = fixture(t);
  const dir = mk(f.project, 'docs', 'runbooks');
  const sub = mk(f.project, 'src');
  assert.strictEqual(findRoot(sub, f.home), null);
  assert.strictEqual(resolveDir({ cwd: sub, env: f.env, home: f.home }), dir);
});

test('2. RUNBOOKS_DIR beats everything', (t) => {
  const f = fixture(t);
  mk(f.project, 'docs', 'runbooks');
  mk(f.home, 'docs', 'runbooks');
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { dir: mk(f.base, 'configured') });
  const envDir = mk(f.base, 'from-env');
  assert.strictEqual(resolveDir({ cwd: f.project, env: { RUNBOOKS_DIR: envDir }, home: f.home }), envDir);
});

test('2b. a relative RUNBOOKS_DIR resolves from the cwd argument, not the process cwd', (t) => {
  const f = fixture(t);
  const rel = mk(f.project, 'rel-runbooks');
  assert.notStrictEqual(process.cwd(), f.project);
  assert.strictEqual(resolveDir({ cwd: f.project, env: { RUNBOOKS_DIR: 'rel-runbooks' }, home: f.home }), rel);
});

test('3. an existing config.dir beats project docs/runbooks', (t) => {
  const f = fixture(t);
  mk(f.project, 'docs', 'runbooks');
  const root = mk(f.project, '.runbooks');
  const configured = mk(f.base, 'configured');
  writeConfig(root, { dir: configured });
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), configured);
});

test('4. a missing config.dir falls through to project, then home', (t) => {
  const f = fixture(t);
  const root = mk(f.home, '.runbooks');
  writeConfig(root, { dir: join(f.base, 'pinned-elsewhere', 'docs', 'runbooks') });
  const projectDir = mk(f.project, 'docs', 'runbooks');
  const homeDir = mk(f.home, 'docs', 'runbooks');
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), projectDir);
  rmSync(projectDir, { recursive: true });
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), homeDir);
  rmSync(homeDir, { recursive: true });
  assert.strictEqual(resolveDir({ cwd: f.project, env: f.env, home: f.home }), null);
});

test('5. a relative config.dir resolves against the parent of .runbooks/', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { dir: 'notes/runbooks' });
  const dir = mk(f.project, 'notes', 'runbooks');
  const sub = mk(f.project, 'src', 'deep');
  assert.strictEqual(resolveDir({ cwd: sub, env: f.env, home: f.home }), dir);
});

test('6. a project .runbooks beats ~/.runbooks', (t) => {
  const f = fixture(t);
  const projectRoot = mk(f.project, '.runbooks');
  const homeRoot = mk(f.home, '.runbooks');
  assert.strictEqual(findRoot(f.project, f.home), projectRoot);
  rmSync(projectRoot, { recursive: true });
  assert.strictEqual(findRoot(f.project, f.home), homeRoot);
});

test('6b. the working directory .runbooks sits between the project one and ~/.runbooks', (t) => {
  const f = fixture(t);
  const sub = mk(f.project, 'sub');
  const cwdRoot = mk(sub, '.runbooks');
  mk(f.home, '.runbooks');
  assert.strictEqual(findRoot(sub, f.home), cwdRoot);
  const projectRoot = mk(f.project, '.runbooks');
  assert.strictEqual(findRoot(sub, f.home), projectRoot);
});

test('7. settings with an empty config returns the measured defaults plus paths', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  writeConfig(root, {});
  const dir = mk(f.project, 'docs', 'runbooks');
  assert.deepStrictEqual(settings({ cwd: f.project, env: f.env, home: f.home }), {
    root, dir, topicsRoot: root, firesAt: 0.8, writeBar: 0.85, maxInject: 6, shortlist: 30,
    ledger: join(dir, '.router-ledger.json'),
  });
});

test('7b. writeBar follows firesAt, a relative ledger resolves against the parent of .runbooks/', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { firesAt: 0.7, ledger: 'state/ledger.json' });
  mk(f.project, 'docs', 'runbooks');
  const s = settings({ cwd: f.project, env: f.env, home: f.home });
  assert.strictEqual(s.writeBar, 0.75);
  assert.strictEqual(s.ledger, join(f.project, 'state', 'ledger.json'));
});

test('7c. settings with nothing resolving has null root, dir and ledger', (t) => {
  const f = fixture(t);
  const s = settings({ cwd: f.project, env: f.env, home: f.home });
  assert.deepStrictEqual([s.root, s.dir, s.ledger], [null, null, null]);
});

test('7d. a writeBar under firesAt falls back to firesAt + 0.05, one at or above it stands', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  mk(f.project, 'docs', 'runbooks');
  const bar = (c) => { writeConfig(root, c); return settings({ cwd: f.project, env: f.env, home: f.home }).writeBar; };
  assert.strictEqual(bar({ firesAt: 0.9, writeBar: 0.85 }), 0.95);
  assert.strictEqual(bar({ firesAt: 0.8, writeBar: 0.8 }), 0.8);
  assert.strictEqual(bar({ writeBar: 0.9 }), 0.9);
});

test('8. loadExtensions keeps function defaults sorted by name, skips throwers and non-functions', async (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  const nudges = mk(root, 'nudges');
  writeFileSync(join(nudges, 'b.mjs'), 'export default () => "b";\n');
  writeFileSync(join(nudges, 'a.mjs'), 'export default () => "a";\n');
  writeFileSync(join(nudges, 'broken.mjs'), 'throw new Error("boom");\n');
  writeFileSync(join(nudges, 'notfn.mjs'), 'export default 42;\n');
  writeFileSync(join(nudges, 'readme.txt'), 'not a module\n');
  // A test file beside an extension is not an extension, in either folder.
  writeFileSync(join(nudges, 'a.test.mjs'), 'export default () => "test";\n');
  writeFileSync(join(mk(root, 'lint'), 'rule.test.mjs'), 'export default () => ["test"];\n');
  const got = await loadExtensions(root, 'nudges');
  assert.deepStrictEqual(got.map(e => e.name), ['a', 'b']);
  assert.deepStrictEqual(got.map(e => e.fn()), ['a', 'b']);
  assert.deepStrictEqual(await loadExtensions(root, 'lint'), []);
  assert.deepStrictEqual(await loadExtensions(null, 'nudges'), []);
});

test('9. a non-numeric firesAt, writeBar, maxInject or shortlist falls back to the default', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  writeConfig(root, { firesAt: '0.9', writeBar: null, maxInject: 'six', shortlist: {} });
  mk(f.project, 'docs', 'runbooks');
  const s = settings({ cwd: f.project, env: f.env, home: f.home });
  assert.deepStrictEqual([s.firesAt, s.writeBar, s.maxInject, s.shortlist], [0.8, 0.85, 6, 30]);
});

test('10. invalid or missing config.json gives {}', (t) => {
  const f = fixture(t);
  const root = mk(f.project, '.runbooks');
  assert.deepStrictEqual(loadConfig(root), {});
  writeConfig(root, '{ not json');
  assert.deepStrictEqual(loadConfig(root), {});
  assert.deepStrictEqual(loadConfig(null), {});
  writeConfig(root, { firesAt: 0.9 });
  assert.deepStrictEqual(loadConfig(root), { firesAt: 0.9 });
});

test('11. topicsRoot: .runbooks/ owns the map only for the runbooks beside it', (t) => {
  const f = fixture(t);
  const homeRoot = mk(f.home, '.runbooks');
  writeConfig(homeRoot, {});
  mk(f.project, 'docs', 'runbooks');
  // The #121 case: home's .runbooks/ found, the project's own docs/runbooks used.
  assert.strictEqual(settings({ cwd: f.project, env: f.env, home: f.home }).topicsRoot, null);
  const projRoot = mk(f.project, '.runbooks');
  writeConfig(projRoot, {});
  assert.strictEqual(settings({ cwd: f.project, env: f.env, home: f.home }).topicsRoot, projRoot);
});

test('11b. home .runbooks/ owns home docs/runbooks when the project has none', (t) => {
  const f = fixture(t);
  const homeRoot = mk(f.home, '.runbooks');
  writeConfig(homeRoot, {});
  mk(f.home, 'docs', 'runbooks');
  assert.strictEqual(settings({ cwd: f.project, env: f.env, home: f.home }).topicsRoot, homeRoot);
});

test('11c. a runbooks folder named by config.dir or RUNBOOKS_DIR is owned wherever it sits', (t) => {
  const f = fixture(t);
  const store = mk(f.base, 'store');
  // A home worktree: the project carries .runbooks/ with an absolute config.dir to another folder.
  const projRoot = mk(f.project, '.runbooks');
  writeConfig(projRoot, { dir: store });
  assert.strictEqual(settings({ cwd: f.project, env: f.env, home: f.home }).topicsRoot, projRoot);
  writeConfig(projRoot, {});
  assert.strictEqual(settings({ cwd: f.project, env: { RUNBOOKS_DIR: store }, home: f.home }).topicsRoot, projRoot);
});

test('11d. a repo nested inside home does not write its map into home .runbooks/', (t) => {
  const f = fixture(t);
  mk(f.home, '.runbooks');
  // ~/code/foo with its own docs/runbooks and no .runbooks/. Home's .runbooks/ is found, but it
  // sits beside ~/docs/runbooks, not beside this repo's runbooks.
  const nested = mk(f.home, 'code', 'foo');
  execFileSync('git', ['init', '-q', nested]);
  const dir = mk(nested, 'docs', 'runbooks');
  const s = settings({ cwd: nested, env: f.env, home: f.home });
  assert.strictEqual(s.dir, dir);
  assert.strictEqual(s.topicsRoot, null);
});

// #132. ~/.runbooks/config.json pins dir to the home store, so worktrees of home do not route
// their empty copies. Reached only as the home-tier fallback from another repo, that pin hid the
// repo's own docs/runbooks: actual-projections read and wrote home's store and topics.json.
function homePinned(t) {
  const f = fixture(t);
  const store = mk(f.home, 'docs', 'runbooks');
  writeConfig(mk(f.home, '.runbooks'), { dir: store, ledger: 'docs/runbooks/.router-ledger.json' });
  const own = mk(f.project, 'docs', 'runbooks');
  return { ...f, store, own, s: () => settings({ cwd: f.project, env: f.env, home: f.home }) };
}

test('12. a home-tier config.dir ranks below the project docs/runbooks', (t) => {
  const f = homePinned(t);
  assert.strictEqual(f.s().dir, f.own);
  // With no runbooks of its own, the repo still gets home's pinned store.
  rmSync(f.own, { recursive: true });
  assert.deepStrictEqual([f.s().dir, f.s().ledger], [f.store, join(f.store, '.router-ledger.json')]);
});

test('12a. home .runbooks/ owns no map and no ledger for the project runbooks it outranked to', (t) => {
  const f = homePinned(t);
  assert.strictEqual(f.s().topicsRoot, null);
  // The purpose ledger is keyed by slug like the topics map, so home's must not take this repo's.
  assert.strictEqual(f.s().ledger, join(f.own, '.router-ledger.json'));
});

// The worktrees under C:/dev that carry docs/runbooks are home worktrees on branches from before
// the store moved out: pre-store copies, not runbooks of their own. A home worktree is home,
// whatever its branch holds, so it routes the store with home's map and ledger.
test('12d. a home worktree on an old branch (docs/runbooks, no .runbooks/) resolves as home', (t) => {
  const f = fixture(t);
  execFileSync('git', ['init', '-q', f.home]);
  execFileSync('git', ['-C', f.home, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const homeRoot = mk(f.home, '.runbooks');
  const store = mk(f.home, 'docs', 'runbooks');
  writeConfig(homeRoot, { dir: store, ledger: 'docs/runbooks/.router-ledger.json' });
  const wt = join(f.base, 'old-branch-wt');
  execFileSync('git', ['-C', f.home, 'worktree', 'add', '-q', '--detach', wt]);
  mk(wt, 'docs', 'runbooks');
  const s = settings({ cwd: mk(wt, 'sub'), env: f.env, home: f.home });
  assert.deepStrictEqual([s.dir, s.topicsRoot, s.ledger], [store, homeRoot, join(store, '.router-ledger.json')]);
  // With a .runbooks/ of its own (a worktree off today's home), still home's.
  writeConfig(mk(wt, '.runbooks'), { dir: join(wt, 'docs', 'runbooks') });
  assert.deepStrictEqual(settings({ cwd: wt, env: f.env, home: f.home }).topicsRoot, homeRoot);
});

test('12b. a home worktree: its own .runbooks config.dir still beats its empty docs/runbooks copy', (t) => {
  const f = fixture(t);
  const store = mk(f.home, 'docs', 'runbooks');
  writeConfig(mk(f.home, '.runbooks'), { dir: store });
  const projRoot = mk(f.project, '.runbooks');
  writeConfig(projRoot, { dir: store });
  mk(f.project, 'docs', 'runbooks');
  const s = settings({ cwd: f.project, env: f.env, home: f.home });
  assert.strictEqual(s.dir, store);
  assert.strictEqual(s.topicsRoot, projRoot);
});

test('12c. inside home itself, home .runbooks is the project tier and its config.dir wins', (t) => {
  const f = fixture(t);
  execFileSync('git', ['init', '-q', f.home]);
  const homeRoot = mk(f.home, '.runbooks');
  const store = mk(f.base, 'store');
  writeConfig(homeRoot, { dir: store });
  mk(f.home, 'docs', 'runbooks');
  const s = settings({ cwd: mk(f.home, 'sub'), env: f.env, home: f.home });
  assert.deepStrictEqual([s.dir, s.topicsRoot], [store, homeRoot]);
});

test('STATE_DIR ends in claude-router', () => {
  assert.match(STATE_DIR, /claude-router$/);
});

test('settings() and resolveDir() with no argument fall back to process.cwd() and do not throw', () => {
  const s = settings();
  assert.deepStrictEqual(Object.keys(s), ['root', 'dir', 'topicsRoot', 'firesAt', 'writeBar', 'maxInject', 'shortlist', 'ledger']);
  assert.strictEqual(resolveDir(), s.dir);
  assert.strictEqual(resolveDir({}), s.dir);
});
