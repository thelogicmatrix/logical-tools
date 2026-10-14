// Retry-safe forge writes (#28): a write whose answer was lost, a write that never landed, a
// concurrent edit in another session, and a DELETE of a record already gone. The real CLI runs
// against a stub of the Forgejo contents API that checks the sha the way Forgejo does. A lost
// answer is a dropped connection after the stub applied the write: fetch rejects exactly as it
// does on a timeout, so both take the same path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openForge } from '../skills/gtg/lib/forge.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');
const PATH = 'docs/handoffs/records/alpha.json';
const sha = (text) => createHash('sha1').update(text).digest('hex');
const file = (rec) => JSON.stringify(rec, null, 2) + '\n';
// Key order as gtg writes it, handoff last, so an unchanged record round-trips without a write.
const ALPHA = { slug: 'alpha', project: 'Alpha', shelf: 'active', next: 'Ship it', updated: '2026-09-28T10:00:00+00:00', sessions: 1, handoff: '## Next Action\nShip it\n' };
// What another session's handoff leaves in the record.
const THEIRS = { ...ALPHA, next: 'Their next', updated: '2026-09-28T12:00:00+00:00', sessions: 2, handoff: '## Next Action\nTheir next\n' };

// onWrite(stub, method, path) runs before each write is applied. It may edit stub.files (another
// session) and may return 'drop-before' (the write never lands) or 'drop-after' (it lands and the
// answer is lost). Status codes are the ones the live Forgejo gave on 2026-09-29 (a scratch repo):
// a stale sha is 409 on PUT and 400 on DELETE, a POST over an existing file 422, a PUT to a deleted
// path 500, a DELETE of a missing file 404.
async function stubStore(t, initial = {}) {
  const stub = { files: new Map(Object.entries(initial)), commits: 0, attempts: [], writes: [], onWrite: null };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://stub');
    const p = decodeURIComponent(url.pathname.replace('/api/v1/repos/o/r', ''));
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const { files } = stub;
    if (req.method === 'GET' && p === '/git/trees/HEAD') {
      return send(200, { truncated: false, tree: [...files].map(([path, text]) => ({ path, type: 'blob', sha: sha(text) })) });
    }
    if (req.method === 'GET' && p === '/git/blobs') {
      return send(200, url.searchParams.get('shas').split(',').map((want) => {
        const text = [...files.values()].find((x) => sha(x) === want);
        return { sha: want, encoding: 'base64', content: Buffer.from(text).toString('base64') };
      }));
    }
    const path = p.replace('/contents/', '');
    if (req.method === 'GET') {
      const now = files.get(path);
      return now ? send(200, { sha: sha(now), content: Buffer.from(now).toString('base64'), html_url: `http://stub/${path}` })
        : send(404, { message: 'not found' });
    }
    stub.attempts.push(req.method);
    stub.writes.push(`${req.method} ${path}`);
    const fate = stub.onWrite?.(stub, req.method, path);
    if (fate === 'drop-before') return req.socket.destroy();
    const old = files.get(path);
    let status = 200; let out = {};
    if (req.method === 'DELETE') {
      if (!old) status = 404;
      else if (body.sha !== sha(old)) status = 400;
      else { files.delete(path); stub.commits++; }
    } else if (req.method === 'POST' && old) status = 422;
    else if (req.method === 'PUT' && !old) status = 500;
    else if (req.method === 'PUT' && body.sha !== sha(old)) status = 409;
    else {
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      files.set(path, text); stub.commits++;
      out = { content: { sha: sha(text), html_url: `http://stub/${path}` } };
    }
    if (status !== 200) out = { message: status === 404 ? 'not found' : 'sha does not match' };
    if (fate === 'drop-after') return req.socket.destroy();
    send(status, out);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  stub.root = mkdtempSync(join(tmpdir(), 'gtg-write-'));
  mkdirSync(join(stub.root, '.gtg'));
  writeFileSync(join(stub.root, '.gtg', 'forge.json'), JSON.stringify({
    api: `http://127.0.0.1:${server.address().port}/api/v1`, repo: 'o/r', store: 'files',
  }));
  stub.run = (args, input = '') => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: stub.root,
      env: { ...process.env, GTG_HUB: stub.root, GTG_NO_SYNC: '1', GTG_SESSION_ID: 'write-test', FORGEJO_TOKEN: 'tok' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (x) => { stdout += x; });
    child.stderr.on('data', (x) => { stderr += x; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  stub.record = () => JSON.parse(stub.files.get(PATH));
  stub.cfg = { api: `http://127.0.0.1:${server.address().port}/api/v1`, repo: 'o/r', token: 'tok', store: 'files' };
  return stub;
}
// Runs fn on the first write only.
const first = (fn) => { let done = false; return (...args) => { if (done) return undefined; done = true; return fn(...args); }; };
// Another session's handoff lands between this command's read and its first write. A fresh one per
// test, since first() keeps state.
const theirHandoffLands = () => first((s) => { s.files.set(PATH, file(THEIRS)); });
const handoff = (stub, next) => stub.run(['handoff', '--project', 'Alpha', '--slug', 'alpha'], `## Next Action\n${next}\n`);
const savedBody = (stub) => readFileSync(join(stub.root, 'docs', 'handoffs', 'current', 'alpha.md'), 'utf8');

const guardedHandoff = (stub, rec = ALPHA) => stub.run([
  'handoff', '--project', 'Alpha', '--slug', rec.slug,
  '--expected-body-sha256', createHash('sha256').update(rec.handoff, 'utf8').digest('hex'),
  '--expected-shelf', rec.shelf,
], '## Next Action\nGuarded result\n');

test('guarded Forge handoff hashes the exact JSON whitespace and writes the original snapshot', async (t) => {
  const original = { ...ALPHA, handoff: ' \r\n## Next Action\nShip it\n\n  ' };
  const stub = await stubStore(t, { [PATH]: file(original) });
  const listed = await stub.run(['list', '--json']);
  const record = JSON.parse(listed.stdout).active[0];
  assert.equal(record.handoff, original.handoff);
  const r = await guardedHandoff(stub, record);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.commits, 1);
  assert.match(stub.record().handoff, /Guarded result/);
});

test('guarded Forge handoff refuses caller-stale body, shelf and missing record before any write', async (t) => {
  for (const record of [THEIRS, { ...ALPHA, shelf: 'backlog' }, null]) {
    const stub = await stubStore(t, record ? { [PATH]: file(record) } : {});
    const before = new Map(stub.files);
    const r = await guardedHandoff(stub);
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(stub.files, before);
    assert.deepEqual(stub.attempts, []);
    assert.ok(!existsSync(join(stub.root, 'docs/handoffs/current/alpha.md')));
  }
});

test('guarded Forge handoff retains conflict protection after comparison, including shelf changes and deletion', async (t) => {
  for (const newer of [THEIRS, { ...ALPHA, shelf: 'backlog' }, null]) {
    const stub = await stubStore(t, { [PATH]: file(ALPHA) });
    stub.onWrite = first((s) => { if (newer) s.files.set(PATH, file(newer)); else s.files.delete(PATH); });
    const r = await guardedHandoff(stub);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(stub.commits, 0);
    assert.deepEqual(stub.attempts, ['PUT']);
    assert.equal(stub.files.get(PATH), newer ? file(newer) : undefined);
    assert.match(savedBody(stub), /Guarded result/);
    assert.doesNotMatch(r.stdout, /RESUME:/);
  }
});

test('a PUT whose answer was lost after the server applied it succeeds without a resend: one commit', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = first(() => 'drop-after');
  const r = await handoff(stub, 'Ship more');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['PUT']);
  assert.equal(stub.commits, 1);
  assert.match(stub.record().handoff, /Ship more/);
});

