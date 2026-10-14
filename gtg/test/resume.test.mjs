// lib/resume.mjs in-process: the sync target, the hub fast-forward and the resume pick-up, with no
// CLI spawned. git is spawned, against throwaway repos, because syncHub's whole job is git.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeConsume, syncHub, syncTarget } from '../skills/gtg/lib/resume.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'gtg-resume-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const repo = (name) => {
  const d = join(tmp, name);
  mkdirSync(d);
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 'T');
  git(d, 'config', 'commit.gpgsign', 'false');
  return d;
};
function run(fn) {
  const out = [];
  const err = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  return Promise.resolve().then(fn).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }))
    .finally(() => { console.log = log; console.error = error; });
}

test('syncTarget follows the upstream, falls back only on the fallback branch, and skips a detached HEAD', () => {
  const stub = (answers) => (...args) => {
    const k = args.join(' ');
    if (!(k in answers)) throw new Error(`unset: ${k}`);
    return answers[k];
  };
  assert.deepEqual(syncTarget(stub({ 'rev-parse --abbrev-ref HEAD': 'feat/x', 'config --get branch.feat/x.remote': 'hub',
    'config --get branch.feat/x.merge': 'refs/heads/x/refs/heads/y' })), { remote: 'hub', branch: 'x/refs/heads/y' });
  assert.equal(syncTarget(stub({ 'rev-parse --abbrev-ref HEAD': 'feat/x' })), null, 'a feature branch with no upstream never moves');
  assert.deepEqual(syncTarget(stub({ 'rev-parse --abbrev-ref HEAD': 'main' })), { remote: 'origin', branch: 'main' });
  assert.equal(syncTarget(stub({ 'rev-parse --abbrev-ref HEAD': 'HEAD' })), null);
  assert.equal(syncTarget(stub({})), null);
});

test('syncHub fast-forwards the hub once per process, and says so only when it moved', async () => {
  const upstream = repo('upstream');
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'one');
  const hub = join(tmp, 'hub');
  execFileSync('git', ['clone', '-q', upstream, hub]);
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'two');
  const tip = git(upstream, 'rev-parse', 'HEAD');
  const saved = process.env.GTG_NO_SYNC;
  delete process.env.GTG_NO_SYNC;
  try {
    const first = await run(() => syncHub(hub));
    assert.equal(first.out, `Synced origin/main: fast-forwarded to ${tip.slice(0, 7)}`);
    assert.equal(git(hub, 'rev-parse', 'HEAD'), tip);
    git(upstream, 'commit', '-q', '--allow-empty', '-m', 'three');
    const second = await run(() => syncHub(hub));
    assert.equal(second.out, '', 'the second call in one process does nothing');
    assert.equal(git(hub, 'rev-parse', 'HEAD'), tip);
  } finally {
    if (saved === undefined) delete process.env.GTG_NO_SYNC; else process.env.GTG_NO_SYNC = saved;
  }
});

// A fixture hub with a handoff file for `solo`, and a ctx whose collaborators record their calls.
function fixture({ active, backlog = [], forge = null, command = () => false } = {}) {
  const root = mkdtempSync(join(tmp, 'root-'));
  mkdirSync(join(root, 'docs', 'handoffs', 'current'), { recursive: true });
  writeFileSync(join(root, 'docs', 'handoffs', 'current', 'solo.md'), '# Solo\n\nthe body\n');
  const calls = { list: 0, picked: [] };
  const ctx = {
    root, forge, entries: (w) => (w === 'active' ? active : backlog), commandFileFor: command,
    readStore: () => null, writeStore: () => {}, saveEntries: () => [], commit: () => true,
    listAll: () => { calls.list += 1; }, onPick: (slug) => calls.picked.push(slug),
  };
  return { root, ctx, calls };
}
const e = (o) => ({ next: `next for ${o.slug}`, updated: '2026-09-01T10:30:00+08:00', ...o });

