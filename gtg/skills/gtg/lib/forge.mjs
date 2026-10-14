// Optional forge store: each gtg project is one JSON file under docs/handoffs/records/ in a
// dedicated Forgejo/Gitea repository, record and current handoff together. Design:
// references/forge-store.md. The milestone store (a project as a milestone, handoffs as issue
// comments) was removed on 2026-09-29 (#31): nothing used it.
//
// The CLI's store calls are synchronous (entries/saveEntries) and HTTP is not, so this loads every
// record once, lets the command edit the in-memory copy exactly as it edits the file store, and
// writes the difference in flush(). A separate module rather than a branch in lib/store.mjs,
// because that file is vendored from lib-cli (test/framework.test.mjs pins it).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// null = no forge configured, the file store runs exactly as before.
export function forgeConfig(root, env = process.env) {
  const p = join(root, '.gtg', 'forge.json');
  if (!existsSync(p)) return null;
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error(`cannot parse .gtg/forge.json - ${e.message}`); }
  if (typeof cfg.api !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(cfg.repo ?? '')) {
    throw new Error('.gtg/forge.json needs "api" (the /api/v1 URL) and "repo" (owner/name)');
  }
  if (cfg.store !== 'files') throw new Error('.gtg/forge.json needs "store": "files". The milestone store was removed');
  const token = env.FORGEJO_TOKEN || readToken(cfg, env);
  if (!token) throw new Error('.gtg/forge.json is set but there is no token: set FORGEJO_TOKEN or "tokenFile"');
  return { api: cfg.api.replace(/\/+$/, ''), repo: cfg.repo, token };
}

// A bare token file, or forgejo-cli's keys.json ({ hosts: { "<host:port>": { token } } }).
function readToken(cfg, env) {
  if (typeof cfg.tokenFile !== 'string') return '';
  const path = cfg.tokenFile.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? '');
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8').trim();
  if (!text.startsWith('{')) return text;
  try { return JSON.parse(text)?.hosts?.[new URL(cfg.api).host]?.token ?? ''; } catch { return ''; }
}

// Reads are retried, writes never are: a PUT or POST that timed out may have landed, and sending it
// again would double it or trip the SHA check. openForge's write() reads the record back and
// decides instead. 2026-09-29: with a dozen gtg processes starting at
// once (session hooks, parallel sessions) one slow GET of 15 aborted the whole read. Three tries of
// 8s each, since a healthy call takes under a second.
// `until` (a Date.now() value) caps the whole call, retries included: no attempt runs past it and
// no retry starts that would.
const RETRIES = 3;
async function send(fetchImpl, url, init, until = Infinity) {
  const read = init.method === 'GET';
  for (let attempt = 1; ; attempt++) {
    const ms = Math.max(1, Math.min(read ? 8000 : 15000, until - Date.now()));
    const pause = 300 * attempt;
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) });
      if (!read || res.status < 500 || attempt === RETRIES || Date.now() + pause >= until) return res;
    } catch (e) {
      if (!read || attempt === RETRIES || Date.now() + pause >= until) throw e;
    }
    await new Promise((r) => setTimeout(r, pause));
  }
}

// #29: with the hub unreachable (Tailscale down, packets dropped) a read used to cost three 8 s
// attempts plus backoff, about 25 s, before failing. The whole read now stops at 10 s.
const READ_CAP_MS = 10000;

// Blobs cached by sha under the tmp dir, plus the last tree read. A blob never changes under its
// sha, so the cache is correct by construction: a warm read fetches only the blobs it has not seen,
// and with the hub unreachable the last tree and its blobs serve read-only commands, marked stale.
// Every cache step is best effort. A cache that cannot be read or written costs speed, not a read.
const cacheDir = (cfg) => join(tmpdir(), 'gtg-forge-cache',
  createHash('sha1').update(`${cfg.api}|${cfg.repo}`).digest('hex').slice(0, 16));
