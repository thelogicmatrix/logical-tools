import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempRepo, gtg, CLI, HANDOFF_ARGS, BODY, active, backlog } from './gtg-harness.mjs';
import { commandFor, slugify } from '../skills/gtg/extensions/commands/apply-queue.mjs';
import { openForge } from '../skills/gtg/lib/forge.mjs';

// The external API double follows Task4's atomic transition/immutable expectation contract.
// Each sign-in issues a new token. With guestAfter, a token turns into a guest after that many calls,
// as an expired token does on PocketBase 0.40.4: empty lists, 404 rows, never a 401.
async function stubLogic(t, actions, { beforeClaim, failPatch, pageSize = 200, guestAfter = Infinity } = {}) {
  const state = { actions: actions.map((a, i) => ({ id: `a${i}`, status: 'pending', text: '', wake: '', ...a })), patches: [], syncs: 0, order: [], kuma: [], failPending: false, failedLists: 0, auths: 0, calls: {} };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const url = new URL(req.url, 'http://stub');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/kuma') { state.kuma.push(url.search); return send(200, {}); }
    if (url.pathname === '/api/collections/users/auth-with-password') {
      const token = `agent-token-${++state.auths}`;
      state.calls[token] = 0;
      return send(200, { token });
    }
    const token = req.headers.authorization;
    if (!(token in state.calls)) return send(401, { message: 'no token' });
    if (++state.calls[token] > guestAfter) {
      if (req.method === 'GET' && url.pathname === '/api/collections/gtg_actions/records') return send(200, { items: [], totalPages: 0 });
      return send(req.method === 'POST' ? 403 : 404, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/logic/sync') { state.syncs++; state.order.push('sync'); return send(200, {}); }
    if (req.method === 'POST' && url.pathname === '/api/collections/gtg_actions/records') {
      const action = JSON.parse(raw);
      const text = String(action.text || '').replace(/\s+/g, ' ').trim();
      const slugless = ['backlog', 'new'].includes(action.verb);
      const slug = slugless ? '' : String(action.slug || '').trim();
      if (!slugless && !['active', 'backlog'].includes(action.expected_shelf)) return send(400, { message: 'expected_shelf required' });
      if (state.actions.some((a) => ['pending', 'applying'].includes(a.status) && (slug ? a.slug === slug : a.verb === action.verb && a.text === text))) return send(409, { message: 'Already queued.' });
      const created = { ...action, id: `a${state.actions.length}`, slug, text, status: 'pending', result: '', applied_at: '' };
      state.actions.push(created);
      return send(200, created);
    }
    if (req.method === 'GET' && url.pathname === '/api/collections/gtg_actions/records') {
      const want = /status = "(\w+)"/.exec(url.searchParams.get('filter'))?.[1];
      if (want === 'pending' && state.failPending) { state.failedLists++; return send(500, {}); }
      const items = state.actions.filter((a) => a.status === want);
      const page = Number(url.searchParams.get('page') || 1);
      return send(200, { items: items.slice((page - 1) * pageSize, page * pageSize), totalPages: Math.ceil(items.length / pageSize) });
    }
    const m = /^\/api\/collections\/gtg_actions\/records\/(\w+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const a = state.actions.find((x) => x.id === m[1]);
      return a ? send(200, a) : send(404, {});
    }
    if (req.method === 'PATCH' && m) {
      const a = state.actions.find((x) => x.id === m[1]);
      if (!a) return send(404, {});
      const patch = JSON.parse(raw);
      state.patches.push({ id: a.id, ...patch });
      if (patch.status === 'applying') await beforeClaim?.(a, state);
      // failPatch returns true for a 500, or the status code to answer with.
      const failed = failPatch?.(a, patch);
      if (failed) return send(failed === true ? 500 : failed, {});
      if (['verb', 'slug', 'text', 'wake', 'expected_shelf', 'args'].some((key) => key in patch && JSON.stringify(patch[key]) !== JSON.stringify(a[key]))) return send(400, { message: 'Immutable action' });
      const allowed = { pending: ['applying', 'failed'], applying: ['applied', 'failed'] };
      if (!allowed[a.status]?.includes(patch.status)) return send(400, { message: 'Invalid transition' });
      // No await between persisted-state validation and transition: exactly one claim wins.
      Object.assign(a, patch);
      state.order.push(patch.status);
      return send(200, a);
    }
    send(404, { message: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { state, env: { LOGIC_URL: `http://127.0.0.1:${server.address().port}`, LOGIC_AGENT_EMAIL: 'agent@test', LOGIC_AGENT_PASSWORD: 'private-password' } };
}

const run = (cwd, args, env, input = '') => new Promise((resolve, reject) => {
  const e = { ...process.env, GTG_SESSION_ID: 'apply-test', GIT_CEILING_DIRECTORIES: tmpdir(), PROJECTS_STORE_CONFIG: join(tmpdir(), 'gtg-test-no-projects-config.json'), ...env };
  delete e.GTG_HUB;
  delete e.PROJECTS_ROOT;
  delete e.CLAUDE_CODE_SESSION_ID;
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: e });
  let stdout = '', stderr = '';
  child.stdout.on('data', (x) => { stdout += x; });
  child.stderr.on('data', (x) => { stderr += x; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
  child.stdin.end(input);
});

test('commandFor maps all queued verbs to real GTG commands', () => {
  assert.deepEqual(commandFor({ verb: 'complete', slug: 'a', expected_shelf: 'active' }), { args: ['complete', 'a', '--exact', '--expected-shelf', 'active'] });
  assert.deepEqual(commandFor({ verb: 'back', slug: 'a', expected_shelf: 'active', wake: '2026-11-01 00:00:00.000Z' }), { args: ['back', 'a', '--exact', '--expected-shelf', 'active', '--wake', '2026-11-01'] });
  assert.deepEqual(commandFor({ verb: 'back', slug: 'a', expected_shelf: 'active', wake: '' }), { args: ['back', 'a', '--exact', '--expected-shelf', 'active'] });
  assert.deepEqual(commandFor({ verb: 'active', slug: 'a', expected_shelf: 'backlog' }), { args: ['active', 'a', '--exact', '--expected-shelf', 'backlog'] });
  assert.deepEqual(commandFor({ verb: 'keep', slug: 'a', expected_shelf: 'backlog', wake: '2026-11-01' }), { args: ['keep', 'a', '--exact', '--expected-shelf', 'backlog', '--wake', '2026-11-01'] });
  assert.deepEqual(commandFor({ verb: 'upnext', slug: 'a', expected_shelf: 'active', text: 'Then docs' }), { args: ['upnext', 'a', '--exact', '--expected-shelf', 'active', '--text=Then docs'] });
  const idea = commandFor({ verb: 'backlog', text: 'Write the Logic README' });
  assert.deepEqual(idea.args, ['backlog', '--project=Write the Logic README', '--slug', 'write-the-logic-readme', '--next=TBD: Write the Logic README', '--exact', '--create-only']);
  assert.match(idea.input, /## The Idea\nWrite the Logic README/);
  const ex = (s = 'active') => ['--exact', '--expected-shelf', s];
  assert.deepEqual(commandFor({ verb: 'edit', slug: 'a', expected_shelf: 'active', args: { eta: '~1h', due: 'none' } }).args, ['edit', 'a', ...ex(), '--eta=~1h', '--due=none']);
  assert.deepEqual(commandFor({ verb: 'upnext_edit', slug: 'a', expected_shelf: 'backlog', text: 'X', args: { n: 2 } }).args, ['upnext', 'a', ...ex('backlog'), '--edit=2', '--text=X']);
  assert.deepEqual(commandFor({ verb: 'upnext_remove', slug: 'a', expected_shelf: 'active', args: { n: 3 } }).args, ['upnext', 'a', ...ex(), '--remove=3']);
  assert.deepEqual(commandFor({ verb: 'upnext_move', slug: 'a', expected_shelf: 'active', args: { n: 3, to: 1 } }).args, ['upnext', 'a', ...ex(), '--move=3', '--to=1']);
  assert.deepEqual(commandFor({ verb: 'promote', slug: 'a', expected_shelf: 'active', args: {} }).args, ['upnext', 'a', ...ex(), '--promote']);
  assert.deepEqual(commandFor({ verb: 'rename', slug: 'a', expected_shelf: 'active', args: { name: 'New --name' } }).args, ['rename', 'a', 'a', ...ex(), '--name=New --name']);
  assert.deepEqual(commandFor({ verb: 'supersede', slug: 'a', expected_shelf: 'active', args: { into: 'b' } }).args, ['supersede', 'a', ...ex(), '--into', 'b']);
  assert.deepEqual(commandFor({ verb: 'remove', slug: 'a', expected_shelf: 'backlog', args: {} }).args, ['supersede', 'a', ...ex('backlog')]);
  const made = commandFor({ verb: 'new', text: 'Garden plan', args: { next: 'Buy soil\nthen seeds', parent: 'home' } });
  assert.deepEqual(made.args, ['handoff', '--project=Garden plan', '--slug', 'garden-plan', '--next=Buy soil', '--parent=home', '--exact', '--create-only']);
  assert.equal(made.input, '## Where We Stopped\nStarted from Logic.\n\n## Next Action\nBuy soil\nthen seeds\n');
  assert.throws(() => commandFor({ verb: 'delete', slug: 'a' }), /unknown verb/);
  assert.equal(slugify('  ¿Qué?  '), 'qu');
  assert.match(slugify('!!!'), /^idea-\d+$/);
});

test('applies every verb through GTG, syncs before marking each applied and never repeats', async (t) => {
  const repo = tempRepo();
  for (const s of ['alpha', 'beta', 'park', 'wake', 'review']) assert.equal(gtg(repo, HANDOFF_ARGS(s, s.toUpperCase()), { input: BODY }).status, 0);
  for (const s of ['wake', 'review']) assert.equal(gtg(repo, ['back', s]).status, 0);
  const { state, env } = await stubLogic(t, [
    { verb: 'complete', slug: 'alpha', expected_shelf: 'active' },
    { verb: 'upnext', slug: 'beta', expected_shelf: 'active', text: 'Then the docs PRIVATE-TEXT' },
    { verb: 'back', slug: 'park', expected_shelf: 'active', wake: '2026-11-01' },
    { verb: 'active', slug: 'wake', expected_shelf: 'backlog' },
    { verb: 'keep', slug: 'review', expected_shelf: 'backlog', wake: '2026-11-02' },
    { verb: 'backlog', text: 'Write the Logic README PRIVATE-IDEA' },
  ]);
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /apply-queue: 6 applied, 0 failed/);
  assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE-TEXT|PRIVATE-IDEA|private-password|agent-token/);
  assert.equal(r.stdout.split('\n').filter((s) => /action \d+/.test(s)).length, 6);
  assert.equal(active(repo).some((e) => e.slug === 'alpha'), false);
  assert.match(readFileSync(join(repo, active(repo).find((e) => e.slug === 'beta').file), 'utf8'), /## Up next\n- Then the docs PRIVATE-TEXT/);
  assert.equal(backlog(repo).find((e) => e.slug === 'park').wake, '2026-11-01');
  assert.ok(active(repo).some((e) => e.slug === 'wake'));
  assert.equal(backlog(repo).find((e) => e.slug === 'review').wake, '2026-11-02');
  assert.ok(backlog(repo).some((e) => e.slug === 'write-the-logic-readme-private-idea'));
  assert.ok(state.actions.every((a) => a.status === 'applied' && a.applied_at));
  assert.deepEqual(state.patches.filter((p) => p.id === 'a0').map((p) => p.status), ['applying', 'applied']);
  assert.equal(state.syncs, 6);
  assert.deepEqual(state.order, Array.from({ length: 6 }, () => ['applying', 'sync', 'applied']).flat());
  const again = await run(repo, ['apply-queue'], env);
  assert.match(again.stdout, /0 applied, 0 failed/);
  assert.equal(state.patches.length, 12);
  assert.equal(state.syncs, 6);
});

test('queued new project is created slugless with its Next Action and parent', async (t) => {
  const repo = tempRepo();
  const { state, env } = await stubLogic(t, [{ verb: 'new', text: 'Garden plan', args: { next: 'Buy soil\nthen seeds', parent: 'home' } }]);
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.actions[0].status, 'applied', state.actions[0].result);
  const made = active(repo).find((e) => e.slug === 'garden-plan');
  assert.equal(made.next, 'Buy soil');
  assert.equal(made.parent, 'home');
  assert.match(readFileSync(join(repo, made.file), 'utf8'), /## Next Action\nBuy soil\nthen seeds/);
});

test('queued remove supersedes the project as filed in error instead of recording a ship', async (t) => {
  const repo = tempRepo();
  assert.equal(gtg(repo, HANDOFF_ARGS('oops', 'Oops'), { input: BODY }).status, 0);
  const { state, env } = await stubLogic(t, [{ verb: 'remove', slug: 'oops', expected_shelf: 'active', args: {} }]);
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.actions[0].status, 'applied', state.actions[0].result);
  assert.equal(active(repo).some((e) => e.slug === 'oops'), false);
  assert.match(execFileSync('git', ['-C', repo, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /^gtg supersede: Oops/);
});

// The long-running watcher, with the same scrubbed env as run() so it never touches a real hub.
function watch(t, repo, env) {
  const e = { ...process.env, GTG_SESSION_ID: 'apply-test', GIT_CEILING_DIRECTORIES: tmpdir(), PROJECTS_STORE_CONFIG: join(tmpdir(), 'gtg-test-no-projects-config.json'), APPLY_POLL_MS: '100', ...env };
  delete e.GTG_HUB;
  delete e.PROJECTS_ROOT;
  delete e.CLAUDE_CODE_SESSION_ID;
  const child = spawn(process.execPath, [CLI, 'apply-queue', '--watch'], { cwd: repo, env: e });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (x) => { out.stdout += x; });
  child.stderr.on('data', (x) => { out.stderr += x; });
  const closed = new Promise((r) => child.on('close', r));
  t.after(() => child.kill());
  return { child, out, closed };
}
const until = async (done, ms = 5000) => { for (const end = Date.now() + ms; !done() && Date.now() < end;) await new Promise((r) => setTimeout(r, 50)); };

test('watch mode applies an action queued after it starts, then stops on SIGTERM', async (t) => {
  const repo = tempRepo();
  assert.equal(gtg(repo, HANDOFF_ARGS('w-a', 'W A'), { input: BODY }).status, 0);
  const { state, env } = await stubLogic(t, []);
  const w = watch(t, repo, env);
  await new Promise((r) => setTimeout(r, 400));
  state.actions.push({ id: 'late', status: 'pending', verb: 'edit', slug: 'w-a', expected_shelf: 'active', text: '', wake: '', args: { eta: '~5m' } });
  await until(() => state.actions[0].status === 'applied');
  assert.equal(state.actions[0].status, 'applied', state.actions[0].result);
  assert.equal(active(repo).find((x) => x.slug === 'w-a').eta, '~5m');
  w.child.kill('SIGTERM');
  const code = await w.closed;
  // Windows has no catchable SIGTERM: kill() terminates the process outright.
  if (process.platform !== 'win32') {
    assert.equal(code, 0, w.out.stderr);
    assert.match(w.out.stdout, /apply-queue: stopped/);
  }
});

test('a final mark that fails is retried on the next pass instead of leaving the row applying', async (t) => {
  const repo = tempRepo();
  assert.equal(gtg(repo, HANDOFF_ARGS('w-a', 'W A'), { input: BODY }).status, 0);
  let blips = 0;
  const { state, env } = await stubLogic(t, [{ verb: 'edit', slug: 'w-a', expected_shelf: 'active', args: { eta: '~5m' } }], { failPatch: (a, patch) => patch.status === 'applied' && blips++ === 0 });
  const w = watch(t, repo, env);
  await until(() => state.actions[0].status === 'applied');
  assert.equal(state.actions[0].status, 'applied', w.out.stderr);
  assert.deepEqual(state.patches.map((p) => p.status), ['applying', 'applied', 'applied']);
  assert.equal(state.syncs, 1);
  assert.match(w.out.stderr, /result not recorded; retrying next pass/);
  assert.equal(active(repo).find((x) => x.slug === 'w-a').eta, '~5m');
});

test('the Kuma push follows only a pass that did not throw', async (t) => {
  const repo = tempRepo();
  const { state, env } = await stubLogic(t, []);
  state.failPending = true;
  const w = watch(t, repo, { ...env, KUMA_PUSH_URL: `${env.LOGIC_URL}/kuma?token=k` });
  await until(() => state.failedLists >= 3);
  assert.ok(state.failedLists >= 3, w.out.stderr);
  assert.deepEqual(state.kuma, []);
  assert.match(w.out.stderr, /pass failed: Logic GET failed: 500/);
  state.failPending = false;
  await until(() => state.kuma.length > 0);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(state.kuma, ['?token=k&status=up&msg=OK']);
});

test('watch mode signs in again once the token is older than APPLY_REAUTH_MS and keeps applying', async (t) => {
  const repo = tempRepo();
  assert.equal(gtg(repo, HANDOFF_ARGS('w-a', 'W A'), { input: BODY }).status, 0);
  const { state, env } = await stubLogic(t, []);
  const w = watch(t, repo, { ...env, APPLY_REAUTH_MS: '300' });
  await until(() => state.auths >= 2);
  assert.ok(state.auths >= 2, w.out.stderr);
  state.actions.push({ id: 'late', status: 'pending', verb: 'edit', slug: 'w-a', expected_shelf: 'active', text: '', wake: '', args: { eta: '~5m' } });
  await until(() => state.actions[0].status === 'applied');
  assert.equal(state.actions[0].status, 'applied', w.out.stderr);
});

test('a token Logic has started treating as a guest recovers after the timed sign-in', async (t) => {
  const repo = tempRepo();
  assert.equal(gtg(repo, HANDOFF_ARGS('w-a', 'W A'), { input: BODY }).status, 0);
  const { state, env } = await stubLogic(t, [], { guestAfter: 6 });
  const w = watch(t, repo, { ...env, APPLY_REAUTH_MS: '2000' });
  // The first token goes quiet: empty lists, no 401, so only the timer can bring the watcher back.
  await until(() => state.calls['agent-token-1'] > 6);
  assert.ok(state.calls['agent-token-1'] > 6, w.out.stderr);
  state.actions.push({ id: 'late', status: 'pending', verb: 'edit', slug: 'w-a', expected_shelf: 'active', text: '', wake: '', args: { eta: '~5m' } });
  await until(() => state.actions[0].status === 'applied');
  assert.equal(state.actions[0].status, 'applied', w.out.stderr);
  assert.ok(state.auths >= 2);
  assert.equal(active(repo).find((x) => x.slug === 'w-a').eta, '~5m');
});

test('a retried mark that gets 404 while the row is still applying is kept, not dropped', async (t) => {
  const repo = tempRepo();
  assert.equal(gtg(repo, HANDOFF_ARGS('w-a', 'W A'), { input: BODY }).status, 0);
  const answers = [500, 404];
  const { state, env } = await stubLogic(t, [{ verb: 'edit', slug: 'w-a', expected_shelf: 'active', args: { eta: '~5m' } }], { failPatch: (a, patch) => patch.status === 'applied' && answers.shift() });
  const w = watch(t, repo, env);
  await until(() => state.actions[0].status === 'applied');
  assert.equal(state.actions[0].status, 'applied', w.out.stderr);
  assert.deepEqual(state.patches.map((p) => p.status), ['applying', 'applied', 'applied', 'applied']);
  assert.ok(state.auths >= 2, 'the 404 made it sign in again before deciding');
  assert.doesNotMatch(w.out.stderr, /dropped/);
});

test('removed exact slugs never execute against a remaining fuzzy candidate', async (t) => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha-copy', 'Alpha copy'), { input: BODY });
  const { state, env } = await stubLogic(t, ['complete', 'back', 'keep', 'upnext'].map((verb) => ({ verb, slug: 'alpha', expected_shelf: 'active', text: 'wrong project' })));
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 applied, 4 failed/);
  assert.ok(state.actions.every((a) => /no longer exists/.test(a.result)));
  assert.equal(active(repo).length, 1);
  assert.doesNotMatch(readFileSync(join(repo, active(repo)[0].file), 'utf8'), /wrong project/);
});

test('re-shelved projects and legacy actions without expectations fail before execution', async (t) => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  gtg(repo, ['back', 'alpha']);
  const { state, env } = await stubLogic(t, [
    { verb: 'complete', slug: 'alpha', expected_shelf: 'active' },
    { verb: 'active', slug: 'alpha', expected_shelf: 'active' },
    { verb: 'keep', slug: 'alpha' },
  ]);
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(state.actions[0].result, /changed shelf/);
  assert.match(state.actions[1].result, /changed shelf/);
  assert.match(state.actions[2].result, /expected_shelf/);
  assert.equal(backlog(repo).length, 1);
  assert.equal(active(repo).length, 0);
});

test('failed atomic claim neither executes nor fails the winning runner action', async (t) => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  const { state, env } = await stubLogic(t, [{ verb: 'complete', slug: 'alpha', expected_shelf: 'active' }], { beforeClaim: (a) => { a.status = 'applying'; } });
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.actions[0].status, 'applying');
  assert.equal(state.patches.length, 1);
  assert.ok(active(repo).some((e) => e.slug === 'alpha'));
  assert.equal(state.syncs, 0);
  assert.match(r.stderr, /claim failed/);
});