test('resumeConsume prints the handoff, keeps the entry and marks it as the one being worked on', async () => {
  const { ctx, calls } = fixture({ active: [e({ project: 'Solo', slug: 'solo', file: 'docs/handoffs/current/solo.md' })] });
  process.env.GTG_NO_SYNC = '1';
  const r = await run(() => resumeConsume(['solo'], ctx));
  assert.equal(r.code, undefined);
  assert.equal(r.out, [
    'RESUME: "Solo" - handoff of 2026-09-01 10:30 (docs/handoffs/current/solo.md)',
    '# Solo\n\nthe body', 'Kept: Solo (current handoff retained)'].join('\n'));
  assert.deepEqual(calls.picked, ['solo']);
});

test('resumeConsume returns 1 or 2 for a choice instead of exiting', async () => {
  const two = [e({ project: 'Router tune', slug: 'rt' }), e({ project: 'Router docs', slug: 'rd' })];
  const bare = fixture({ active: two });
  const r1 = await run(() => resumeConsume([], bare.ctx));
  assert.deepEqual([r1.code, r1.out, bare.calls.list], [1, '\nWhich? gtg <project>', 1], 'several open projects is a choice');
  const empty = fixture({ active: [] });
  assert.deepEqual([(await run(() => resumeConsume([], empty.ctx))).code, empty.calls.list], [2, 1]);
  const amb = await run(() => resumeConsume(['router'], fixture({ active: two }).ctx));
  assert.equal(amb.code, 1);
  assert.match(amb.out, /^'router' matches 2 active projects:\n  1\. Router tune \(rt\) - next for rt\n  2\. Router docs \(rd\)/);
  const unknown = await run(() => resumeConsume(['nope'], fixture({ active: two }).ctx));
  assert.deepEqual([unknown.code, unknown.err], [2, "No project matching 'nope'. Try 'gtg list' or 'gtg backlog'."]);
  const cmd = await run(() => resumeConsume(['stats'], fixture({ active: two, command: (t) => t === 'stats' }).ctx));
  assert.deepEqual([cmd.code, cmd.err], [2, "No project matching 'stats'; 'stats' is a command - run gtg stats."]);
  const both = await run(() => resumeConsume(['rt'], fixture({ active: two, command: (t) => t === 'rt' }).ctx));
  assert.equal(both.code, 1);
  assert.match(both.out, /^'rt' is both a project and a command:/);
});

