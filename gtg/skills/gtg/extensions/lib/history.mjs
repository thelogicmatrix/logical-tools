// gtg history extractor. Reads git + handoff filenames, derives every figure the
// report and stats show. Pure functions take injected data; only readEvents and
// readDurations (later tasks) touch git/disk. No mutation, ever.

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readCollection } from '../../lib/store.mjs';

// Windows-safe path equality: the real path (a junctioned hub resolves to its target, as git
// reports it), else resolve(), compared case-insensitively (Windows filesystems are case-insensitive).
function samePath(a, b) {
  const real = (s) => { try { return realpathSync.native(s); } catch { return resolve(s); } };
  return real(a).toLowerCase() === real(b).toLowerCase();
}

export function slugify(project) {
  return String(project).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// One commit subject -> a typed event, or {type:'noise'}. Never returns null.
// Two handoff formats coexist: legacy "<sep> <phase>" and Plan-A "<sep> session N".
// <sep> is EITHER a plain hyphen (what gtg writes since 2026-08-05) or an em dash
// (what it wrote before, and 263 of the last 400 store commits still carry). Both
// must parse forever, because git history is not rewritable. Every regex below
// spells the em dash as a unicode escape, so this file itself stays pure ASCII.
// The session suffix is matched ONLY by the anchored tail, because a project name
// can itself contain the separator (e.g. "Widget - parts catalog").
export function classify(subject) {
  const s = String(subject);
  let m;
  if ((m = s.match(/^handoff: (.+)$/))) {
    const body = m[1];
    const sess = body.match(/ [-\u2014] session (\d+)$/);
    // Legacy fallback: strip the trailing " <sep> <phase>". A greedy prefix binds
    // the separator to the LAST one in the body, which is what the old
    // negated-class form did. The negated class cannot survive widening: it
    // excluded the dash CHARACTER, but a hyphen is legal inside a project name
    // ("gtg-extensions"), so excluding it would break more than it fixed, and
    // excluding neither would strip from the FIRST separator and truncate
    // "Widget - parts catalog - executing" to "Widget".
    const legacy = body.match(/^(.*) [-\u2014] .*$/);
    const project = sess ? body.slice(0, body.length - sess[0].length) : (legacy ? legacy[1] : body);
    return { type: 'handoff', project, sessions: sess ? Number(sess[1]) : undefined };
  }
  if ((m = s.match(/^gtg backlog: new (.+?) [-\u2014] session \d+$/))) return { type: 'park', project: m[1] };
  if ((m = s.match(/^gtg backlog: park (.+)$/))) return { type: 'shelve', project: m[1] };
  if (/^gtg backlog: auto-park /.test(s)) return { type: 'autoshelf', project: undefined };
  if ((m = s.match(/^gtg activate: (.+)$/))) return { type: 'activate', project: m[1] };
  if ((m = s.match(/^gtg prune: remove (.+?)(?: from backlog)? - confirmed done$/))) return { type: 'prune', project: m[1] };
  if ((m = s.match(/^gtg resume: (.+?) [-\u2014] (?:backlog )?handoff consumed$/))) return { type: 'resume', project: m[1] };
  // Neither a ship nor an abandonment: the entry was rolled up, or filed in error.
  // Lazy first group so the optional " into <target>" tail wins when present.
  if ((m = s.match(/^gtg supersede: (.+?)(?: into (.+))?$/))) return { type: 'supersede', project: m[1], into: m[2] };
  if (/^gtg undo: /.test(s)) return { type: 'undo', project: undefined };
  return { type: 'noise', project: undefined };
}

// rawLog: [{date, subject}] newest-first (git default). Returns Event[] with the
// prune backfill resolved and a slug attached for joining to store entries.
export function classifyEvents(rawLog) {
  const events = rawLog.map((r) => {
    const c = classify(r.subject);
    return { date: r.date, ...c, slug: c.project ? slugify(c.project) : undefined };
  });
  // Backfill: a prune is a RESUME if a handoff for the same slug appears later
  // in time (earlier index, since newest-first); otherwise it SHIPPED.
  // ponytail: a project genuinely shipped then restarted under one slug backfills
  // as resumed and is undercounted. Pre-Plan-A only; acceptable for a fun stat.
  events.forEach((e, i) => {
    if (e.type !== 'prune') return;
    const laterHandoff = events.slice(0, i).some((x) => x.type === 'handoff' && x.slug === e.slug);
    if (laterHandoff) e.resumed = true; else e.shipped = true;
  });
  return events;
}

// The one git call. %x1f (unit separator) delimits date from subject so the
// subject's own em-dashes/colons don't confuse the split. Newest-first (git default).
export function readEvents(root) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'log', '--format=%aI%x1f%s', '--', 'docs/handoffs/'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 10000 });
  } catch { return { events: [], available: false }; }
  // Guard against git walking up to an enclosing repo when root isn't itself
  // a repo (e.g. an unvalidated GTG_HUB pointed at a plain scratch dir) -
  // that would silently report an ancestor repo's history as root's own.
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 10000 }).trim();
    if (!samePath(top, root)) return { events: [], available: false };
  } catch { return { events: [], available: false }; }
  const rawLog = out.split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf('\x1f');
    return { date: line.slice(0, i), subject: line.slice(i + 1) };
  });
  return { events: classifyEvents(rawLog), available: true };
}