test('single-runner interrupted recovery fails applying actions without re-running them', async (t) => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  const { state, env } = await stubLogic(t, [{ verb: 'complete', slug: 'alpha', status: 'applying', expected_shelf: 'active' }]);
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.actions[0].status, 'failed');
  assert.match(state.actions[0].result, /Interrupted/);
  assert.ok(active(repo).some((e) => e.slug === 'alpha'));
  assert.equal(state.syncs, 0);
});

test('all pending pages are fetched before status mutations change pagination', async (t) => {
  const repo = tempRepo();
  const { state, env } = await stubLogic(t, Array.from({ length: 3 }, () => ({ verb: 'delete' })), { pageSize: 2 });
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 applied, 3 failed/);
  assert.ok(state.actions.every((a) => a.status === 'failed'));
});

test('missing Logic settings fail visibly', async () => {
  const r = await run(tempRepo(), ['apply-queue'], { LOGIC_URL: '', LOGIC_AGENT_EMAIL: '', LOGIC_AGENT_PASSWORD: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /apply-queue needs LOGIC_URL, LOGIC_AGENT_EMAIL and LOGIC_AGENT_PASSWORD/);
});

test('extension projectEntries reads fresh annotated file entries without changing records', async () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  const dir = join(repo, '.gtg', 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'inspect-state.mjs'), `import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
export default async ({root, projectEntries}) => {
 const before = await projectEntries();
 writeFileSync(join(root, 'docs/handoffs/active/extra.json'), JSON.stringify({slug:'extra'}));
 console.log(JSON.stringify({before, after: await projectEntries()}));
}`);
  const r = await run(repo, ['inspect-state'], {});
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.deepEqual(data.before.map(({ slug, shelf }) => ({ slug, shelf })), [{ slug: 'alpha', shelf: 'active' }]);
  assert.equal(data.after.length, 2);
  assert.equal(active(repo)[0].shelf, undefined);
});

