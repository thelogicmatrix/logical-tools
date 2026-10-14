import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');
const sha = (text) => createHash('sha1').update(text).digest('hex');
// A fresh tmp dir per run, so lib/forge.mjs's blob cache starts cold and every run reads the hub
// the way these tests count requests. forge-offline.test.mjs covers the cache itself.
const coldCache = () => { const d = mkdtempSync(join(tmpdir(), 'gtg-cold-')); return { TEMP: d, TMP: d, TMPDIR: d }; };

test('file store handoff, resume, shelf move and complete use versioned files only', async (t) => {
  const files = new Map();
  let writes = 0;
  let race = false;
  let contentReads = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    const path = decodeURIComponent(new URL(req.url, 'http://stub').pathname.replace('/api/v1/repos/o/r/contents/', ''));
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    assert.equal(req.headers.authorization, 'token tok');
    if (req.method === 'GET' && path === '/api/v1/repos/o/r') return send(200, {});
    // Before the first write the repo has no commit, so HEAD does not resolve (Forgejo answers 400).
    if (req.method === 'GET' && path === '/api/v1/repos/o/r/git/trees/HEAD') {
      if (!writes) return send(400, { message: 'sha not found [HEAD]' });
      const tree = [...files.keys()].map((x) => ({ path: x, type: 'blob', sha: sha(files.get(x)) }));
      return send(200, { sha: 'root', truncated: false, tree: [{ path: 'docs', type: 'tree', sha: 'd' }, ...tree] });
    }
    if (req.method === 'GET' && path === '/api/v1/repos/o/r/git/blobs') {
      const blobs = new URL(req.url, 'http://stub').searchParams.get('shas').split(',').map((want) => {
        const name = [...files.keys()].find((x) => sha(files.get(x)) === want);
        const blob = name && { sha: want, encoding: 'base64', content: Buffer.from(files.get(name)).toString('base64') };
        if (race && name === 'docs/handoffs/records/alpha.json') {
          files.set(name, JSON.stringify({ ...JSON.parse(files.get(name)), handoff: 'another machine wrote this' }));
        }
        return blob;
      });
      return blobs.every(Boolean) ? send(200, blobs) : send(400, { message: 'object does not exist' });
    }
    if (req.method === 'GET') contentReads++;
    if (req.method === 'GET' && path === 'docs/handoffs/records') {
      const names = [...files.keys()].filter((x) => x.startsWith('docs/handoffs/records/'))
        .map((x) => ({ name: x.split('/').at(-1), sha: sha(files.get(x)) }));
      return names.length ? send(200, names) : send(404, { message: 'missing directory' });
    }
    const old = files.get(path);
    if (req.method === 'GET') {
      if (!old) return send(404, { message: 'missing' });
      const snapshot = { sha: sha(old), content: Buffer.from(old).toString('base64') };
      if (race && path === 'docs/handoffs/records/alpha.json') {
        files.set(path, JSON.stringify({ ...JSON.parse(old), handoff: 'another machine wrote this' }));
      }
      return send(200, snapshot);
    }
    writes++;
    if (req.method === 'DELETE') {
      if (!old || body.sha !== sha(old)) return send(409, { message: 'stale' });
      files.delete(path); return send(200, {});
    }
    if ((req.method === 'POST' && old) || (req.method === 'PUT' && (!old || body.sha !== sha(old)))) {
      return send(409, { message: 'stale' });
    }
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    files.set(path, text);
    return send(200, { content: { sha: sha(text), html_url: `http://stub/${path}` } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), 'gtg-files-'));
  mkdirSync(join(root, '.gtg'));
  writeFileSync(join(root, '.gtg', 'forge.json'), JSON.stringify({
    api: `http://127.0.0.1:${server.address().port}/api/v1`, repo: 'o/r', store: 'files',
  }));
  const run = (args, input = '') => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { ...process.env, GTG_HUB: root, GTG_NO_SYNC: '1', GTG_SESSION_ID: 'file-test', FORGEJO_TOKEN: 'tok', ...coldCache() },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (x) => { stdout += x; });
    child.stderr.on('data', (x) => { stderr += x; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  const handoff = await run(['handoff', '--project', 'Alpha', '--slug', 'alpha'], '## Next Action\nShip it\n');
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.match(handoff.stdout, /docs\/handoffs\/records\/alpha.json/);
  assert.match(JSON.parse(files.get('docs/handoffs/records/alpha.json')).handoff, /Ship it/);
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).shelf, 'active');
  assert.equal([...files.keys()].length, 1);
  const beforeRead = writes;
  contentReads = 0;
  const resumed = await run(['resume', 'alpha']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(contentReads, 0, 'a store with commits is read through the tree and blobs, not the contents API');
  assert.match(resumed.stdout, /Ship it/);
  assert.match(resumed.stdout, /docs\/handoffs\/records\/alpha.json/);
  assert.equal(writes, beforeRead);
  const second = await run(['handoff', '--project', 'Alpha', '--slug', 'alpha'], '## Next Action\nShip more\n');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(files.size, 1);
  assert.match(JSON.parse(files.get('docs/handoffs/records/alpha.json')).handoff, /Ship more/);
  race = true;
  const conflict = await run(['handoff', '--project', 'Alpha', '--slug', 'alpha'], '## Next Action\nStale update\n');
  race = false;
  assert.equal(conflict.status, 1);
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).handoff, 'another machine wrote this');
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).next, 'Ship more');
  const back = await run(['back', 'alpha', '--no-list']);
  assert.equal(back.status, 0, back.stderr);
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).shelf, 'backlog');
  const renamed = await run(['rename', 'alpha', 'beta', '--name', 'Beta', '--no-list']);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).slug, 'beta');
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).handoff, 'another machine wrote this');
  assert.equal(files.size, 1);
  assert.match((await run(['resume', 'beta'])).stdout, /another machine wrote this/);
  const done = await run(['complete', 'beta', '--no-list']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(files.size, 0);
  assert.match((await run(['list'])).stdout, /No active gtg projects/);
});

