// What gtg shows: the entry ordering and numbering, the list, and the one review line a command
// ends with. Moved out of gtg.mjs (#30) so it can be tested in-process. The store arrives on a ctx
// rather than through gtg.mjs module state:
//   ctx.entries(which)          the active or backlog records
//   ctx.root                    the hub, for entries whose worktree is the repo root
//   ctx.countHandoffFiles(slug) the session count for a legacy entry with none recorded
//   ctx.skip                    the slug this command is working on, never the one reviewed
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { firstMeaningfulLine } from './git.mjs';
import { parseFlags } from './args.mjs';
// gtg add-ons come in two kinds. An EXTENSION owns entries in the handoff store and renders
// its own separated list, so its entries are excluded from `list` and `backlog`. A MOD owns
// no entries and only adds a view (stats, report), so mods are absent from this map.
//
// Command name -> the `parent` namespace it owns. Filtering is on the existing `parent` field
// and adds no new one on purpose: writeHandoff rebuilds every entry as a fresh literal and
// silently drops fields it does not know, so a marker field would survive exactly until the
// next wrap.
//
// Read outside this repo too. The author's SessionStart banner hook at
// .claude/hooks/gtg-active-summary.mjs imports isExtensionEntry from the plugin cache, so its
// active count hides the same namespaces `gtg list` hides. Renaming or dropping that export
// skips the banner.
export const EXTENSIONS = { learn: 'learning' };
const EXTENSION_PARENTS = new Set(Object.values(EXTENSIONS));
export const isExtensionEntry = (e) => EXTENSION_PARENTS.has(e?.parent);
export const userVisible = (arr) => arr.filter((e) => !isExtensionEntry(e));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-10-14T18:00" -> "14 Oct 18:00", "2026-10-14" -> "14 Oct".
export const dueLabel = (v) => `${Number(v.slice(8, 10))} ${MONTHS[Number(v.slice(5, 7)) - 1]}${v.length > 10 ? ' ' + v.slice(11, 16) : ''}`;

// --- color (TTY-gated, NO_COLOR-aware; raw ANSI, no dependency) ---------------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
export const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));