test('queued numeric slug completes the exact project instead of its positional neighbor', async (t) => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'A first'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('1', 'Z numeric'), { input: BODY });
  const { state, env } = await stubLogic(t, [{ verb: 'complete', slug: '1', expected_shelf: 'active' }]);
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.actions[0].status, 'applied');
  assert.deepEqual(active(repo).map((e) => e.slug), ['alpha']);
});

test('queued b1 slug activates the exact backlog entry while ordinary b1 keeps its numbering', async (t) => {
  const repo = tempRepo();
  for (const [slug, project] of [['alpha', 'A first'], ['b1', 'Z b1']]) {
    gtg(repo, HANDOFF_ARGS(slug, project), { input: BODY });
    gtg(repo, ['back', slug]);
  }
  const { state, env } = await stubLogic(t, [{ verb: 'active', slug: 'b1', expected_shelf: 'backlog' }]);
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.actions[0].status, 'applied');
  assert.deepEqual(active(repo).map((e) => e.slug), ['b1']);
  assert.equal(gtg(repo, ['active', 'b1']).status, 0);
  assert.equal(backlog(repo).length, 0);
});

test('child CLI rejects an exact removed or re-shelved target before mutation', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha-copy', 'Alpha copy'), { input: BODY });
  const missing = gtg(repo, ['complete', 'alpha', '--exact', '--expected-shelf', 'active']);
  assert.notEqual(missing.status, 0);
  assert.equal(active(repo).length, 1);
  gtg(repo, ['back', 'alpha-copy']);
  const moved = gtg(repo, ['complete', 'alpha-copy', '--exact', '--expected-shelf', 'active']);
  assert.notEqual(moved.status, 0);
  assert.match(moved.stderr, /changed shelf/);
  assert.equal(backlog(repo).length, 1);
});