test('file store retries a failed read, and resends a failed write only once, after reading it back unchanged', async (t) => {
  const record = JSON.stringify({ slug: 'alpha', project: 'Alpha', shelf: 'active', next: 'Ship it', handoff: 'x' });
  let reads = 0, writes = 0, failReadsUntil = 0, failWrites = false;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const path = decodeURIComponent(new URL(req.url, 'http://stub').pathname.replace('/api/v1/repos/o/r/contents/', ''));
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method !== 'GET') { writes++; return failWrites ? send(503, { message: 'busy' }) : send(200, { content: { sha: 'n' } }); }
    reads++;
    if (reads <= failReadsUntil) return send(503, { message: 'busy' });
    if (path.endsWith('/git/trees/HEAD')) return send(200, { truncated: false, tree: [{ path: 'docs/handoffs/records/alpha.json', type: 'blob', sha: 's' }] });
    if (path.endsWith('/git/blobs')) return send(200, [{ sha: 's', encoding: 'base64', content: Buffer.from(record).toString('base64') }]);
    return send(200, { sha: 's', encoding: 'base64', content: Buffer.from(record).toString('base64') });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), 'gtg-retry-'));
  mkdirSync(join(root, '.gtg'));
  writeFileSync(join(root, '.gtg', 'forge.json'), JSON.stringify({
    api: `http://127.0.0.1:${server.address().port}/api/v1`, repo: 'o/r', store: 'files',
  }));
  const run = (args, input = '') => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { ...process.env, GTG_HUB: root, GTG_NO_SYNC: '1', GTG_SESSION_ID: 'retry-test', FORGEJO_TOKEN: 'tok', ...coldCache() },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (x) => { stdout += x; });
    child.stderr.on('data', (x) => { stderr += x; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  failReadsUntil = 2; // the first two reads fail and are retried
  const listed = await run(['list', '--no-list']);
  assert.equal(listed.status, 0, listed.stderr);
  failReadsUntil = 0;
  reads = 0;
  failReadsUntil = 1e9; // the server never recovers: give up with the usual message after a bounded number of tries
  const dead = await run(['list', '--no-list']);
  assert.equal(dead.status, 1);
  assert.match(dead.stderr, /cannot read the forge store/);
  assert.ok(reads <= 4, `gave up after ${reads} reads`);
  failReadsUntil = 0;
  failWrites = true;
  const before = writes;
  const write = await run(['handoff', '--project', 'Alpha', '--slug', 'alpha'], '## Next Action\nAgain\n');
  assert.equal(write.status, 1);
  assert.equal(writes - before, 2, 'a PUT that keeps failing is read back and sent once more, never a third time');
});