const DAY = 86400000;
function atomicWrite(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
function cachedBlob(dir, sha) {
  try { return readFileSync(join(dir, `${sha}.json`), 'utf8'); } catch { return undefined; }
}
function saveCache(dir, files) {
  try {
    mkdirSync(dir, { recursive: true });
    for (const f of files) if (cachedBlob(dir, f.sha) === undefined) atomicWrite(join(dir, `${f.sha}.json`), f.text);
    atomicWrite(join(dir, 'tree.json'), JSON.stringify({ at: new Date().toISOString(), files: files.map(({ name, sha }) => ({ name, sha })) }));
    // Blobs the tree no longer names, once a day old, so a concurrent process's newer blobs stay.
    const live = new Set(files.map((f) => `${f.sha}.json`));
    for (const name of readdirSync(dir)) {
      if (name === 'tree.json' || live.has(name)) continue;
      const p = join(dir, name);
      if (Date.now() - statSync(p).mtimeMs > DAY) unlinkSync(p);
    }
  } catch { /* best effort */ }
}
function staleCopy(dir) {
  try {
    const { at, files } = JSON.parse(readFileSync(join(dir, 'tree.json'), 'utf8'));
    const out = files.map((f) => ({ ...f, text: cachedBlob(dir, f.sha) }));
    if (out.some((f) => f.text === undefined)) return null;
    out.stale = at;
    return out;
  } catch { return null; }
}

const RECORDS = 'docs/handoffs/records/';

// Every record file in a "store": "files" repo as { name, sha, text }, from the git tree and one
// batch of blobs. 2026-09-29 (#27): the contents listing costs the server a last-commit lookup per
// entry, 525 to 618 ms of a 900 ms run at 14 records, and the tree costs about 40 ms. The blob sha
// is the sha the contents API checks on PUT and DELETE. The listing is only the fallback, for a
// truncated tree or a repo with no commit yet. Exported for hooks that only need to read the store.
//
// With the hub unreachable (no answer within the cap, or a 5xx) and a cached copy on disk, returns
// that copy with `stale` set to when it was read. A 4xx is a real answer and is thrown as before.
export async function readFileRecords(cfg, fetchImpl = fetch) {
  const dir = cacheDir(cfg);
  try {
    const files = await readLive(cfg, fetchImpl, dir);
    saveCache(dir, files);
    return files;
  } catch (e) {
    const stale = e.unreachable ? staleCopy(dir) : null;
    if (!stale) throw e;
    return stale;
  }
}

async function readLive(cfg, fetchImpl, dir) {
  const until = Date.now() + READ_CAP_MS;
  const get = async (path) => {
    let res;
    try {
      res = await send(fetchImpl, `${cfg.api}/repos/${cfg.repo}${path}`, {
        method: 'GET', headers: { Authorization: `token ${cfg.token}`, Accept: 'application/json' },
      }, until);
    } catch (e) { throw Object.assign(e, { unreachable: true }); }
    if (!res.ok) res.error = `forge GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status >= 500) throw Object.assign(new Error(res.error), { unreachable: true });
    return res;
  };
  let files;
  const tree = await get('/git/trees/HEAD?recursive=true');
  if (tree.ok) {
    const t = await tree.json();
    if (!t.truncated) {
      files = t.tree.filter((e) => e.type === 'blob' && e.path.startsWith(RECORDS) && e.path.endsWith('.json')
        && !e.path.slice(RECORDS.length).includes('/')).map((e) => ({ name: e.path.slice(RECORDS.length), sha: e.sha }));
    }
  }
  if (!files) {
    const names = await get(`/contents/${RECORDS.slice(0, -1)}`);
    if (names.status === 404) {
      const repo = await get('');
      if (!repo.ok) throw new Error(`forge GET repo ${cfg.repo} -> ${repo.status}`);
      files = [];
    } else if (!names.ok) throw new Error(names.error);
    else files = (await names.json()).filter((f) => f.name?.endsWith('.json'));
  }
  // Forgejo's GetBlobs takes a comma list of shas, 40 of them keep the URL under its ~2000 character
  // limit. A server without that route (Gitea) answers 404 and gets one GET per blob instead.
  const content = new Map(); // sha -> record text
  const decode = (b64) => Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
  for (const f of files) {
    const text = cachedBlob(dir, f.sha);
    if (text !== undefined) content.set(f.sha, text);
  }
  const shas = [...new Set(files.map((f) => f.sha))].filter((sha) => !content.has(sha));
  const one = async (sha) => {
    const blob = await get(`/git/blobs/${sha}`);
    if (!blob.ok) throw new Error(blob.error);
    content.set(sha, decode((await blob.json()).content));
  };
  await Promise.all(Array.from({ length: Math.ceil(shas.length / 40) }, async (_, i) => {
    const chunk = shas.slice(i * 40, i * 40 + 40);
    const batch = await get(`/git/blobs?shas=${chunk.join(',')}`);
    if (batch.status === 404) return Promise.all(chunk.map(one));
    if (!batch.ok) throw new Error(batch.error);
    for (const b of await batch.json()) content.set(b.sha, decode(b.content));
  }));
  return files.map((f) => {
    if (!content.has(f.sha)) throw new Error(`forge GET blob ${f.sha} for ${RECORDS}${f.name} -> missing`);
    return { name: f.name, sha: f.sha, text: content.get(f.sha) };
  });
}

// Our edit since the read, put on top of the record another session wrote meanwhile. A field only
// we changed takes our value, every other field keeps theirs. A field both sides changed to
// different values is a conflict, except `updated`, a timestamp, where the later one wins. The
// handoff goes last, the order flush() writes, so a second flush sees no difference.
function reapply(base, mine, theirs) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const merged = { ...theirs };
  const clash = [];
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    if (same(mine[k], base[k]) || same(mine[k], theirs[k])) continue;
    if (k === 'updated') { if (!(theirs[k] > mine[k])) merged[k] = mine[k]; continue; }
    if (!same(theirs[k], base[k])) { clash.push(k); continue; }
    if (mine[k] === undefined) delete merged[k]; else merged[k] = mine[k];
  }
  if ('handoff' in merged) { const { handoff } = merged; delete merged.handoff; merged.handoff = handoff; }
  return clash.length ? { clash } : { merged };
}

// One JSON file contains both record and current handoff. One SHA-protected PUT changes both.
export async function openForge(cfg, fetchImpl = fetch) {
  const sourceSlug = Symbol('gtg-file-source-slug');
  const base = `${cfg.api}/repos/${cfg.repo}/contents/`;
  const records = RECORDS;
  // Errors name the method and path, never the headers, so the token cannot reach a transcript.
  const request = (method, path, body) => send(fetchImpl, base + path, {
    method,
    headers: { Authorization: `token ${cfg.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const failure = async (method, path, res) => new Error(`forge ${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  // The record at path as the server holds it now, or null when there is none.
  const current = async (path) => {
    const res = await request('GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw await failure('GET', path, res);
    const f = await res.json();
    return { sha: f.sha, url: f.html_url, rec: JSON.parse(Buffer.from(f.content.replace(/\s/g, ''), 'base64').toString('utf8')) };
  };
  // One write, safe to repeat (#28). When the answer is lost (no response, or a 5xx) or the server
  // refuses the sha, this reads the record back and decides from what it finds:
  //   - what we meant to write (want, a serialized record, or null for a delete): it landed
  //   - the record as we read it (oldSha, or absent for a create): it never landed, so a lost
  //     answer is sent again while sends < limit, and a refusal is thrown as it came, since no
  //     session caused it
  //   - anything else: another session wrote it meanwhile, handed back as { theirs } to re-apply
  // Never a blind resend: the read-back is what makes the second send safe. Refusals, from the live
  // Forgejo on 2026-09-29: a stale sha is 409 on PUT but 400 on DELETE, a POST over an existing
  // file is 422, and a PUT to a path another session deleted is 500 (lost, then read back).
  const REFUSED = new Set([400, 409, 422]);
  const write = async (method, path, payload, want, oldSha, limit = 2, createOnly = false) => {
    // Stale data never feeds a write. The dispatcher refuses writes up front, this is the backstop.
    if (read.stale) throw new Error('the hub is unreachable and this command read the cached store (stale), so nothing was written. Re-run it when the hub is back');
    for (let sends = 1; ; sends++) {
      let res, err;
      try { res = await request(method, path, payload); } catch (e) {
        err = new Error(`forge ${method} ${path} -> no answer (${e.cause?.code ?? e.message})`);
      }
      if (res?.ok) {
        const out = res.status === 204 ? null : await res.json();
        return { sha: out?.content?.sha, url: out?.content?.html_url };
      }
      if (method === 'DELETE' && res?.status === 404) return {}; // already gone
      const lost = !res || res.status >= 500;
      if (!lost && !REFUSED.has(res.status)) throw await failure(method, path, res);
      err ??= await failure(method, path, res);
      let now;
      try { now = await current(path); } catch (e) {
        throw new Error(`${err.message}, and reading it back failed${lost ? ', so the write may have landed' : ''} - ${e.message}`);
      }
      // A definite rejected create belongs to another writer, even when the bytes match.
      // A lost answer can still be proven landed by the existing exact read-back protocol.
      if (createOnly && !lost && now) throw new Error('project slug already exists; create-only did not overwrite it');
      if (want === null ? !now : now && JSON.stringify(now.rec) === want) return { sha: now?.sha, url: now?.url };
      if ((now?.sha ?? null) === (oldSha ?? null)) {
        if (lost && sends < limit) continue;
        throw err;
      }
      return { theirs: now };
    }
  };
  const read = await readFileRecords(cfg, fetchImpl);
  const loaded = read.map((f) => {
    let rec;
    try { rec = JSON.parse(f.text); } catch (e) { throw new Error(`cannot parse ${records}${f.name} - ${e.message}`); }
    if (typeof rec.slug !== 'string' || !['active', 'backlog'].includes(rec.shelf)
      || (rec.handoff !== undefined && typeof rec.handoff !== 'string')) {
      throw new Error(`invalid gtg record at ${records}${f.name}`);
    }
    return { rec, sha: f.sha, fileSlug: f.name.slice(0, -5) };
  });
  const saved = new Map(loaded.map(({ rec, sha, fileSlug }) => [fileSlug, { rec: JSON.stringify(rec), sha }]));
  const bodyBySlug = new Map(loaded.map(({ rec, fileSlug }) => [fileSlug, rec.handoff]));
  const storedBySlug = new Map(loaded.map(({ rec, fileSlug }) => [fileSlug, rec]));
  const entry = (rec, fileSlug) => { const { handoff, ...rest } = rec; return { ...rest, file: undefined, [sourceSlug]: fileSlug }; };
  const shelves = {
    active: loaded.filter(({ rec }) => rec.shelf === 'active').map(({ rec, fileSlug }) => entry(rec, fileSlug)),
    backlog: loaded.filter(({ rec }) => rec.shelf === 'backlog').map(({ rec, fileSlug }) => entry(rec, fileSlug)),
  };
  const pending = new Map();
  const handoffGuards = new Map();
  const requiredAbsent = new Set();
  let failedHandoff = false;
  return {
    // When the read came from the local cache because the hub was unreachable: the time of that
    // cached read. null for a live read.
    stale: read.stale ?? null,
    entries: (which) => shelves[which].map((r) => ({ ...r })),
    save(which, items) {
      shelves[which] = items.map((r) => {
        const previous = [...shelves.active, ...shelves.backlog].find((x) => x.slug === r.slug);
        return { ...r, [sourceSlug]: r[sourceSlug] ?? previous?.[sourceSlug] };
      });
      return [];
    },
    queueHandoff(slug, body, { createOnly = false, expectedBodySha256, expectedShelf } = {}) {
      pending.set(slug, body);
      if (createOnly) requiredAbsent.add(slug);
      if (expectedBodySha256) handoffGuards.set(slug, { hash: expectedBodySha256, shelf: expectedShelf });
    },
    locationOf: (rec) => `${records}${rec[sourceSlug] ?? rec.slug}.json`,
    async latestHandoff(rec) { return bodyBySlug.get(rec[sourceSlug] ?? rec.slug)?.trim() ?? null; },
    // The record as the hub held it when this command read it, every field and the handoff byte for
    // byte, for list --json and show. entries() blanks `file` for the writers and latestHandoff trims
    // for resume, and neither may change what these print. A copy, so a caller cannot edit the read.
    stored(rec) {
      const r = storedBySlug.get(rec[sourceSlug] ?? rec.slug);
      return r ? structuredClone(r) : null;
    },
    async flush(verb) {
      if (failedHandoff) throw new Error('handoff write failed earlier in this command');
      const urls = [];
      const seen = new Set();
      const slugs = new Set();
      // A snapshot, so a re-apply can move an entry to its other shelf at once: a later record that
      // throws must not leave it on the old shelf for the next flush to write back.
      const order = ['active', 'backlog'].flatMap((shelf) => shelves[shelf].map((item) => [shelf, item]));
      for (const [shelf, item] of order) {
        const rec = { ...item, shelf };
        delete rec.file;
        const slug = rec.slug;
        const createOnly = requiredAbsent.has(slug);
        if (createOnly && (item[sourceSlug] || saved.has(slug))) throw new Error('project slug already exists; create-only did not overwrite it');
        let fileSlug = item[sourceSlug] ?? slug;
        if (!item[sourceSlug]) for (let n = 2; saved.has(fileSlug); n++) fileSlug = `${slug}-${n}`;
        const body = pending.get(slug) ?? bodyBySlug.get(fileSlug);
        if (body !== undefined) rec.handoff = body;
        if (slugs.has(slug) || seen.has(fileSlug)) throw new Error(`duplicate gtg project ${slug}`);
        slugs.add(slug);
        seen.add(fileSlug);
        const serialized = JSON.stringify(rec);
        const old = saved.get(fileSlug);
        if (old?.rec === serialized) continue;
        const path = `${records}${encodeURIComponent(fileSlug)}.json`;
        const payload = (r, sha) => ({
          content: Buffer.from(JSON.stringify(r, null, 2) + '\n').toString('base64'),
          message: `gtg ${verb}: ${slug}`,
          ...(sha ? { sha } : {}),
        });
        let out;
        let final = rec;
        try {
          out = await write(old ? 'PUT' : 'POST', path, payload(rec, old?.sha), serialized, old?.sha, 2, createOnly);
          if ('theirs' in out) {
            if (createOnly) throw new Error(`${slug} changed in another session; create-only did not overwrite it`);
            const guard = handoffGuards.get(slug);
            if (guard && (!out.theirs || out.theirs.rec.shelf !== guard.shelf
              || typeof out.theirs.rec.handoff !== 'string'
              || createHash('sha256').update(out.theirs.rec.handoff, 'utf8').digest('hex') !== guard.hash)) {
              throw new Error('guarded handoff changed or was removed while this command ran; nothing was overwritten');
            }
            const { merged, clash = [] } = old && out.theirs ? reapply(JSON.parse(old.rec), rec, out.theirs.rec) : {};
            if (!merged) throw new Error(`${slug} changed in another session while this command ran${clash.length ? ` (both changed ${clash.join(', ')})` : ''}. Re-run it`);
            if (!shelves[merged.shelf]) throw new Error(`invalid gtg record at ${path} after another session's edit`);
            final = merged;
            // Sent once: the issue's "re-apply and PUT once". A lost answer is still read back.
            out = await write('PUT', path, payload(merged, out.theirs.sha), JSON.stringify(merged), out.theirs.sha, 1);
            if ('theirs' in out) throw new Error(`${slug} changed in another session again while this command re-applied its edit. Re-run it`);
          }
        } catch (e) { if (pending.has(slug)) failedHandoff = true; throw e; }
        saved.set(fileSlug, { rec: JSON.stringify(final), sha: out.sha });
        requiredAbsent.delete(slug);
        handoffGuards.delete(slug);
        bodyBySlug.set(fileSlug, final.handoff);
        item[sourceSlug] = fileSlug;
        // Re-applied: the entry takes their fields too, so a second flush finds nothing to write.
        if (final !== rec) {
          for (const k of Object.keys(item)) delete item[k];
          Object.assign(item, entry(final, fileSlug));
          if (final.shelf !== shelf) {
            shelves[shelf] = shelves[shelf].filter((x) => x !== item);
            shelves[final.shelf].push(item);
          }
        }
        if (pending.has(slug)) urls.push(out.url ?? `${cfg.api.replace(/\/api\/v1$/, '')}/${cfg.repo}/src/branch/main/${path}`);
      }
      for (const [fileSlug, old] of saved) {
        if (seen.has(fileSlug)) continue;
        const path = `${records}${encodeURIComponent(fileSlug)}.json`;
        const out = await write('DELETE', path, { sha: old.sha, message: `gtg ${verb}: ${fileSlug}` }, null, old.sha);
        if ('theirs' in out) throw new Error(`${fileSlug} changed in another session since this command read it, so it was not deleted. Re-run it`);
        saved.delete(fileSlug);
      }
      pending.clear();
      return urls;
    },
  };
}