async function forgeReader(t, { stale = false } = {}) {
  let reads = 0, writes = 0;
  const record = (slug, shelf) => ({ slug, shelf, project: slug, handoff: BODY });
  const records = { old: record('alpha', 'active'), fresh: record('beta', 'backlog') };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') { writes++; return send(500, {}); }
    if (url.pathname.endsWith('/git/trees/HEAD')) {
      reads++;
      if (stale && reads > 1) return send(503, {});
      const sha = reads === 1 ? 'old' : 'fresh';
      return send(200, { tree: [{ type: 'blob', path: `docs/handoffs/records/${records[sha].slug}.json`, sha }] });
    }
    if (url.pathname.endsWith('/git/blobs')) return send(200, url.searchParams.get('shas').split(',').map((sha) => ({ sha, content: Buffer.from(JSON.stringify(records[sha])).toString('base64') })));
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { api: `http://127.0.0.1:${server.address().port}`, counts: () => ({ reads, writes }) };
}

for (const stale of [false, true]) test(`projectEntries ${stale ? 'rejects stale Forge fallback' : 'reads fresh Forge state instead of local files or startup snapshot'}`, async (t) => {
  const repo = tempRepo();
  const forge = await forgeReader(t, { stale });
  mkdirSync(join(repo, '.gtg', 'commands'), { recursive: true });
  writeFileSync(join(repo, '.gtg', 'forge.json'), JSON.stringify({ api: forge.api, repo: 'test/projects', store: 'files' }));
  writeFileSync(join(repo, '.gtg', 'commands', 'inspect-state.mjs'), `export default async ({projectEntries}) => {
 try { console.log(JSON.stringify(await projectEntries())); } catch { console.log('AUTHORITY-UNAVAILABLE'); }
}`);
  const r = await run(repo, ['inspect-state'], { FORGEJO_TOKEN: 'fixture-token' });
  assert.equal(r.status, 0, r.stderr);
  if (stale) assert.match(r.stdout, /AUTHORITY-UNAVAILABLE/);
  else assert.deepEqual(JSON.parse(r.stdout).map(({ slug, shelf }) => ({ slug, shelf })), [{ slug: 'beta', shelf: 'backlog' }]);
  assert.ok(forge.counts().reads > 1);
  assert.equal(forge.counts().writes, 0);
});