test('file store reads records from the git tree and one batch of blobs, with fallbacks for a truncated tree and a server without the batch route', async (t) => {
  const records = {
    'docs/handoffs/records/alpha.json': JSON.stringify({ slug: 'alpha', project: 'Alpha', shelf: 'active', next: 'Ship alpha', updated: new Date().toISOString(), handoff: 'alpha body' }),
    'docs/handoffs/records/beta.json': JSON.stringify({ slug: 'beta', project: 'Beta', shelf: 'backlog', next: 'Ship beta', updated: new Date().toISOString() }),
    'docs/handoffs/records/notes/gamma.json': JSON.stringify({ slug: 'gamma', project: 'Gamma', shelf: 'active' }),
    'docs/handoffs/records/README.md': 'not a record',
  };
  let truncated = false, batchRoute = true;
  const hits = { tree: 0, batch: 0, blob: 0, listing: 0, contents: 0 };
  const puts = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const url = new URL(req.url, 'http://stub').pathname;
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method !== 'GET') {
      puts.push({ method: req.method, url, body: JSON.parse(raw) });
      return send(200, { content: { sha: 'new', html_url: 'http://stub/x' } });
    }
    if (url === '/api/v1/repos/o/r/git/trees/HEAD') {
      hits.tree++;
      const tree = Object.entries(records).map(([path, text]) => ({ path, type: 'blob', sha: sha(text) }));
      return send(200, { truncated, tree: truncated ? tree.slice(0, 1) : tree });
    }
    if (url === '/api/v1/repos/o/r/git/blobs') {
      hits.batch++;
      if (!batchRoute) return send(404, { message: 'not found' }); // Gitea has no GetBlobs
      const texts = new URL(req.url, 'http://stub').searchParams.get('shas').split(',')
        .map((want) => Object.values(records).find((x) => sha(x) === want));
      return send(200, texts.map((x) => ({ sha: sha(x), encoding: 'base64', content: Buffer.from(x).toString('base64') })));
    }
    if (url.startsWith('/api/v1/repos/o/r/git/blobs/')) {
      hits.blob++;
      const text = Object.values(records).find((x) => sha(x) === url.split('/').at(-1));
      return text ? send(200, { encoding: 'base64', content: Buffer.from(text).toString('base64') }) : send(404, {});
    }
    if (url === '/api/v1/repos/o/r/contents/docs/handoffs/records') {
      hits.listing++;
      return send(200, Object.entries(records).filter(([p]) => p.split('/').length === 4)
        .map(([p, text]) => ({ name: p.split('/').at(-1), type: 'file', sha: sha(text) }))
        .concat([{ name: 'notes', type: 'dir', sha: 'd' }]));
    }
    hits.contents++;
    return send(404, { message: 'unexpected' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), 'gtg-tree-'));
  mkdirSync(join(root, '.gtg'));
  writeFileSync(join(root, '.gtg', 'forge.json'), JSON.stringify({
    api: `http://127.0.0.1:${server.address().port}/api/v1`, repo: 'o/r', store: 'files',
  }));
  const run = (args, input = '') => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { ...process.env, GTG_HUB: root, GTG_NO_SYNC: '1', GTG_SESSION_ID: 'tree-test', FORGEJO_TOKEN: 'tok', ...coldCache() },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (x) => { stdout += x; });
    child.stderr.on('data', (x) => { stderr += x; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  const reset = () => { for (const k of Object.keys(hits)) hits[k] = 0; };

  const listed = await run(['list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Alpha/);
  assert.doesNotMatch(listed.stdout, /Gamma/, 'a file in a subfolder of records/ is not a record');
  assert.deepEqual(hits, { tree: 1, batch: 1, blob: 0, listing: 0, contents: 0 });
  assert.match((await run(['resume', 'alpha'])).stdout, /alpha body/);

  // list --json reads the same records, each with its handoff body (null when it has none), and writes nothing.
  const json = await run(['list', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const doc = JSON.parse(json.stdout);
  assert.deepEqual(doc.active.map((x) => [x.slug, x.shelf, x.next, x.handoff]), [['alpha', 'active', 'Ship alpha', 'alpha body']]);
  assert.deepEqual(doc.backlog.map((x) => [x.slug, x.shelf, x.next, x.handoff]), [['beta', 'backlog', 'Ship beta', null]]);
  assert.equal(puts.length, 0, 'list --json writes nothing');

  // A PUT after a tree read carries the blob sha from the tree, which is the sha the contents API checks.
  const handoff = await run(['handoff', '--project', 'Alpha', '--slug', 'alpha'], '## Next Action\nShip more\n');
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].method, 'PUT');
  assert.equal(puts[0].url, '/api/v1/repos/o/r/contents/docs/handoffs/records/alpha.json');
  assert.equal(puts[0].body.sha, sha(records['docs/handoffs/records/alpha.json']));

  // A truncated tree may be missing records, so the listing supplies the names and shas instead.
  // Without the batch route each blob is read on its own.
  truncated = true;
  batchRoute = false;
  reset();
  const fallback = await run(['backlog']);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /Beta/);
  assert.deepEqual(hits, { tree: 1, batch: 1, blob: 2, listing: 1, contents: 0 });
});

test('list --json and show print a forge record as stored: every field, and the handoff byte for byte', async (t) => {
  // `file` is a field the adapter blanks for the writers, and resume trims the body. The read
  // commands promise what the store holds, so neither may reach them.
  const handoff = '    code\n\n  indented line\n\n\n';
  const records = {
    'docs/handoffs/records/alpha.json': JSON.stringify({ slug: 'alpha', project: 'Alpha', shelf: 'active', next: 'Ship alpha', file: 'docs/handoffs/current/alpha.md', extra: { kept: true }, handoff }),
    'docs/handoffs/records/beta.json': JSON.stringify({ slug: 'beta', project: 'Beta', shelf: 'backlog', next: 'Ship beta' }),
  };
  let writes = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const url = new URL(req.url, 'http://stub');
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method !== 'GET') { writes++; return send(500, { message: 'no writes expected' }); }
    if (url.pathname === '/api/v1/repos/o/r/git/trees/HEAD') {
      return send(200, { truncated: false, tree: Object.entries(records).map(([path, text]) => ({ path, type: 'blob', sha: sha(text) })) });
    }
    if (url.pathname === '/api/v1/repos/o/r/git/blobs') {
      const texts = url.searchParams.get('shas').split(',').map((want) => Object.values(records).find((x) => sha(x) === want));
      return send(200, texts.map((x) => ({ sha: sha(x), encoding: 'base64', content: Buffer.from(x).toString('base64') })));
    }
    return send(404, { message: 'unexpected' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = hubWith({ api: `http://127.0.0.1:${server.address().port}/api/v1`, repo: 'o/r', store: 'files' });
  const env = coldCache();

  const listed = await runIn(root, ['list', '--json'], env);
  assert.equal(listed.status, 0, listed.stderr);
  const doc = JSON.parse(listed.stdout);
  assert.deepEqual(doc.active, [{ ...JSON.parse(records['docs/handoffs/records/alpha.json']), shelf: 'active', handoff }]);
  assert.deepEqual(doc.backlog, [{ ...JSON.parse(records['docs/handoffs/records/beta.json']), shelf: 'backlog', handoff: null }]);
  const shown = await runIn(root, ['show', 'alpha', '--json'], env);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), doc.active[0]);
  const plain = await runIn(root, ['show', 'alpha'], env);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, handoff, 'show prints the stored handoff exactly');
  // The records carry no `updated`, so each is REVIEW-eligible and a command that takes the review
  // stamps one (resume below does). The three reads above wrote nothing.
  assert.equal(writes, 0, 'the read commands write nothing');
  assert.match((await runIn(root, ['resume', 'alpha'], env)).stdout, /code[\s\S]*indented line/, 'resume still reads the body');
});

