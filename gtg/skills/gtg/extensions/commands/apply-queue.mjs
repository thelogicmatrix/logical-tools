// Single runner only. A one-shot run takes the canonical scheduler's flock. Watch mode relies on
// the fixed container name `logic-applier` to keep a second copy from starting. Watch mode and
// the cron must never run together. Interrupted-action recovery assumes that single-runner
// ownership; atomic API claims do not make recovery multi-runner safe.
// GTG remains the only writer of project records, history, mirrors and undo.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'gtg.mjs');
const day = (v) => v ? String(v).slice(0, 10) : '';
export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || `idea-${Date.now()}`;

export function commandFor(a) {
  const wake = day(a.wake) ? ['--wake', day(a.wake)] : [];
  const exact = ['--exact', '--expected-shelf', a.expected_shelf];
  switch (a.verb) {
    case 'complete': return { args: ['complete', a.slug, ...exact] };
    case 'back': return { args: ['back', a.slug, ...exact, ...wake] };
    case 'active': return { args: ['active', a.slug, ...exact] };
    case 'keep': return { args: ['keep', a.slug, ...exact, ...wake] };
    case 'upnext': return { args: ['upnext', a.slug, ...exact, `--text=${a.text}`] };
    case 'backlog': {
      const project = String(a.text).replace(/\s+/g, ' ').trim();
      return { args: ['backlog', `--project=${project}`, '--slug', slugify(project), `--next=TBD: ${project}`, '--exact', '--create-only'], input: `## The Idea\n${project}\n\nAdded from Logic.\n` };
    }
    case 'edit': {
      const f = a.args ?? {};
      return { args: ['edit', a.slug, ...exact, ...['next', 'eta', 'due', 'parent'].filter((k) => typeof f[k] === 'string').map((k) => `--${k}=${f[k]}`)] };
    }
    case 'upnext_edit': return { args: ['upnext', a.slug, ...exact, `--edit=${a.args.n}`, `--text=${a.text}`] };
    case 'upnext_remove': return { args: ['upnext', a.slug, ...exact, `--remove=${a.args.n}`] };
    case 'upnext_move': return { args: ['upnext', a.slug, ...exact, `--move=${a.args.n}`, `--to=${a.args.to}`] };
    case 'promote': return { args: ['upnext', a.slug, ...exact, '--promote'] };
    case 'rename': return { args: ['rename', a.slug, a.slug, ...exact, `--name=${a.args.name}`] };
    case 'supersede': return { args: ['supersede', a.slug, ...exact, '--into', a.args.into] };
    // Logic's Remove means filed in error. In gtg that is supersede with no --into, while remove records a ship.
    case 'remove': return { args: ['supersede', a.slug, ...exact] };
    case 'new': {
      const project = String(a.text).replace(/\s+/g, ' ').trim();
      const next = String(a.args.next).trim();
      const parent = a.args.parent ? [`--parent=${a.args.parent}`] : [];
      return {
        args: ['handoff', `--project=${project}`, '--slug', slugify(project), `--next=${next.split('\n')[0].trim()}`, ...parent, '--exact', '--create-only'],
        input: `## Where We Stopped\nStarted from Logic.\n\n## Next Action\n${next}\n`,
      };
    }
    default: throw new Error('unknown verb');
  }
}

async function logicApi(base, email, password) {
  const json = { 'Content-Type': 'application/json' };
  const auth = await fetch(`${base}/api/collections/users/auth-with-password`, { method: 'POST', headers: json, body: JSON.stringify({ identity: email, password }), signal: AbortSignal.timeout(30000) });
  if (!auth.ok) throw new Error(`Logic sign-in failed: ${auth.status}`);
  const { token } = await auth.json();
  if (!token) throw new Error('Logic sign-in returned no token');
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { ...json, Authorization: token }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    // Error responses can contain user input. Keep only HTTP status in diagnostics.
    if (!res.ok) throw new Error(`Logic ${method} failed: ${res.status}`);
    return res.json();
  };
  return {
    list: async (status) => {
      const actions = [];
      for (let page = 1, totalPages = 1; page <= totalPages; page++) {
        const data = await call('GET', `/api/collections/gtg_actions/records?${new URLSearchParams({ filter: `status = "${status}"`, sort: 'created,id', perPage: '200', page: String(page) })}`);
        if (!Array.isArray(data.items)) throw new Error('Logic returned an invalid action list');
        actions.push(...data.items);
        totalPages = data.totalPages || 1;
      }
      return actions;
    },
    get: (id) => call('GET', `/api/collections/gtg_actions/records/${encodeURIComponent(id)}`),
    mark: (id, patch) => call('PATCH', `/api/collections/gtg_actions/records/${encodeURIComponent(id)}`, patch),
    sync: () => call('POST', '/api/logic/sync'),
  };
}

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function recover(api) {
  let failed = 0;
  for (const a of await api.list('applying')) {
    console.log(`apply-queue: action ${failed + 1} recovering interrupted action`);
    await api.mark(a.id, { status: 'failed', result: 'Interrupted while applying. Check gtg before retrying.', applied_at: now() });
    failed++;
  }
  return failed;
}

// Final marks that failed after their command ran. Retried at the top of each pass so a Logic
// blip cannot leave a row in applying (and its project locked on the site) until restart.
// Returns the API to use for the rest of the pass, which is a fresh sign-in if one was needed.
async function flushMarks(api, retry, signIn) {
  for (const r of retry.splice(0)) {
    try {
      await api.mark(r.id, r.patch);
    } catch (e) {
      if (!/failed: 40[04]/.test(e.message)) { retry.push(r); continue; }
      // 400/404 can mean the row moved on (an earlier attempt landed) or is gone. It can also mean an
      // expired token that PocketBase treats as a guest. Sign in again and look before dropping.
      try {
        api = await signIn();
        if ((await api.get(r.id)).status === 'applying') retry.push(r);
        else console.error('apply-queue: dropped a result Logic no longer accepts');
      } catch (e2) {
        if (/failed: 404/.test(e2.message)) console.error('apply-queue: dropped a result for a row Logic no longer has');
        else retry.push(r);
      }
    }
  }
  return api;
}