test('flag-shaped backlog and Up next text persist literally instead of becoming options', async (t) => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  const { state, env } = await stubLogic(t, [
    { verb: 'backlog', text: '--dry-run' },
    { verb: 'upnext', slug: 'alpha', expected_shelf: 'active', text: '--dry-run --wake=never' },
  ]);
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(state.actions.map((a) => a.status), ['applied', 'applied']);
  const idea = backlog(repo).find((e) => e.slug === 'dry-run');
  assert.ok(idea, 'successful application must have a persisted idea');
  assert.equal(idea.project, '--dry-run');
  assert.equal(idea.next, 'TBD: --dry-run');
  assert.match(readFileSync(join(repo, idea.file), 'utf8'), /## The Idea\n--dry-run/);
  assert.match(readFileSync(join(repo, active(repo)[0].file), 'utf8'), /## Up next\n- --dry-run --wake=never/);
});

test('queued generated-slug collision fails without changing old body, metadata or shelf', async (t) => {
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('write-docs', 'Established project'), '--due', '2026-12-01', '--parent', 'old-family'], { input: BODY });
  const before = active(repo);
  const oldBody = readFileSync(join(repo, before[0].file), 'utf8');
  const { state, env } = await stubLogic(t, [{ verb: 'backlog', text: 'Write docs' }]);
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.actions[0].status, 'failed');
  assert.match(state.actions[0].result, /already exists/);
  assert.deepEqual(active(repo), before);
  assert.equal(backlog(repo).length, 0);
  assert.equal(readFileSync(join(repo, before[0].file), 'utf8'), oldBody);
});