// An empty store: no commit yet, so the tree and the records listing are both 404 and the repo exists.
async function emptyStore(t) {
  const auth = new Set();
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    auth.add(req.headers.authorization);
    const found = new URL(req.url, 'http://stub').pathname === '/api/v1/repos/o/r';
    res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    res.end(found ? '{}' : '{"message":"missing"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { api: `http://127.0.0.1:${server.address().port}/api/v1`, auth };
}

function hubWith(config) {
  const root = mkdtempSync(join(tmpdir(), 'gtg-cfg-'));
  mkdirSync(join(root, '.gtg'));
  writeFileSync(join(root, '.gtg', 'forge.json'), JSON.stringify(config));
  return root;
}

function runIn(root, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { ...process.env, GTG_HUB: root, GTG_NO_SYNC: '1', GTG_SESSION_ID: 'cfg-test', FORGEJO_TOKEN: 'tok', ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (x) => { stdout += x; });
    child.stderr.on('data', (x) => { stderr += x; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end('');
  });
}

test('config without a token is refused, a token file is read, and history commands are refused', async (t) => {
  const { api, auth } = await emptyStore(t);
  const root = hubWith({ api, repo: 'o/r', store: 'files' });
  const none = await runIn(root, ['list'], { FORGEJO_TOKEN: '' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no token/);

  // forgejo-cli's keys.json shape, keyed by the api's host.
  const keys = join(root, 'keys.json');
  writeFileSync(keys, JSON.stringify({ hosts: { [new URL(api).host]: { type: 'Application', token: 'fromfile' } } }));
  const fileRoot = hubWith({ api, repo: 'o/r', store: 'files', tokenFile: '${GTG_TEST_KEYS}' });
  const ok = await runIn(fileRoot, ['list'], { FORGEJO_TOKEN: '', GTG_TEST_KEYS: keys });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(auth.has('token fromfile'));

  for (const cmd of ['log', 'undo', 'stats', 'report']) {
    const r = await runIn(root, [cmd]);
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /not available on the forge store/, cmd);
  }
});

test('a config without "store": "files" is refused before any request, since the milestone store is gone', async (t) => {
  const { api, auth } = await emptyStore(t);
  for (const store of [undefined, 'milestones']) {
    const r = await runIn(hubWith({ api, repo: 'o/r', store }), ['list']);
    assert.equal(r.status, 2, String(store));
    assert.match(r.stderr, /needs "store": "files"/, String(store));
  }
  assert.equal(auth.size, 0, 'no request reaches the forge');
});