test('resumeConsume reads a shelved entry by b<n>, and the forge copy when there is a forge', async () => {
  const shelf = fixture({ active: [], backlog: [e({ project: 'Idea', slug: 'idea' })] });
  const r = await run(() => resumeConsume(['b1'], shelf.ctx));
  assert.equal(r.code, undefined);
  assert.match(r.out, /^RESUME: "Idea" - handoff of 2026-09-01 10:30\n\(no handoff at none; the entry's next action is all there is: next for idea\)\nKept on backlog: Idea/);
  const forge = { latestHandoff: async (m) => `forge body for ${m.slug}`, locationOf: (m) => `forge:${m.slug}` };
  const f = await run(() => resumeConsume(['idea'], fixture({ active: [e({ project: 'Idea', slug: 'idea' })], forge }).ctx));
  assert.match(f.out, /^RESUME: "Idea" - handoff of 2026-09-01 10:30 \(forge:idea\)\nforge body for idea\n/);
});

test('resumeConsume runs the after-resume hook with its ctx, and a failing hook sets exit 1', async () => {
  const { root, ctx } = fixture({ active: [e({ project: 'Solo', slug: 'solo', file: 'docs/handoffs/current/solo.md' })] });
  mkdirSync(join(root, '.gtg'));
  writeFileSync(join(root, '.gtg', 'after-resume.mjs'),
    'export default (c) => { console.log(`hook ${c.entry.slug} kept=${c.kept} resumed=${c.resumed} ${typeof c.commit}`); };\n');
  const ok = await run(() => resumeConsume(['solo', '--keep'], ctx));
  assert.match(ok.out, /\nhook solo kept=true resumed=false function$/);
  const saved = process.exitCode;
  try {
    // A fresh root, so a fresh import URL: the module cache would otherwise hand back the first hook.
    const bad = fixture({ active: [e({ project: 'Solo', slug: 'solo' })] });
    mkdirSync(join(bad.root, '.gtg'));
    writeFileSync(join(bad.root, '.gtg', 'after-resume.mjs'), 'export default () => { throw new Error("hook broke"); };\n');
    const r = await run(() => resumeConsume(['solo'], bad.ctx));
    assert.equal(r.err, 'gtg: after-resume hook failed - hook broke');
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = saved; }
});

// 2026-10-02: a handoff written on the desktop named a worktree only that machine had, a session on
// the laptop resumed it, and only found out when a `cd` failed. Resume now says so on the line after RESUME, naming the
// device that wrote it when the record carries one, and stays quiet when the path is here.
test('resumeConsume warns when the handoff worktree is not on this device', async () => {
  const here = hostname().toLowerCase();
  const gone = join(tmp, 'no-such-worktree');
  const line = (o) => {
    const f = fixture({ active: [e({ project: 'Meld', slug: 'meld', ...o })] });
    return run(() => resumeConsume(['meld'], f.ctx)).then((r) => r.out.split('\n')[1]);
  };
  assert.equal(await line({ worktree: gone, device: 'desk-pc' }),
    `Worktree ${gone} is not on this device (${here}). The handoff was written on desk-pc.`);
  assert.equal(await line({ worktree: gone }), `Worktree ${gone} is not on this device (${here}).`,
    'an old record with no device warns on the missing path alone');
  assert.equal(await line({ worktree: gone, device: here }), `Worktree ${gone} is not on this device (${here}).`,
    'written here and since removed: naming this device twice says nothing');
  const quiet = (o) => line(o).then((l) => assert.doesNotMatch(l ?? '', /is not on this device/, JSON.stringify(o)));
  await quiet({ worktree: tmp, device: 'desk-pc' });
  await quiet({ worktree: 'repo root', device: 'desk-pc' });
  await quiet({ device: 'desk-pc' });
});

// The forge holds the records and handoffs, but the hub's own git still carries what resume reads
// after them: the progress record, which supersedes the handoff snapshot, and the portfolio rows the
// after-resume hook flips. Skipping the sync on the forge store left those as stale as the last
// scheduled pull, so a resume could print an older progress snapshot over a newer handoff.
test('resumeConsume fast-forwards the hub on the forge store too', () => {
  const upstream = repo('forge-upstream');
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'one');
  const hub = join(tmp, 'forge-hub');
  execFileSync('git', ['clone', '-q', upstream, hub]);
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'progress from the other machine');
  const tip = git(upstream, 'rev-parse', 'HEAD');
  const mod = new URL('../skills/gtg/lib/resume.mjs', import.meta.url).href;
  const code = `const { resumeConsume } = await import(${JSON.stringify(mod)});
    const rec = { project: 'Solo', slug: 'solo', next: 'n', updated: '2026-09-01T10:30:00+08:00' };
    await resumeConsume(['solo'], { root: ${JSON.stringify(hub)}, entries: (w) => (w === 'active' ? [rec] : []),
      forge: { latestHandoff: async () => 'forge body', locationOf: () => 'forge:solo' },
      commandFileFor: () => false, listAll() {}, onPick() {}, readStore: () => null, writeStore() {}, commit: () => true });`;
  const env = { ...process.env };
  delete env.GTG_NO_SYNC;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  assert.match(out, new RegExp(`^Synced origin/main: fast-forwarded to ${tip.slice(0, 7)}\nRESUME: "Solo"`));
  assert.equal(git(hub, 'rev-parse', 'HEAD'), tip);
});