// One Session per handoff .md file. The filename carries the clock - hour-of-day
// comes free, no schema change.
export function readSessions(root) {
  const dir = join(root, 'docs/handoffs');
  if (!existsSync(dir)) return [];
  let files;
  try { files = readdirSync(dir); } catch { return []; }
  const sessions = [];
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})-(.+)\.md$/);
    if (m) sessions.push({ date: m[1], hour: Number(m[2]), slug: m[4] });
  }
  return sessions;
}

export function nowMs() { return Date.now(); }

// supersede counts as an active day for the same reason prune does: consolidating
// entries is deliberate bookkeeping. `undo` and `noise` stay out.
const ACTIVE_TYPES = new Set(['handoff', 'park', 'shelve', 'autoshelf', 'activate', 'prune', 'resume', 'supersede']);
const dayNum = (d) => Math.floor(Date.parse(d) / 86400000);
const round1 = (n) => Math.round(n * 10) / 10;

// Pure: streaks, weekday/hour distribution, and a day-by-day grid over the
// span of active days. "Active" = any handoff/park/resume/prune/shelve/activate.
export function habit(events, sessions) {
  const days = [...new Set(events.filter((e) => ACTIVE_TYPES.has(e.type)).map((e) => e.date.slice(0, 10)))].sort();
  const byWeekday = Array(7).fill(0);
  const byHour = Array(24).fill(0);
  for (const s of sessions) byHour[s.hour] = (byHour[s.hour] || 0) + 1;
  for (const d of days) byWeekday[new Date(d + 'T00:00:00').getDay()]++;

  let longest = days.length ? 1 : 0, run = days.length ? 1 : 0;
  for (let i = 1; i < days.length; i++) {
    run = dayNum(days[i]) - dayNum(days[i - 1]) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  // current streak: count back from the most recent active day (not necessarily today)
  let current = days.length ? 1 : 0;
  for (let i = days.length - 1; i > 0; i--) {
    if (dayNum(days[i]) - dayNum(days[i - 1]) === 1) current++; else break;
  }

  const counts = {};
  for (const e of events) if (ACTIVE_TYPES.has(e.type)) { const d = e.date.slice(0, 10); counts[d] = (counts[d] || 0) + 1; }
  const grid = [];
  if (days.length) {
    for (let n = dayNum(days[0]); n <= dayNum(days[days.length - 1]); n++) {
      const d = new Date(n * 86400000).toISOString().slice(0, 10);
      grid.push({ date: d, count: counts[d] || 0 });
    }
  }
  return { activeDays: days.length, currentStreak: current, longestStreak: longest, byWeekday, byHour, grid };
}

// Pure: shipped/parked/activated counts and days-to-ship. shipRate is left
// null - the assembler (Task 6) fills it in once it knows the still-active count.
export function throughput(events) {
  const ships = events.filter((e) => e.type === 'prune' && e.shipped);
  const resumed = events.filter((e) => (e.type === 'resume') || (e.type === 'prune' && e.resumed)).length;
  const parked = events.filter((e) => e.type === 'park' || e.type === 'shelve' || e.type === 'autoshelf').length;
  const activated = events.filter((e) => e.type === 'activate').length;

  // days-to-ship: pair each ship with the earliest handoff for its slug.
  // events is newest-first, so the LAST write to firstHandoff[slug] as we
  // iterate forward is the oldest (earliest) handoff.
  const firstHandoff = {};
  for (const e of events) if (e.type === 'handoff') firstHandoff[e.slug] = e.date;
  const spans = ships.map((s) => firstHandoff[s.slug] ? dayNum(s.date) - dayNum(firstHandoff[s.slug]) : null)
    .filter((n) => n !== null);
  const sorted = spans.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;

  const now = nowMs();
  const within = (e, d) => (now - Date.parse(e.date)) / 86400000 <= d;
  const last = ships[0] || null; // newest-first
  return {
    shipped: ships.length,
    shipped7d: ships.filter((e) => within(e, 7)).length,
    shipped30d: ships.filter((e) => within(e, 30)).length,
    parked, activated, resumed,
    shipRate: null, // assembler fills this once stillActive is known
    medianDaysToShip: median,
    maxDaysToShip: spans.length ? Math.max(...spans) : null,
    lastShip: last ? {
      project: last.project, date: last.date.slice(0, 10),
      daysAgo: Math.round((now - Date.parse(last.date)) / 86400000),
    } : null,
  };
}

// Pure: one row per slug seen anywhere (events or either store), joining
// current status/parent/updated from the active/backlog stores.
//
// Join key is slugify(project) throughout, NOT the store's hand-chosen slug:
// events only ever carry slugify(project) (a commit subject has no --slug),
// so keying the store maps by entry.slug would split one project into a
// phantom event-row plus a separate store-row whenever the two slugs differ
// (e.g. "GTG Stats History Upgrade" -> stored slug "gtg-stats-history" but
// slugify(project) = "gtg-stats-history-upgrade"). The real slug is kept as
// `slug` on the output row (for display / joining to effort) once a store
// entry resolves it; canonical key stays internal.
// ponytail: two distinct projects that happen to slugify to the same key
// would merge into one row; rare, acceptable.
// `effort` is readDurations' output, optional: rows carry `minutes` only where a
// project has timed sessions. Untimed projects get null, NOT 0 - pre-1.4.0 work
// took real time nobody recorded, and a 0 would read as "this was free".
export function perProject(events, sessions, activeEntries, backlogEntries, effort) {
  const active = new Map((activeEntries || []).map((e) => [slugify(e.project), e]));
  const backlog = new Map((backlogEntries || []).map((e) => [slugify(e.project), e]));
  const slugs = new Set([
    ...events.filter((e) => e.slug).map((e) => e.slug),
    ...active.keys(), ...backlog.keys(),
  ]);
  const rows = [];
  for (const slug of slugs) {
    const evs = events.filter((e) => e.slug === slug); // newest-first
    const storeEntry = active.get(slug) || backlog.get(slug);
    const name = storeEntry?.project || evs.find((e) => e.project)?.project || slug;
    const realSlug = storeEntry?.slug || slug;
    const dates = evs.map((e) => e.date).sort(); // oldest-first
    const born = dates[0] ? dates[0].slice(0, 10) : null;
    // Current GTG entries carry the authoritative checkpoint-event count. Filename
    // counts are a legacy fallback only: one persistent current file cannot represent
    // its revision count, and preferring a surviving dated file would freeze a line at 1.
    const storedSessions = Number.isInteger(storeEntry?.sessions) && storeEntry.sessions >= 0
      ? storeEntry.sessions
      : null;
    const eventSessions = evs.filter((e) => e.type === 'handoff').length;
    const sessCount = storedSessions
      ?? (eventSessions || sessions.filter((s) => s.slug === realSlug).length);
    const ship = evs.find((e) => e.type === 'prune' && e.shipped);
    let status = 'dormant';
    if (active.has(slug)) status = 'active';
    else if (backlog.has(slug)) status = 'backlog';
    else if (ship) status = 'shipped';
    // longest gap between consecutive events for this slug
    const dnums = dates.map(dayNum);
    let gap = 0;
    for (let i = 1; i < dnums.length; i++) gap = Math.max(gap, dnums[i] - dnums[i - 1]);
    const firstHandoff = evs.filter((e) => e.type === 'handoff').map((e) => e.date).sort()[0];
    const daysToShip = ship && firstHandoff ? dayNum(ship.date) - dayNum(firstHandoff) : null;
    // effort keys on the store's real slug (that's what a handoff commits), so
    // join on realSlug - never the canonical slugify(project) key used above.
    const minutes = (effort?.bySlug?.[realSlug] || []).reduce((a, b) => a + b, 0);
    rows.push({
      slug: realSlug, project: name, parent: active.get(slug)?.parent ?? backlog.get(slug)?.parent,
      born, lastSeen: dates.length ? dates[dates.length - 1].slice(0, 10) : null,
      sessions: sessCount, longestGapDays: gap,
      minutes: minutes || null, worktree: storeEntry?.worktree,
      daysAlive: dates.length ? dayNum(dates[dates.length - 1]) - dayNum(dates[0]) : 0,
      daysToShip, status,
      updated: active.get(slug)?.updated ?? backlog.get(slug)?.updated,
    });
  }
  return rows.sort((a, b) => (b.sessions - a.sessions));
}

// Pure: group perProject rows by parent (rows without a parent are excluded -
// families only exist where an INDEX join has assigned one).
export function families(rows) {
  const byParent = new Map();
  for (const r of rows) {
    if (!r.parent) continue;
    const f = byParent.get(r.parent)
      || { parent: r.parent, subProjects: 0, shipped: 0, active: 0, totalSessions: 0, totalMinutes: 0, first: null, latest: null };
    f.subProjects++; f.totalSessions += r.sessions;
    if (r.minutes) f.totalMinutes += r.minutes;
    if (r.born && (!f.first || r.born < f.first)) f.first = r.born;
    const last = r.lastSeen || r.born;
    if (last && (!f.latest || last > f.latest)) f.latest = last;
    if (r.status === 'shipped') f.shipped++;
    if (r.status === 'active') f.active++;
    byParent.set(r.parent, f);
  }
  // totalMinutes is summed exactly then converted once - rounding per row first
  // would drift a family's hours by up to 0.05h per sub-project.
  return [...byParent.values()]
    .map(({ totalMinutes, ...f }) => ({ ...f, totalHours: round1(totalMinutes / 60) }))
    .sort((a, b) => b.subProjects - a.subProjects);
}

// Pure: resurrection/abandonment rates, day-by-day WIP count, and aging of
// currently-active rows (staleness reads the row's `updated`, carried from
// the store by perProject).
export function health(events, rows) {
  // Distinct-slug base so both rates share one denominator (Finding 2): a slug
  // parked twice must not inflate it, and abandoned must count slugs, not rows.
  const parkedSlugs = new Set(
    events.filter((e) => e.type === 'park' || e.type === 'shelve' || e.type === 'autoshelf').map((e) => e.slug));
  const activatedSlugs = new Set(events.filter((e) => e.type === 'activate').map((e) => e.slug));
  // parkedSlugs/activatedSlugs come from events, which only ever carry the
  // canonical slugify(project) slug (see perProject) - never a row's real
  // store slug. Index status under BOTH so the lookup hits regardless of
  // which one a caller's row happens to carry.
  const statusBySlug = new Map();
  for (const r of rows) {
    statusBySlug.set(r.slug, r.status);
    if (r.project) statusBySlug.set(slugify(r.project), r.status);
  }
  // A superseded slug has no row on either shelf, so it used to fall through to
  // abandoned and stay there forever, which is the one thing it definitely is not:
  // it was rolled up into another entry, or filed in error. Excluded by event, not
  // by status, precisely because the row is gone.
  const supersededSlugs = new Set(events.filter((e) => e.type === 'supersede').map((e) => e.slug));
  const abandoned = [...parkedSlugs].filter((slug) => {
    if (supersededSlugs.has(slug)) return false;
    const st = statusBySlug.get(slug);
    return st !== 'active' && st !== 'shipped';
  }).length;

  // WIP per day (Finding 1): a slug is "in progress" from its first handoff
  // until the first shipped-prune on/after that handoff. `resume` is NOT
  // terminal (it means work is ongoing again). No later ship → span runs to
  // the slug's last event date (still open). Clamp defensively so a span can
  // never invert regardless of data quirks.
  const spans = [];
  const bySlug = {};
  for (const e of events) (bySlug[e.slug] ||= []).push(e);
  for (const [, evs] of Object.entries(bySlug)) {
    const asc = evs.slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const firstHandoff = asc.find((e) => e.type === 'handoff');
    if (!firstHandoff) continue;
    const start = dayNum(firstHandoff.date);
    const ship = asc.find((e) => e.type === 'prune' && e.shipped && dayNum(e.date) >= start);
    const end = ship ? dayNum(ship.date) : dayNum(asc[asc.length - 1].date);
    spans.push([start, Math.max(start, end)]);
  }
  const wipByDay = [];
  if (spans.length) {
    const lo = Math.min(...spans.map((s) => s[0])), hi = Math.max(...spans.map((s) => s[1]));
    for (let n = lo; n <= hi; n++) {
      wipByDay.push({ date: new Date(n * 86400000).toISOString().slice(0, 10),
        count: spans.filter(([a, b]) => a <= n && n <= b).length });
    }
  }
  const now = nowMs();
  const aging = rows.filter((r) => r.status === 'active' && r.updated).map((r) => ({
    slug: r.slug, daysIdle: Math.round((now - Date.parse(r.updated)) / 86400000),
  }));
  return {
    resurrectionRate: parkedSlugs.size ? activatedSlugs.size / parkedSlugs.size : 0,
    abandonmentRate: parkedSlugs.size ? abandoned / parkedSlugs.size : 0,
    wipByDay, aging,
  };
}

// ISO 8601 week (Mon-based, week 1 contains the year's first Thursday).
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00'); const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3); const firstThu = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Effort. duration_min is THIS session's length (not a running total), rewritten
// onto the active entry at each handoff; one `git log -p` pass recovers
// every duration ever committed. Within a diff, a duration is attributed to the
// nearest preceding slug among ADDED lines, and to the commit's author date.
//
// ponytail: the slug scan is NOT reset per file, even though a sharded commit's diff can now
// span several record files where the packed file was one. It does not need to be: a handoff
// commits exactly ONE active record (writeCollection skips records whose bytes did not change,
// which case 69 in the suite pins), and that record's own "slug" line always lands in the same
// hunk as its duration_min - `sessions` sits two lines below `slug` and every handoff bumps it,
// so the hunks merge. Reading the slug off the record's PATH instead would remove the
// assumption; it earned no test that fails without it, so it is not here.
//
// The pathspec spans BOTH the packed file and the sharded directory, because this reads
// HISTORY and history crosses the migration: dropping the packed path would silently zero
// every duration recorded before the shard, and dropping the directory would silently zero
// every one recorded after it. The packed file is DELETED from the worktree, which changes
// nothing here - a pathspec matches the commits that touched it. Backlog records stay absent,
// matching the pre-shard pathspec - parking an idea is not a timed session.
//
// Only HANDOFF commits count. `gtg activate` moves a backlog entry back into
// the active store and `gtg undo` restores a removed one - both re-add the entry
// with its duration_min unchanged, which billed the same session a second time
// (~6% of the total on the live store before this guard). A handoff is the only
// commit that actually re-times anything, so the subject is the exact filter.
// Fresh object per return path: callers may mutate the result.
// Keep the existing empty counters for API consumers; available distinguishes
// an unreadable history from a successful read with no timed sessions.
const noDurations = () => ({
  available: false,
  bySlug: {}, hoursBySlug: {}, hoursByWeek: {},
  total: 0, sessionsTimed: 0, avgSessionMin: null, longestSessionMin: null,
});
export function readDurations(root) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'log', '-p', '--format=%aI%x1f%s', '--',
      'docs/handoffs/_active.json', 'docs/handoffs/active'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
  } catch { return noDurations(); }
  // Same walk-up guard as readEvents: if root isn't itself a repo but is nested
  // inside one, git resolves to the enclosing repo and would report ITS durations.
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 10000 }).trim();
    if (!samePath(top, root)) return noDurations();
  } catch { return noDurations(); }
  const bySlug = {}; const minutesByWeek = {}; let total = 0, sessionsTimed = 0;
  let curSlug = null, curDate = null, counting = false;
  for (const line of out.split('\n')) {
    // Commit header. Only a --format line can carry the unit separator after an
    // ISO date at column 0; every diff line starts with +, -, space, or a header
    // keyword, so this can't collide with file content.
    const hm = line.match(/^(\d{4}-\d{2}-\d{2}T[^\x1f]*)\x1f(.*)$/);
    if (hm) {
      curDate = hm[1];
      counting = classify(hm[2]).type === 'handoff';
      curSlug = null;                                  // slug context never crosses commits
      continue;
    }
    if (!counting) continue;
    if (line.startsWith('-')) continue;                // removed lines never inform current state
    // slug tracking reads context (' ') AND added ('+') lines: a commit that only
    // re-times a session (duration_min changes, slug doesn't) leaves "slug" as an
    // unchanged context line, not a "+" line - added-only tracking would silently
    // lose the pairing for that commit.
    const sm = line.match(/"slug":\s*"([^"]+)"/);
    if (sm) { curSlug = sm[1]; continue; }
    if (!line.startsWith('+')) continue;               // duration itself must be newly added
    const dm = line.match(/"duration_min":\s*(\d+)/);
    if (dm && curSlug) {
      const n = Number(dm[1]);
      (bySlug[curSlug] ||= []).push(n); total += n; sessionsTimed++;
      const w = isoWeek(curDate.slice(0, 10));
      minutesByWeek[w] = (minutesByWeek[w] || 0) + n;
    }
  }
  const all = Object.values(bySlug).flat();
  const hoursBySlug = {};
  for (const [s, arr] of Object.entries(bySlug)) hoursBySlug[s] = round1(arr.reduce((a, b) => a + b, 0) / 60);
  const hoursByWeek = {};
  for (const [w, m] of Object.entries(minutesByWeek)) hoursByWeek[w] = round1(m / 60);
  return {
    available: true, bySlug, hoursBySlug, hoursByWeek, total, sessionsTimed,
    avgSessionMin: all.length ? Math.round(total / all.length) : null,
    longestSessionMin: all.length ? Math.max(...all) : null,
  };
}