test('queued fuzzy-name idea creates a separate record and preserves existing work', async (t) => {
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('release-work', 'Release docs and deploy'), '--due', '2026-12-01', '--parent', 'old-family'], { input: BODY });
  const stale = { ...active(repo)[0], updated: '2000-01-01T00:00:00Z' };
  writeFileSync(join(repo, 'docs/handoffs/active/release-work.json'), JSON.stringify(stale));
  const before = active(repo);
  const oldBody = readFileSync(join(repo, before[0].file), 'utf8');
  const { state, env } = await stubLogic(t, [{ verb: 'backlog', text: 'Release docs' }]);
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.actions[0].status, 'applied');
  assert.deepEqual(active(repo), before);
  assert.equal(readFileSync(join(repo, before[0].file), 'utf8'), oldBody);
  assert.deepEqual(backlog(repo).map((e) => e.slug), ['release-docs']);
});

test('queued action preserves unrelated stale metadata while ordinary review questions remain', async (t) => {
  const repo = tempRepo();
  for (const slug of ['alpha', 'unrelated']) gtg(repo, HANDOFF_ARGS(slug, slug), { input: BODY });
  const old = { ...active(repo).find((e) => e.slug === 'unrelated'), updated: '2000-01-01T00:00:00Z' };
  writeFileSync(join(repo, 'docs/handoffs/active/unrelated.json'), JSON.stringify(old));
  const { state, env } = await stubLogic(t, [{ verb: 'complete', slug: 'alpha', expected_shelf: 'active' }]);
  const r = await run(repo, ['apply-queue'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.actions[0].status, 'applied');
  assert.deepEqual(active(repo), [old]);
  const normal = gtg(repo, ['backlog', '--project=Normal idea', '--slug', 'normal-idea', '--next=Normal next'], { input: BODY });
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /REVIEW: unrelated/);
  assert.ok(active(repo)[0].nudged);
});