test('a POST whose answer was lost after the server applied it succeeds without a resend: one commit', async (t) => {
  const stub = await stubStore(t);
  stub.onWrite = first(() => 'drop-after');
  const r = await handoff(stub, 'First');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['POST']);
  assert.equal(stub.commits, 1);
  assert.match(stub.record().handoff, /First/);
});

test('a write that never landed is read back, found unchanged, and sent once more', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = first(() => 'drop-before');
  const r = await handoff(stub, 'Ship more');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['PUT', 'PUT']);
  assert.equal(stub.commits, 1);
  assert.match(stub.record().handoff, /Ship more/);
});

test('a write that never lands is sent at most twice, and the handoff body is kept on disk', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = () => 'drop-before';
  const r = await handoff(stub, 'Ship more');
  assert.equal(r.status, 1);
  assert.deepEqual(stub.attempts, ['PUT', 'PUT']);
  assert.equal(stub.commits, 0);
  assert.match(r.stderr, /PUT docs\/handoffs\/records\/alpha\.json -> no answer/, 'the error names the record');
  assert.match(savedBody(stub), /Ship more/);
  assert.equal(r.stderr.split('\n').filter((line) => line.includes('forge write failed')).length, 1,
    'dispatch must not repeat the handled handoff failure');
  assert.doesNotMatch(r.stdout, /RESUME:/, 'a failed handoff cannot read as successfully parked');
});