// Pure: the scoreboard stats. Takes events + perProject rows only (no habit).
export function fun(events, rows) {
  const ships = events.filter((e) => e.type === 'prune' && e.shipped);
  const weekCounts = {};
  for (const s of ships) { const w = isoWeek(s.date.slice(0, 10)); weekCounts[w] = (weekCounts[w] || 0) + 1; }
  const bestWeek = Object.entries(weekCounts).sort((a, b) => b[1] - a[1])[0] || null;
  const shippedRows = rows.filter((r) => r.status === 'shipped' && r.daysAlive != null);
  const longestLived = shippedRows.sort((a, b) => b.daysAlive - a.daysAlive)[0] || null;
  const resumeCounts = {};
  for (const e of events) if (e.type === 'resume' || (e.type === 'prune' && e.resumed))
    resumeCounts[e.slug] = (resumeCounts[e.slug] || 0) + 1;
  const topResume = Object.entries(resumeCounts).sort((a, b) => b[1] - a[1])[0];
  const mostResumed = topResume ? { slug: topResume[0], count: topResume[1] } : null;
  const now = nowMs();
  const recent = ships.filter((e) => (now - Date.parse(e.date)) / 86400000 <= 2).length;
  const velocity = recent >= 4 ? 'on a tear' : recent >= 1 ? 'steady' : 'quiet';
  return {
    bestWeek: bestWeek ? { week: bestWeek[0], ships: bestWeek[1] } : null,
    longestLivedShip: longestLived ? { project: longestLived.project, daysAlive: longestLived.daysAlive } : null,
    mostResumed, velocity,
  };
}