test('create-only child refusal happens before handoff/WIP writes and ordinary reuse still works', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('same', 'Original'), { input: BODY });
  const stale = { ...active(repo)[0], updated: '2000-01-01T00:00:00Z' };
  writeFileSync(join(repo, 'docs/handoffs/active/same.json'), JSON.stringify(stale));
  const before = active(repo);
  const oldBody = readFileSync(join(repo, before[0].file), 'utf8');
  const r = gtg(repo, ['backlog', '--project=Replacement', '--slug', 'same', '--next=Replacement', '--exact', '--create-only', '--wip'], { input: 'Replacement body' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already exists/);
  assert.deepEqual(active(repo), before);
  assert.equal(readFileSync(join(repo, before[0].file), 'utf8'), oldBody);
  const normal = gtg(repo, HANDOFF_ARGS('fresh', 'Original'), { input: '## Next Action\nOrdinary replacement\n' });
  assert.equal(normal.status, 0, normal.stderr);
  assert.deepEqual(active(repo).map((e) => e.slug), ['same']);
  assert.equal(active(repo)[0].next, 'do the next thing');
  assert.match(readFileSync(join(repo, before[0].file), 'utf8'), /Ordinary replacement/);
});

for (const phase of ['loaded', 'after-read', 'identical-after-read', 'lost-after-create', 'cli-after-read']) test(`Forge create-only respects expected absence ${phase}`, async (t) => {
  const path = 'docs/handoffs/records/idea.json';
  const original = { slug: 'idea', project: 'Established', shelf: 'active', next: 'keep this', handoff: 'ORIGINAL BODY', parent: 'family' };
  const identical = { slug: 'idea', project: 'Replacement', next: 'new', shelf: 'backlog', handoff: 'NEW BODY' };
  const records = new Map(phase === 'loaded' ? [[path, JSON.stringify(original)]] : []);
  const writes = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const url = new URL(req.url, 'http://stub');
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname.endsWith('/git/trees/HEAD')) return send(200, { tree: [...records].map(([path]) => ({ path, type: 'blob', sha: 'initial' })) });
    if (url.pathname.endsWith('/git/blobs')) return send(200, [{ sha: 'initial', content: Buffer.from(records.get(path)).toString('base64') }]);
    if (url.pathname.endsWith(`/contents/${path}`)) {
      const old = records.get(path);
      if (req.method === 'GET') return old ? send(200, { sha: 'server-sha', content: Buffer.from(old).toString('base64') }) : send(404, {});
      writes.push(req.method);
      if (phase === 'cli-after-read') { records.set(path, JSON.stringify(original)); return send(422, { message: 'exists' }); }
      if (req.method === 'POST' && old) return send(422, { message: 'exists' });
      records.set(path, Buffer.from(JSON.parse(raw).content, 'base64').toString('utf8'));
      if (phase === 'lost-after-create') return req.socket.destroy();
      return send(200, { content: { sha: 'written' } });
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const cfg = { api: `http://127.0.0.1:${server.address().port}`, repo: 'test/create-only', token: 'fixture' };
  if (phase === 'cli-after-read') {
    const repo = tempRepo();
    mkdirSync(join(repo, '.gtg'));
    writeFileSync(join(repo, '.gtg', 'forge.json'), JSON.stringify({ api: cfg.api, repo: cfg.repo, store: 'files' }));
    const { args, input } = commandFor({ verb: 'backlog', text: 'Idea' });
    const r = await run(repo, args, { FORGEJO_TOKEN: 'fixture' }, input);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /already exists/);
    assert.deepEqual(JSON.parse(records.get(path)), original);
    assert.equal(existsSync(join(repo, 'docs/handoffs/current/idea.md')), false, 'refused create must not save a fallback body over this slug');
    assert.deepEqual(writes, ['POST']);
    return;
  }
  const forge = await openForge(cfg);
  if (phase === 'after-read') records.set(path, JSON.stringify(original));
  if (phase === 'identical-after-read') records.set(path, JSON.stringify(identical));
  forge.queueHandoff('idea', 'NEW BODY', { createOnly: true });
  forge.save('backlog', [{ slug: 'idea', project: 'Replacement', next: 'new' }]);
  forge.save('active', []);
  if (phase === 'lost-after-create') {
    await forge.flush('backlog');
    await forge.flush('backlog'); // successful creation must survive normal dispatcher flush
    assert.deepEqual(JSON.parse(records.get(path)), identical);
    assert.deepEqual(writes, ['POST']);
  } else {
    await assert.rejects(forge.flush('backlog'), /already exists|changed in another session/);
    assert.deepEqual(JSON.parse(records.get(path)), phase === 'identical-after-read' ? identical : original);
  }
  assert.ok(writes.every((method) => method === 'POST'), 'create-only must never edit a record with PUT');
});
