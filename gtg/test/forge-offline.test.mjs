// Offline behaviour of the forge store (#29): the sha-keyed blob cache, the 10 s read cap, stale
// reads for read-only commands and refused writes. Each test gets its own tmp dir (TEMP, TMP,
// TMPDIR), so its cache starts cold and no other test's cache is seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');
const sha = (text) => createHash('sha1').update(text).digest('hex');
const file = (rec) => JSON.stringify(rec, null, 2) + '\n';
const ALPHA = { slug: 'alpha', project: 'Alpha', shelf: 'active', next: 'Ship it', updated: new Date().toISOString(), sessions: 1, handoff: '## Next Action\nShip alpha\n' };
const BETA = { slug: 'beta', project: 'Beta', shelf: 'active', next: 'Ship beta', updated: new Date().toISOString(), sessions: 1, handoff: '## Next Action\nShip beta\n' };

// mode: 'up' answers, 'hang' never answers, 'auth' answers every request with 401.
async function stubHub(t) {
  const hub = {
    files: new Map([['docs/handoffs/records/alpha.json', file(ALPHA)], ['docs/handoffs/records/beta.json', file(BETA)]]),
    mode: 'up', hits: [], requests: 0,
  };
  const server = createServer(async (req, res) => {
    hub.requests++;
    for await (const _ of req) { /* drain */ }
    if (hub.mode === 'hang') return; // the request is left open until the client gives up
    const url = new URL(req.url, 'http://stub');
    const p = url.pathname.replace('/api/v1/repos/o/r', '');
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (hub.mode === 'auth') return send(401, { message: 'token is required' });
    if (p === '/git/trees/HEAD') {
      hub.hits.push('tree');
      return send(200, { truncated: false, tree: [...hub.files].map(([path, text]) => ({ path, type: 'blob', sha: sha(text) })) });
    }
    if (p === '/git/blobs') {
      const shas = url.searchParams.get('shas').split(',');
      hub.hits.push(`blobs:${shas.length}`);
      return send(200, shas.map((want) => {
        const text = [...hub.files.values()].find((x) => sha(x) === want);
        return { sha: want, encoding: 'base64', content: Buffer.from(text).toString('base64') };
      }));
    }
    hub.hits.push(`${req.method} ${p}`);
    send(404, { message: 'no route' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  // Down for good: the port refuses, as a stopped hub does.
  hub.down = () => new Promise((resolve) => { server.close(resolve); for (const s of sockets) s.destroy(); });
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  const tmp = mkdtempSync(join(tmpdir(), 'gtg-offline-tmp-'));
  hub.root = mkdtempSync(join(tmpdir(), 'gtg-offline-'));
  mkdirSync(join(hub.root, '.gtg'));
  writeFileSync(join(hub.root, '.gtg', 'forge.json'), JSON.stringify({
    api: `http://127.0.0.1:${server.address().port}/api/v1`, repo: 'o/r', store: 'files',
  }));
  hub.run = (args, input = '') => new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: hub.root,
      env: { ...process.env, GTG_HUB: hub.root, GTG_NO_SYNC: '1', GTG_SESSION_ID: 'offline-test', FORGEJO_TOKEN: 'tok', TEMP: tmp, TMP: tmp, TMPDIR: tmp },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (x) => { stdout += x; });
    child.stderr.on('data', (x) => { stderr += x; });
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input);
  });
  return hub;
}

test('a warm read fetches the tree and only the blobs it has not cached', async (t) => {
  const hub = await stubHub(t);
  assert.equal((await hub.run(['list'])).status, 0);
  assert.deepEqual(hub.hits, ['tree', 'blobs:2'], 'cold: the tree and one batch of both blobs');
  hub.hits = [];
  const warm = await hub.run(['list']);
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /Alpha/);
  assert.doesNotMatch(warm.stdout, /stale/);
  assert.deepEqual(hub.hits, ['tree'], 'warm and unchanged: the tree only');
  hub.hits = [];
  hub.files.set('docs/handoffs/records/beta.json', file({ ...BETA, next: 'Ship beta again' }));
  const changed = await hub.run(['list']);
  assert.match(changed.stdout, /Ship beta again/);
  assert.deepEqual(hub.hits, ['tree', 'blobs:1'], 'one changed record: one blob');
});