// Ties readers + derivations into one object.
//
// Reads the record stores through readCollection, NOT the injected ctx.readStore this used
// to take. readStore is a whole-file JSON reader, so once the stores became one file per
// record it could only ever see the frozen packed file - and `?.handoffs ?? []` turns that
// into a silent [], which reported an empty report instead of failing. The packed files are
// deleted now, so the same mistake reads a missing file and produces the same silent [].
// There is no store-path logic left to inject: readCollection names the directory, and that
// directory is the whole store.
export function buildReport(root) {
  const { events, available } = readEvents(root);
  const sessions = readSessions(root);
  const active = readCollection(root, 'docs/handoffs/active', { name: 'gtg' });
  const backlog = readCollection(root, 'docs/handoffs/backlog', { name: 'gtg' });
  const effort = readDurations(root);
  const rows = perProject(events, sessions, active, backlog, effort);
  const tp = throughput(events);
  const denom = tp.shipped + tp.resumed + active.length;
  tp.shipRate = denom ? Number((tp.shipped / denom).toFixed(3)) : null;
  return {
    historyAvailable: available,
    // Canonical current files intentionally have no timestamp in their names.
    // The hour histogram can therefore describe only retained legacy dated files;
    // make that limitation machine-visible to report consumers.
    coverage: { sessionHoursByClock: 'legacy-dated-handoff-files-only' },
    counts: { active: active.length, backlog: backlog.length },
    habit: habit(events, sessions),
    throughput: tp,
    effort,
    families: families(rows),
    perProject: rows,
    health: health(events, rows),
    fun: fun(events, rows),
  };
}