test('a failed backlog park reports once and keeps its body', async (t) => {
  const stub = await stubStore(t);
  stub.onWrite = () => 'drop-before';
  const r = await stub.run(['backlog', '--project', 'Alpha', '--slug', 'alpha'], '## Next Action\nKeep this idea\n');
  assert.equal(r.status, 1);
  assert.equal(stub.commits, 0);
  assert.deepEqual(stub.attempts, ['POST', 'POST']);
  assert.equal(r.stderr.split('\n').filter((line) => line.includes('forge write failed')).length, 1,
    'dispatch must not repeat the handled backlog failure');
  assert.match(savedBody(stub), /Keep this idea/);
  assert.doesNotMatch(r.stdout, /PARKED on backlog:/);
});

test('a successful backlog park flushes its record and prints the success', async (t) => {
  const stub = await stubStore(t);
  const r = await stub.run(['backlog', '--project', 'Alpha', '--slug', 'alpha'], '## Next Action\nExplore idea\n');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['POST']);
  assert.equal(stub.commits, 1);
  assert.equal(stub.record().shelf, 'backlog');
  assert.match(stub.record().handoff, /Explore idea/);
  assert.match(r.stdout, /PARKED on backlog: "Alpha"/);
});

test('a concurrent edit to other fields is re-read and the edit re-applied once on top of it', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = theirHandoffLands();
  const r = await stub.run(['back', 'alpha', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['PUT', 'PUT'], 'one rejected PUT, one re-applied PUT');
  assert.equal(stub.commits, 1);
  const rec = stub.record();
  assert.equal(rec.shelf, 'backlog', 'our edit');
  assert.equal(rec.handoff, THEIRS.handoff, 'their edit survives');
  assert.equal(rec.next, THEIRS.next);
  assert.equal(rec.sessions, 2);
  assert.ok(rec.updated > THEIRS.updated, 'the later timestamp wins');
});

test('a concurrent edit to the same field is a clear error, their record is kept and our body saved', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = theirHandoffLands();
  const r = await handoff(stub, 'Mine');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /alpha changed in another session .*handoff/);
  assert.deepEqual(stub.attempts, ['PUT']);
  assert.equal(stub.record().handoff, THEIRS.handoff);
  assert.match(savedBody(stub), /Mine/);
});

test('a record that changes again during the re-apply is a clear error after one re-apply', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  let n = 0;
  stub.onWrite = (s) => { n++; s.files.set(PATH, file({ ...THEIRS, sessions: 1 + n, handoff: `edit ${n}\n` })); };
  const r = await stub.run(['back', 'alpha', '--no-list']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /alpha changed in another session/);
  assert.deepEqual(stub.attempts, ['PUT', 'PUT']);
  assert.equal(stub.record().shelf, 'active');
});