async function applyPending(api, root, projectEntries, { retry = [], shouldStop = () => false, signIn = async () => api } = {}) {
  let applied = 0, failed = 0, ordinal = 0;
  api = await flushMarks(api, retry, signIn);
  // Fetch every page before mutations; otherwise completed rows shift pending page offsets.
  for (const a of await api.list('pending')) {
    // On SIGTERM or SIGINT, finish the current action but claim no more.
    if (shouldStop()) break;
    console.log(`apply-queue: action ${++ordinal} claiming queued action`);
    try {
      await api.mark(a.id, { status: 'applying' });
    } catch {
      // An unsuccessful/ambiguous claim belongs to nobody here. Never execute or fail it.
      console.error(`apply-queue: action ${ordinal} claim failed; left for its owner`);
      continue;
    }
    let ok = false, result;
    try {
      const { args, input = '' } = commandFor(a);
      if (!['backlog', 'new'].includes(a.verb)) {
        if (!['active', 'backlog'].includes(a.expected_shelf)) throw new Error('Missing or invalid expected_shelf. Queue this action again.');
        if (typeof projectEntries !== 'function') throw new Error('GTG cannot provide authoritative project state.');
        const matches = (await projectEntries()).filter((e) => e.slug === a.slug);
        if (!matches.length) throw new Error('Project no longer exists with this exact slug.');
        if (matches.length !== 1) throw new Error('Project slug is ambiguous across shelves.');
        if (matches[0].shelf !== a.expected_shelf) throw new Error('Project changed shelf since this action was queued.');
      }
      const env = { ...process.env, GTG_HUB: root };
      delete env.LOGIC_AGENT_EMAIL;
      delete env.LOGIC_AGENT_PASSWORD;
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, input, encoding: 'utf8', timeout: 120000 });
      ok = r.status === 0 && !r.error;
      result = `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-1500) || (ok ? 'done' : `GTG command failed (${r.error?.code || r.status})`);
    } catch (e) { result = String(e.message).slice(-1500); }
    // Sync before marking applied: Logic shows the queued edit until the action leaves
    // pending/applying, so marking first would flash the old value back.
    if (ok) await api.sync().catch(() => console.error('apply-queue: sync request failed'));
    const patch = { status: ok ? 'applied' : 'failed', result, applied_at: now() };
    try {
      await api.mark(a.id, patch);
    } catch {
      console.error(`apply-queue: action ${ordinal} result not recorded; retrying next pass`);
      retry.push({ id: a.id, patch });
    }
    if (ok) applied++; else failed++;
  }
  return { applied, failed };
}

export default async function applyQueue({ root, args = [], projectEntries }) {
  const { LOGIC_URL, LOGIC_AGENT_EMAIL, LOGIC_AGENT_PASSWORD, APPLY_POLL_MS, APPLY_REAUTH_MS, KUMA_PUSH_URL } = process.env;
  if (!LOGIC_URL || !LOGIC_AGENT_EMAIL || !LOGIC_AGENT_PASSWORD) throw new Error('apply-queue needs LOGIC_URL, LOGIC_AGENT_EMAIL and LOGIC_AGENT_PASSWORD');
  const connect = () => logicApi(LOGIC_URL.replace(/\/+$/, ''), LOGIC_AGENT_EMAIL, LOGIC_AGENT_PASSWORD);
  let api, signedInAt = 0;
  const signIn = async () => { api = await connect(); signedInAt = Date.now(); return api; };
  await signIn();
  const recovered = await recover(api);
  if (!args.includes('--watch')) {
    const { applied, failed } = await applyPending(api, root, projectEntries, { signIn });
    console.log(`apply-queue: ${applied} applied, ${failed + recovered} failed`);
    return;
  }
  // One process, one queue: the fixed container name `logic-applier` keeps a second copy from starting.
  const every = Number(APPLY_POLL_MS) || 3000;
  // PocketBase treats an expired token as a guest (empty lists, 404s, never a 401), so the watcher
  // signs in again on a timer rather than waiting for a 401 that never comes.
  const reauthEvery = Number(APPLY_REAUTH_MS) || 6 * 60 * 60 * 1000;
  const retry = [];
  let stop = false, lastPush = 0;
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => { stop = true; });
  console.log(`apply-queue: watching every ${every} ms`);
  while (!stop) {
    try {
      if (Date.now() - signedInAt > reauthEvery) await signIn();
      const { applied, failed } = await applyPending(api, root, projectEntries, { retry, shouldStop: () => stop, signIn });
      if (applied || failed) console.log(`apply-queue: ${applied} applied, ${failed} failed`);
      // The push means "applying works", so only a pass that did not throw sends it.
      if (KUMA_PUSH_URL && Date.now() - lastPush > 60000) {
        lastPush = Date.now();
        fetch(`${KUMA_PUSH_URL}${KUMA_PUSH_URL.includes('?') ? '&' : '?'}status=up&msg=OK`, { signal: AbortSignal.timeout(10000) }).catch(() => {});
      }
    } catch (e) {
      console.error(`apply-queue: pass failed: ${String(e.message).slice(0, 200)}`);
      if (/failed: 40[13]/.test(e.message)) await signIn().catch(() => {});
    }
    for (let waited = 0; waited < every && !stop; waited += 100) await sleep(100);
  }
  console.log('apply-queue: stopped');
}