// Local UTC-offset suffix e.g. "+08:00" for the given Date - shared by nowIso()
// and firstHandoffDate() so both emit the same aware-datetime format (a bare
// vs offset-suffixed stamp otherwise makes Python's fromisoformat raise when
// comparing them).
export function localOffsetSuffix(d) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
export function nowIso() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${localOffsetSuffix(d)}`;
}
export function ago(iso) {
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  if (!Number.isFinite(h)) return '?';
  return h < 48 ? `${Math.floor(h)}h ago` : `${Math.floor(h / 24)}d ago`;
}
// Ordering doubles as numbering: `gtg back <n>` and `gtg active b<n>` resolve a number
// against the same order the rows were rendered in, so the extension exclusion belongs in
// this one shared ordering helper rather than at each console.log. A number on screen then
// cannot address a different entry than the one the user typed back. Slug and name lookups
// are untouched, so an extension entry stays reachable by slug.
//
// ponytail: filtered at render, NOT at read. Extensions still need slug lookup and explicit
// shelving even when their entries stay out of the default project list.
export function sortByProject(arr) {
  return userVisible(arr).sort((a, b) => a.project.localeCompare(b.project));
}
// The exact top-to-bottom order `list` renders active entries in: each family
// (parent) alphabetical, its members alphabetical within, then standalone. ONE
// canonical order so a number on screen, `gtg back <n>`, and the "gtg back <hint>"
// hints all mean the same row. (Backlog has no families - it stays sortByProject.)
export function displayOrder(arr) {
  const sorted = sortByProject(arr);
  const families = [...new Set(sorted.map((e) => e.parent).filter(Boolean))].sort();
  return [...families.flatMap((f) => sorted.filter((e) => e.parent === f)),
          ...sorted.filter((e) => !e.parent)];
}
// "<n>" resolves against the order the list was DISPLAYED in (pass displayOrder for
// the grouped active list, default sortByProject for the flat backlog); else slug
// exact, else fuzzy project.
export function resolveEntry(arr, t, order = sortByProject) {
  if (/^\d+$/.test(t)) return order(arr)[Number(t) - 1] ?? null;
  return arr.find((e) => e.slug === t)
    ?? arr.find((e) => e.project.toLowerCase().includes(t.toLowerCase()))
    ?? null;
}
// Re-exported so gtg.mjs and lib/resume.mjs keep importing it from here.
export { parseFlags };

// Live uncommitted-file count for a worktree. A SessionEnd hook that recorded
// this was retired 2026-07-11 for MISSING dirty worktrees - it only fired on
// exit behind narrow filters. Checking live at list time has neither flaw.
// ponytail: 2s timeout per distinct worktree; a slow or absent one renders '?'
// rather than hanging the list.
function dirtyCount(dir) {
  if (!dir || !existsSync(dir)) return null;
  try {
    const out = execFileSync('git', ['-C', dir, 'status', '--porcelain'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    return out ? out.split('\n').length : 0;
  } catch { return null; }
}
// Where an entry's checkout actually lives - the hub itself for 'repo root'/legacy
// (undefined) entries, else the recorded worktree path. One definition, two call
// sites (dirty-count grouping and per-entry rendering) - they must stay identical.
function resolveDir(e, root) { return (!e.worktree || e.worktree === 'repo root') ? root : e.worktree; }

// Listing is observational. Work remains active until an explicit `back`,
// `complete`/`remove`, or `supersede` command changes its state.
export function renderList(argv, ctx) {
  const filter = argv.find((x) => !x.startsWith('--'));
  // displayOrder, not sortByProject: numbering must run 1..N top-to-bottom in the
  // order rows actually appear (see displayOrder), and `gtg back <n>` resolves
  // against this same order.
  const act = ctx.entries('active');
  const allAct = displayOrder(act);
  // userVisible, so the "+N backlogged" pointer counts the rows `gtg backlog` will show.
  const blCount = userVisible(ctx.entries('backlog')).length;
  // Decluttering is not lookup. The BARE listing hides extension entries, which is the whole
  // point, but an explicit query is the user naming the thing they want, so it searches every
  // entry (`act`, not `allAct`). SKILL.md's exit procedure probes with `list <candidate>` before
  // slugifying and reuses the matched entry's slug, so a blind probe would mint a second entry
  // beside a live issue package instead of updating it.
  const matches = (e) => e.slug === filter || e.project.toLowerCase().includes(filter.toLowerCase());
  const shown = filter
    ? act.filter(matches).sort((a, b) => a.project.localeCompare(b.project))
    : allAct;

  // A targeted query has to reach a SHELVED extension entry too, or the reuse probe above is
  // still blind. Explicit shelving is normal for an issue package between fix sessions, and
  // `backlog` hides extension entries, so from
  // that moment no builtin listing shows it and a departure mints the duplicate anyway.
  // Rendered as its own line rather than as a row, because these are not active and the
  // header counts active work.
  // ponytail: extension entries only. A shelved NORMAL project is invisible to a query too,
  // but that predates the extension model and `list` is documented as never showing backlog
  // items, so widening it is a design call, not a fix. See README "Decluttering is not lookup".
  const shelvedHits = filter
    ? ctx.entries('backlog').filter((e) => isExtensionEntry(e) && matches(e))
    : [];
  const printShelved = () => {
    for (const e of shelvedHits) {
      console.log(`  ${c('33', 'shelved:')} ${c('1;36', e.project)} ${c('2', `(parked ${ago(e.updated)})`)}` +
        ` - gtg active ${e.slug}`);
    }
  };

  if (!shown.length) {
    console.log(`No active gtg projects${filter ? ` matching '${filter}'` : ''}.` +
      (blCount ? ` (+${blCount} backlogged - gtg backlog)` : ''));
    printShelved();
    return;
  }

  const families = [...new Set(shown.map((e) => e.parent).filter(Boolean))].sort();
  console.log(`${shown.length} active gtg project${shown.length === 1 ? '' : 's'}` +
    `${families.length ? ` in ${families.length + (shown.some((e) => !e.parent) ? 1 : 0)} group(s)` : ''}` +
    `${filter ? ` matching '${filter}'` : ''}:`);

  // Only entries with an explicit worktree of their own get a dirty flag - a
  // 'repo root'/legacy-undefined entry resolves to the storage hub itself, which
  // in real use carries 150+ uncommitted files unrelated to any one project;
  // attributing that count to the entry would falsely implicate it.
  const hasOwnWorktree = (e) => !!e.worktree && e.worktree !== 'repo root';

  // One git call per distinct worktree, not per project - several projects
  // commonly share one checkout, which is exactly what the warning below is for.
  // TTY only (#96): piped output goes to a tool, no person reads the flag, and each
  // `git status` costs 195 to 290 ms on the home hub. An unchecked dir renders no tag.
  const dirty = new Map();
  for (const e of shown) {
    if (!process.stdout.isTTY) break;
    if (!hasOwnWorktree(e)) continue;
    const dir = resolveDir(e, ctx.root);
    if (!dirty.has(dir)) dirty.set(dir, dirtyCount(dir));
  }

  const printEntry = (e) => {
    // Position in the FULL display-order list (allAct), so numbers run 1..N down
    // the screen and `gtg back <n>` (resolveEntry over displayOrder) targets this
    // same row even when a filter hides some entries.
    const n = allAct.indexOf(e) + 1;
    // A number is a position in the canonical list, and an extension entry has none: it only
    // ever appears here via an explicit query, and allAct excludes it, so indexOf gives -1 and
    // the `+ 1` above makes that a falsy 0. Label it with the slug that DOES address it rather
    // than a number that would address a different row. This is what keeps a queried listing
    // and `gtg back <n>` from ever disagreeing about what 3 means.
    const label = n ? c('1', n + '.') : c('2', e.slug + ':');
    const d = hasOwnWorktree(e) ? dirty.get(resolveDir(e, ctx.root)) : undefined;
    // null = worktree unreachable / dirtyCount failed - render the '?' the spec
    // promises, distinct from a genuinely clean (0) worktree, which renders nothing.
    const dirtyTag = d === null ? c('33', ' ● ? uncommitted') : d ? c('33', ` ● ${d} uncommitted`) : '';
    const loc = e.branch && e.branch !== '?' ? c('2', ` ${e.branch}`) : '';
    const sessions = e.sessions ?? ctx.countHandoffFiles(e.slug); // legacy entries predate the field
    const by = e.harness ? c('2', ` ·${e.harness}`) : ''; // who wrote the last handoff; absent on pre-1.11 entries
    console.log(`  ${label} ${c('1;36', e.project)} ${c('2', 's' + sessions)} [${c('32', e.eta || '?')}]${e.due ? ' ' + c('35', 'due ' + dueLabel(e.due)) : ''} ${c('2', '(' + ago(e.updated) + ')')}${by}${loc}${dirtyTag}`);
    console.log(`     → ${e.next}`);
  };

  for (const fam of families) {
    const members = shown.filter((e) => e.parent === fam);
    console.log(`\n${c('1;35', '▸ ' + fam)}`);
    members.forEach(printEntry);
  }
  const solo = shown.filter((e) => !e.parent);
  if (solo.length) {
    if (families.length) console.log(`\n${c('1;35', '▸ standalone')}`);
    solo.forEach(printEntry);
  }

  // Several active projects in one checkout on one branch is how work gets
  // tangled. Nothing else in gtg could see this before worktree/branch existed.
  // Tolerant migration: entries with no `worktree` at all (pre-Task-4) would
  // otherwise all collapse onto one '? @ repo root' key and falsely "collide" -
  // skip them, only entries with a real recorded location are compared.
  const byLocation = new Map();
  const BASE_BRANCHES = new Set(['master', 'main']);
  for (const e of shown) {
    if (!e.worktree) continue;
    // master/main @ repo root is the SANCTIONED shared home for docs/meta work
    // (home-repo doctrine - meta paths commit straight to master), not a tangle.
    // Only a real feature-branch collision (or a shared non-root worktree) warns.
    if (e.worktree === 'repo root' && BASE_BRANCHES.has(e.branch)) continue;
    const key = `${e.branch || '?'} @ ${e.worktree}`;
    byLocation.set(key, [...(byLocation.get(key) || []), e.project]);
  }
  for (const [key, names] of byLocation) {
    if (names.length > 1) console.log(`\n${c('33', `⚠ ${names.length} projects share ${key} - ${names.join(', ')}`)}`);
  }

  // BOTH exits, not just the empty one. A query that matches active work AND a shelved extension
  // entry takes this path, and printing only on the empty branch silently dropped the shelved hit
  // exactly when the reuse probe is most likely to go wrong: SKILL.md reuses a slug only when
  // EXACTLY ONE entry matches, so a dropped hit turns two matches into one wrong one.
  if (shelvedHits.length) console.log('');
  printShelved();

  if (blCount) console.log(`\n+ ${blCount} backlogged - gtg backlog`);
}

// --- review: one completion question per command ------------------------------
// Entries persist until an explicit complete, so finished work nobody completed lingers, and
// a parked entry never comes back by itself. Every command that reads or moves entries ends
// with at most ONE question, so the check rides on gtg use in any harness rather than on a
// session-start banner, which T3 Code and IDE threads never reliably see. `keep` answers
// "still live" and restarts that entry's clock without pretending it was worked on. A resume
// counts as touching the entry (`resumedAt`), so a project picked up today is not called stale.
// A question asked is stamped on the record (`nudged`), and every session and device reads that
// stamp, so the same entry is asked about at most once per REVIEW_REPEAT_DAYS (asked for 2026-10-09).
export const REVIEW_ACTIVE_DAYS = 5;
export const REVIEW_BACKLOG_DAYS = 30;
export const REVIEW_REPEAT_DAYS = 30;
export const REVIEW_CMDS = new Set(['handoff', 'list', 'backlog', 'resume', 'back', 'active', 'complete', 'remove', 'rm', 'prune', 'keep', 'supersede']);
const days = (iso, now) => (now - (Date.parse(iso) || 0)) / 864e5;
// Days until `e` can be asked about again because of its last question, 0 when it is free.
export const repeatWait = (e, now = Date.now()) => Math.max(0, Math.ceil(REVIEW_REPEAT_DAYS - days(e.nudged, now)));
// Priority: a backlog entry whose wake date has come, then the stalest active entry, then the
// stalest undated backlog entry. A future wake date keeps an entry out of the review entirely.
// Returns { line, which, slug } or null.
export function reviewPick(ctx, now = Date.now()) {
  const seen = (e) => Math.max(Date.parse(e.updated) || 0, Date.parse(e.reviewed) || 0, Date.parse(e.resumedAt) || 0);
  const age = (e) => Math.floor((now - seen(e)) / 864e5);
  const oldest = (arr) => arr.sort((x, y) => seen(x) - seen(y))[0];
  const today = nowIso().slice(0, 10);
  const open = (e) => e.slug !== ctx.skip && !repeatWait(e, now);
  const bl = userVisible(ctx.entries('backlog')).filter(open);
  const act = userVisible(ctx.entries('active')).filter(open);
  const pick = (e, which, line) => ({ line, which, slug: e.slug });
  const woke = bl.filter((e) => e.wake && e.wake <= today).sort((x, y) => x.wake.localeCompare(y.wake))[0];
  if (woke) return pick(woke, 'backlog', `REVIEW: ${woke.project} [${woke.slug}] was parked until ${woke.wake}. Ask the user: pick it up (gtg active ${woke.slug}), done (gtg complete ${woke.slug}), or park again (gtg keep ${woke.slug} --wake YYYY-MM-DD).`);
  const a = oldest(act.filter((e) => age(e) >= REVIEW_ACTIVE_DAYS));
  if (a) return pick(a, 'active', `REVIEW: ${a.project} [${a.slug}] untouched ${age(a)}d. Ask the user: done (gtg complete ${a.slug}), shelve (gtg back ${a.slug} [--wake YYYY-MM-DD]), or still live (gtg keep ${a.slug}).`);
  const b = oldest(bl.filter((e) => !e.wake && age(e) >= REVIEW_BACKLOG_DAYS));
  if (b) return pick(b, 'backlog', `REVIEW: ${b.project} [${b.slug}] parked ${age(b)}d. Ask the user: done (gtg complete ${b.slug}), or still wanted (gtg keep ${b.slug} [--wake YYYY-MM-DD]).`);
  return null;
}
export const reviewCandidate = (ctx, now = Date.now()) => reviewPick(ctx, now)?.line ?? null;

// Picks the question and has ctx.stampNudged record it, before the store is flushed, so the stamp
// rides in the same write. Returns the line for the caller to print last. Quiet for a filtered list
// (SKILL.md's slug-reuse probe) and for an in-session checkpoint.
export function takeReview(cmd, argv, ctx) {
  const a = parseFlags(argv);
  if (cmd === 'list' && argv.some((x) => !x.startsWith('--'))) return null;
  if (cmd === 'handoff' && a.checkpoint) return null;
  try {
    const p = reviewPick(ctx);
    if (!p) return null;
    try { ctx.stampNudged?.(p.which, p.slug); } catch (e) {
      console.error(`gtg: review not recorded, it may be asked again - ${firstMeaningfulLine(e)}`);
    }
    return p.line;
  } catch (e) {
    console.error(`gtg: review skipped - ${firstMeaningfulLine(e)}`); // never fails the command it rides on
    return null;
  }
}