test('DELETE of a record another session already deleted is success', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = (s) => { s.files.delete(PATH); };
  const r = await stub.run(['complete', 'alpha', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['DELETE']);
  assert.equal(stub.files.size, 0);
});

test('a DELETE whose answer was lost is success, and one of a record changed since the read is refused', async (t) => {
  const lost = await stubStore(t, { [PATH]: file(ALPHA) });
  lost.onWrite = first(() => 'drop-after');
  const r = await lost.run(['complete', 'alpha', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lost.attempts, ['DELETE']);
  assert.equal(lost.commits, 1);

  const changed = await stubStore(t, { [PATH]: file(ALPHA) });
  changed.onWrite = theirHandoffLands();
  const refused = await changed.run(['complete', 'alpha', '--no-list']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /alpha changed in another session/, 'the 400 Forgejo gives a stale DELETE is read back too');
  assert.deepEqual(changed.attempts, ['DELETE']);
  assert.equal(changed.record().handoff, THEIRS.handoff, 'their handoff is not deleted');
  assert.equal(existsSync(join(changed.root, 'docs')), false);
});

test('a re-applied handoff is written once, and the flush after it finds nothing left to write', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = first((s) => { s.files.set(PATH, file({ ...ALPHA, eta: '2h' })); });
  const r = await handoff(stub, 'Mine');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['PUT', 'PUT'], 'handoff flushes twice, the second one writes nothing');
  const rec = stub.record();
  assert.equal(rec.eta, '2h', 'their field survives');
  assert.match(rec.handoff, /Mine/);
});

test('the re-apply PUT is sent once: a lost answer on it is read back, never resent', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  let n = 0;
  stub.onWrite = (s) => {
    n++;
    if (n === 1) s.files.set(PATH, file(THEIRS));
    return n === 2 ? 'drop-before' : undefined;
  };
  const r = await stub.run(['back', 'alpha', '--no-list']);
  assert.equal(r.status, 1);
  assert.deepEqual(stub.attempts, ['PUT', 'PUT'], 'the rejected PUT and one re-apply, no third');
  assert.equal(stub.record().shelf, 'active');
});

test('a re-apply that moves a record to another shelf holds when a later record fails and the flush runs again', async (t) => {
  const BETA_PATH = PATH.replace('alpha', 'beta');
  const stub = await stubStore(t, { [PATH]: file(ALPHA), [BETA_PATH]: file({ ...ALPHA, slug: 'beta', project: 'Beta' }) });
  const forge = await openForge(stub.cfg);
  forge.save('active', forge.entries('active').map((e) => ({ ...e, next: `${e.next}, mine` })));
  // Another session parks alpha before this flush writes it, and beta's writes never land.
  stub.onWrite = (s, method, path) => {
    if (path === PATH && JSON.parse(s.files.get(PATH)).shelf === 'active') s.files.set(PATH, file({ ...ALPHA, shelf: 'backlog' }));
    return path === BETA_PATH ? 'drop-before' : undefined;
  };
  await assert.rejects(forge.flush('test'), /beta\.json/);
  stub.onWrite = null;
  await forge.flush('test'); // a handoff flushes again at dispatch end
  assert.equal(stub.record().shelf, 'backlog', 'their shelf move survives the second flush');
  assert.equal(stub.record().next, 'Ship it, mine');
  assert.deepEqual(stub.writes.filter((w) => w.endsWith('/alpha.json')), [`PUT ${PATH}`, `PUT ${PATH}`],
    'alpha: the rejected PUT and the re-apply, nothing on the second flush');
});

test('upnext on the forge store writes the record once and leaves updated and sessions alone', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  const r = await stub.run(['upnext', 'alpha', '--text', 'Then the docs']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.commits, 1);
  const rec = stub.record();
  assert.match(rec.handoff, /## Up next\n- Then the docs/);
  assert.equal(rec.updated, ALPHA.updated);
  assert.equal(rec.sessions, ALPHA.sessions);
  const { handoff: _, ...metadata } = rec;
  const { handoff: __, ...before } = ALPHA;
  assert.deepEqual(metadata, before);
});