test('a matching cached handoff never authorizes a guarded write or recovery body', async (t) => {
  const hub = await stubHub(t);
  const listed = await hub.run(['list', '--json']);
  const record = JSON.parse(listed.stdout).active.find((r) => r.slug === 'alpha');
  await hub.down();
  const r = await hub.run(['handoff', '--project', 'Alpha', '--slug', 'alpha',
    '--expected-body-sha256', createHash('sha256').update(record.handoff, 'utf8').digest('hex'),
    '--expected-shelf', 'active'], '## Next Action\nOffline result\n');
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(!existsSync(join(hub.root, 'docs/handoffs/current/alpha.md')));
  assert.equal(hub.files.get('docs/handoffs/records/alpha.json'), file(ALPHA));
});

test('with the hub down, read-only commands serve the cache with a stale line and every write refuses', async (t) => {
  const hub = await stubHub(t);
  assert.equal((await hub.run(['list'])).status, 0);
  await hub.down();

  const list = await hub.run(['list']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^\(stale, hub unreachable\)/);
  assert.match(list.stdout, /Alpha/);
  const bare = await hub.run([]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /^\(stale, hub unreachable\)/);
  const resume = await hub.run(['resume', 'alpha']);
  assert.equal(resume.status, 0, resume.stderr);
  assert.match(resume.stdout, /^\(stale, hub unreachable\)/);
  assert.match(resume.stdout, /Ship alpha/);
  const shelf = await hub.run(['backlog']);
  assert.equal(shelf.status, 0, shelf.stderr);
  assert.match(shelf.stdout, /^\(stale, hub unreachable\)/);
  // Under --json the stale line goes to stderr, so stdout is still one JSON object.
  for (const args of [['list', '--json'], ['show', 'alpha', '--json']]) {
    const r = await hub.run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^\(stale, hub unreachable\)/, args.join(' '));
    assert.ok(JSON.parse(r.stdout), args.join(' '));
  }
  const shown = await hub.run(['show', 'alpha']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /^\(stale, hub unreachable\)/);

  for (const args of [['back', 'alpha'], ['active', 'alpha'], ['keep', 'alpha'], ['complete', 'alpha'], ['remove', 'alpha'],
    ['supersede', 'alpha'], ['rename', 'alpha', 'gamma'], ['unparent', 'alpha']]) {
    const r = await hub.run([...args, '--no-list']);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /refused, the hub is unreachable/, args.join(' '));
    assert.doesNotMatch(r.stdout, /Parked|Activated|Kept|Completed|Renamed/, `${args.join(' ')} prints nothing that reads as done`);
  }
  const handoff = await hub.run(['handoff', '--project', 'Alpha', '--slug', 'alpha'], '## Next Action\nOffline work\n');
  assert.equal(handoff.status, 1);
  assert.match(handoff.stderr, /cached store \(stale\), so nothing was written/);
  assert.match(readFileSync(join(hub.root, 'docs', 'handoffs', 'current', 'alpha.md'), 'utf8'), /Offline work/, 'the handoff body is kept');
  const park = await hub.run(['backlog', '--project', 'Idea', '--slug', 'idea'], '## Next Action\nSomeday\n');
  assert.equal(park.status, 1);
  assert.match(park.stderr, /so nothing was written/);
});

test('a hub that never answers is given up on within the 10 s cap, then the cache serves', async (t) => {
  const hub = await stubHub(t);
  assert.equal((await hub.run(['list'])).status, 0);
  hub.mode = 'hang';
  const r = await hub.run(['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\(stale, hub unreachable\)/);
  assert.ok(r.ms < 13000, `took ${r.ms} ms`);
  assert.ok(r.ms >= 9000, `took ${r.ms} ms, so the cap, not an early abort, ended the read`);
});

test('with no cache the hub being down is the usual error, and a 4xx is never served stale', async (t) => {
  const cold = await stubHub(t);
  await cold.down();
  const r = await cold.run(['list']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read the forge store/);

  const hub = await stubHub(t);
  assert.equal((await hub.run(['list'])).status, 0);
  hub.mode = 'auth';
  const denied = await hub.run(['list']);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /cannot read the forge store - forge GET .* 401/);
  assert.equal(existsSync(join(hub.root, 'docs')), false);
});

test('an unknown command exits 2 before any forge request (#97)', async (t) => {
  const hub = await stubHub(t);
  hub.mode = 'auth'; // any request that does reach the stub fails
  const r = await hub.run(['nosuchverb']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown command 'nosuchverb'/);
  assert.equal(hub.requests, 0, 'no request reached the forge');
  const known = await hub.run(['list']);
  assert.equal(known.status, 1, 'a known store command still reads the forge');
  assert.ok(hub.requests > 0);
});
