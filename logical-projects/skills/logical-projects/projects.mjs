#!/usr/bin/env node
// projects: zero-model bookkeeping CLI for the projects portfolio skill.
// Storage root: PROJECTS_ROOT if set, else the current git repo's root.
// docs/projects/entries/<slug>.json is truth for mechanical fields, one file per project.
// INDEX.md is RENDERED from it and committed, because it is what makes the list readable on
// Forgejo and what gtg's inferParent reads to resolve project families.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { readCollection } from './lib/store.mjs';
import { isMain } from './lib/exit.mjs';
import { CS_END, CS_START, NARRATIVE_UNWRITTEN, pagePath, renderList, setCurrentState } from './lib/page.mjs';
import { commit, readStore, resolveRoot, today, writeStore } from './lib/portfolio.mjs';
import { PROJECTS_DIR, REL_ENTRIES, REL_INDEX, REL_STORE, THEMES, THEME_ORDER, assertRenderable, renderIndex, validateSlug, validateStatus, validateTheme } from './lib/render.mjs';
import { cmdSync, lastCommitDates } from './lib/sync.mjs';
import { syncStore, installStoreHook } from './store-sync.mjs';
export { PROJECTS_DIR, REL_ENTRIES, REL_INDEX, REL_STORE, STATUSES, STATUS_ORDER, THEMES, THEME_ORDER, UNTHEMED, assertRenderable, groupByTheme, parseIndex, renderIndex, sortProjects, themeLabel, validateSlug, validateStatus, validateTheme } from './lib/render.mjs';
export { CS_END, CS_START, NARRATIVE_UNWRITTEN, currentStateFirstLine, getCurrentState, renderList, setCurrentState } from './lib/page.mjs';
export { commit, readStore, resolveRoot, today, writeStore } from './lib/portfolio.mjs';
export { cmdSync, currentStateDate, daysBetween, lastCommitDate, lastCommitDates, lastVerifiedDate } from './lib/sync.mjs';

// ── The mutating verbs ───────────────────────────────────────────────────────────────
// Everything below reaches disk, and two of them reach git. Three habits are load-bearing:
// the slug is validated before any path.join, the index is RENDERED before anything is
// written so a row that cannot render never lands in the store, and every read and write
// names 'utf8' because the `where` join is byte-exact on U+00B7.

export function findProject(store, slug) {
  return store.projects.find((p) => p.slug === slug);
}

function saveAndRender(root, store, extraPaths, message, opts) {
  // Rendered FIRST. assertRenderable throws on a pipe or a line break in any rendered field,
  // and if the store were written before that throw it would hold a row no render can emit,
  // which fails every later status, current and render call until someone edits the JSON.
  const index = renderIndex(store);
  // Only the entry files this write actually touched, deletions included. The old single path
  // named the whole store on every commit; naming all 60 entry files instead would put the
  // sharding back to where it started, with every commit claiming every project.
  const touched = writeStore(root, store);
  writeFileSync(join(root, REL_INDEX), index, 'utf8');
  console.log('RENDERED');
  if (opts.commit !== false) commit(root, [...touched, REL_INDEX, ...extraPaths], message);
}

export function cmdCurrent(root, args, body, opts = {}) {
  const slug = validateSlug(args[0]);
  const date = opts.date || today();
  if (!body || !body.trim()) throw new Error('projects: empty body, nothing to write');
  const store = readStore(root);
  const p = findProject(store, slug);
  if (!p) throw new Error(`projects: unknown project "${slug}"`);
  if (!p.page) throw new Error(`projects: "${slug}" has no page. Run projects register first`);
  const path = pagePath(root, p.page);
  if (!existsSync(path)) throw new Error(`projects: page ${p.page} is missing`);
  // setCurrentState runs INSIDE the writeFileSync argument on purpose: it refuses a page whose
  // markers it cannot bound, and that refusal has to leave the file byte-identical on disk.
  writeFileSync(path, setCurrentState(readFileSync(path, 'utf8'), body, date), 'utf8');
  p.lastTouched = date;
  saveAndRender(root, store, [`${PROJECTS_DIR}/${p.page}`], `projects: current state for ${slug}`, opts);
}

export function cmdStatus(root, args, opts = {}) {
  const slug = validateSlug(args[0]);
  const status = validateStatus(args[1]);
  const store = readStore(root);
  const p = findProject(store, slug);
  if (!p) throw new Error(`projects: unknown project "${slug}"`);
  p.status = status;
  p.lastTouched = opts.date || today();
  saveAndRender(root, store, [], `projects: ${slug} → ${status}`, opts);
}

// The mechanical fields other than status and slug, which have their own verbs. Before this, a
// row's `where` and `repo` could only be set at register time, so a project that moved worktree
// had no path at all once the store became the source and hand-editing it was denied. `where`
// changes often here, because worktrees come and go.
//
// `repo` is what lets sync check a project against reality: STALE compares its stated state to
// that repo's last commit, and MISSING-REPO fires when the path is gone. A row with no repo is
// invisible to both, which is correct for a docs-only or Notion-only project and a silent gap
// for one that has its own checkout.
export function cmdSet(root, args, opts = {}) {
  const slug = validateSlug(args[0]);
  const store = readStore(root);
  const p = findProject(store, slug);
  if (!p) throw new Error(`projects: unknown project "${slug}"`);
  const name = flag(args, '--name');
  const repo = flag(args, '--repo');
  const where = flag(args, '--where');
  const themeArg = flag(args, '--theme');
  if (name === null && repo === null && where === null && themeArg === null) {
    throw new Error('projects: nothing to set, pass at least one of --name, --where, --repo, --theme');
  }
  // Validated BEFORE any assignment below, on the line just before assertRenderable, so a bad
  // theme in a multi-flag call leaves the row exactly as it was rather than half-updated.
  const theme = themeArg === null ? null : validateTheme(themeArg);
  // Rendered fields go through the same gate register uses, and BEFORE anything is assigned: a
  // pipe or a line break here would corrupt the table or forge a row.
  assertRenderable({ name: name ?? p.name, where: where !== null ? [where] : (p.where || []),
    lastTouched: p.lastTouched || '', page: p.page || '' });
  if (name !== null) p.name = name;
  if (where !== null) p.where = [where];
  // Unlike --repo below, an empty string does NOT clear it: every row has a theme, and a cleared
  // one renders into a section it does not belong to. '' reaches validateTheme and is refused.
  if (theme !== null) p.theme = theme;
  // An empty string CLEARS repo, for a project whose own checkout has gone away. The key is
  // deleted rather than set to '', so absent has one representation, which is what every reader
  // already branches on.
  if (repo !== null) { if (repo === '') delete p.repo; else p.repo = repo; }
  // lastTouched is not bumped, for the same reason rename does not bump it.
  console.log('SET');
  saveAndRender(root, store, [], `projects: set ${slug}`, opts);
}

// Refused rather than accepted, because the next argv element is taken whatever it is: a typo'd
// `register x --name --status active` registered a project literally named "--status" at exit 0,
// and the name is the field a human reads in the index afterwards.
function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  // A flag in FINAL position used to return the fallback too, so `set alpha --theme` was
  // indistinguishable from passing no flags at all and set answered `nothing to set, pass at least
  // one of --name, --where, --repo, --theme` at exit 1: it named the flag the user had just passed.
  // Refused here rather than in cmdSet because this is the one place every flag on every verb is
  // read through, so one guard covers --name, --where, --repo, --theme and -n. `was given` puts it
  // on the same exit 2 as `--theme --name X`, which is the same mistake with one more word typed.
  if (i === args.length - 1) throw new Error(`projects: ${name} was given no value`);
  const value = args[i + 1];
  if (value.startsWith('--')) {
    throw new Error(`projects: ${name} was given ${value}, which is another flag. Quote the value if it really starts with --`);
  }
  return value;
}

export function cmdRegister(root, args, opts = {}) {
  const slug = validateSlug(args[0]);
  const store = readStore(root);
  if (findProject(store, slug)) throw new Error(`projects: "${slug}" is already registered`);
  const name = flag(args, '--name', slug);
  const status = validateStatus(flag(args, '--status', 'active'));
  // Required, not defaulted. A default would pool every new row in one theme silently, and
  // the whole reason this field exists is that the layer's failure mode is things nobody
  // remembers to do. Read here, with the other flags, so it throws before the page is written
  // and a refusal leaves no orphan page behind, the same guarantee assertRenderable has below.
  const themeArg = flag(args, '--theme');
  if (themeArg === null) {
    throw new Error(`projects: --theme is required, expected one of ${THEME_ORDER.join(', ')}`);
  }
  const theme = validateTheme(themeArg);
  const where = flag(args, '--where');
  const repo = flag(args, '--repo');
  const date = opts.date || today();
  const page = `${slug}.md`;
  const path = pagePath(root, page);
  // register is the only verb taking free text from argv into a rendered field, so it is the
  // only door a pipe can come through. Checked here, before the skeleton is written, so a
  // refusal leaves no orphan page behind either.
  assertRenderable({ name, where: where ? [where] : [], lastTouched: date, page });
  // Only when the page is absent. An existing page is ADOPTED, never overwritten: a hand
  // written narrative that predates the row is the whole reason this tool does not author prose.
  // `last verified never`, never a date: a skeleton's narrative is unwritten, so stamping today
  // claims a review that did not happen, and it would suppress sync's UNVERIFIED sentinel for
  // the whole staleness window on exactly the pages that most need it. The field is still
  // PRESENT, so no reader downstream needs a missing-field branch.
  //
  // No status in the header. Only the store carries the status, because `status` rewrites the
  // store and never the page, so a status written here would be the registration status forever
  // and no sync check compares the two. The list row carries the status instead.
  if (!existsSync(path)) {
    // A fresh repo has no docs/projects yet, and without this the write is a bare ENOENT.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# ${name}\n*last verified never · docs: none*\n\n`
      + `${NARRATIVE_UNWRITTEN}\n\n`
      + `## Current state (${date})\n${CS_START}\nRegistered ${date}. No status written yet.\n${CS_END}\n\n`
      + `## Future Directions\n\n## Docs map\n`, 'utf8');
  }
  store.projects.push({ slug, name, status, theme, where: where ? [where] : [],
    ...(repo ? { repo } : {}), page, lastTouched: date });
  saveAndRender(root, store, [`${PROJECTS_DIR}/${page}`], `projects: register ${slug}`, opts);
}

export function cmdArchive(root, args, opts = {}) {
  const slug = validateSlug(args[0]);
  const store = readStore(root);
  const p = findProject(store, slug);
  if (!p) throw new Error(`projects: unknown project "${slug}"`);
  const moved = [];
  if (p.page && existsSync(pagePath(root, p.page))) {
    const dest = join(root, PROJECTS_DIR, 'archive', p.page);
    // renameSync replaces the destination without a word. A second project reusing a retired
    // slug would silently destroy the first one's archived narrative, so refuse and keep both.
    if (existsSync(dest)) {
      throw new Error(`projects: there is already an archived page at ${
        PROJECTS_DIR}/archive/${p.page}. Move it aside first`);
    }
    mkdirSync(join(root, PROJECTS_DIR, 'archive'), { recursive: true });
    renameSync(pagePath(root, p.page), dest);
    moved.push(`${PROJECTS_DIR}/${p.page}`, `${PROJECTS_DIR}/archive/${p.page}`);
  }
  store.projects = store.projects.filter((x) => x.slug !== slug);
  console.log('ARCHIVED');
  saveAndRender(root, store, moved, `projects: archive ${slug}`, opts);
}

export function cmdRename(root, args, opts = {}) {
  const from = validateSlug(args[0]);
  const to = validateSlug(args[1]);
  const store = readStore(root);
  const p = findProject(store, from);
  if (!p) throw new Error(`projects: unknown project "${from}"`);
  if (from === to) throw new Error(`projects: "${from}" is already its own slug`);
  if (findProject(store, to)) throw new Error(`projects: "${to}" is already registered`);
  const moved = [];
  // The page moves only when its basename IS the old slug. A page whose name had already
  // diverged was named that way on purpose, and renaming it here would be a second change
  // nobody asked for. The row keeps pointing at it either way.
  if (p.page === `${from}.md`) {
    const dest = `${to}.md`;
    // Same refusal as archive, for the same reason: renameSync replaces a destination without
    // a word, so an unrelated page already sitting at the new name would be destroyed.
    if (existsSync(pagePath(root, dest))) {
      throw new Error(`projects: there is already a page at ${PROJECTS_DIR}/${dest}. Move it aside first`);
    }
    if (existsSync(pagePath(root, p.page))) {
      renameSync(pagePath(root, p.page), pagePath(root, dest));
      // BOTH paths, so git records a rename rather than a delete plus an untracked add.
      moved.push(`${PROJECTS_DIR}/${p.page}`, `${PROJECTS_DIR}/${dest}`);
    }
    p.page = dest;
  }
  p.slug = to;
  // lastTouched is deliberately NOT bumped. A rename is bookkeeping, not work on the project,
  // and bumping it would restart sync's staleness window on something nobody touched.
  console.log('RENAMED');
  saveAndRender(root, store, moved, `projects: rename ${from} to ${to}`, opts);
  warnDanglingParents(root, from, to);
}

// gtg entries name the family they belong to by a PORTFOLIO slug, in their own `parent` field.
// So a rename here can dangle a reference held in a store this CLI does not own, and the cost is
// silent: an unresolved parent just lists that project as standalone. Read gtg's stores to say
// so, and never write them, which is the boundary that keeps two separately-versioned tools from
// depending on each other's data format. A missing or unreadable store means gtg is not installed
// against this root, which is not a problem worth a word.
function warnDanglingParents(root, from, to) {
  const hits = [];
  // gtg's own sharded stores, read the same way gtg reads them. These were the packed
  // docs/handoffs/_active.json and _backlog.json until gtg 3.3.0 deleted them; against a
  // deleted file this loop found nothing and reported nothing, at exit 0, which is the exact
  // silent-miss the warning exists to prevent.
  for (const dir of ['docs/handoffs/active', 'docs/handoffs/backlog']) {
    try {
      for (const e of readCollection(root, dir, { name: 'projects' })) if (e && e.parent === from) hits.push(e.slug);
    } catch { /* not installed, or an unreadable record. Either way there is nothing to report. */ }
  }
  if (!hits.length) return;
  // Named remedy, not just a warning. `gtg rename` re-points a parent reference even when no
  // entry carries the old slug itself, which is exactly this case.
  console.log(`NOTE: ${hits.length} gtg entr${hits.length === 1 ? 'y' : 'ies'} still name "${
    from}" as their parent (${hits.join(', ')}). Re-point with: gtg rename ${from} ${to}`);
}

// The mutation log IS git. Every verb here commits with a descriptive subject, so the store and
// INDEX.md already carry the whole history including the hand-edited era before this CLI existed.
// A written ledger would be a second, thinner copy of a record git keeps for free.
export function cmdLog(root, args, opts = {}) {
  // A leading flag is not a slug. The slug pattern permits a leading '-', so `-n` would
  // otherwise validate as one and then be looked up as a project.
  const slug = args[0] && !args[0].startsWith('-') ? validateSlug(args[0]) : null;
  const n = flag(args, '-n', '20');
  // All three: the sharded store, the packed file it replaced, and the index. History spans
  // both eras, so dropping the packed path would cut the log off at the migration.
  let paths = [REL_ENTRIES, REL_STORE, REL_INDEX];
  const follow = [];
  if (slug) {
    const p = findProject(readStore(root), slug);
    if (!p) throw new Error(`projects: unknown project "${slug}"`);
    // --follow takes exactly one path, and tracking a page across renames is the whole reason
    // to ask per project: the store's own history cannot show it. A row with no page falls
    // back to the store, which is still that project's history, just coarser.
    if (p.page) { paths = [`${PROJECTS_DIR}/${p.page}`]; follow.push('--follow'); }
  }
  let out = '';
  try {
    out = execFileSync('git', ['log', `-n${n}`, '--date=short', '--format=%h %ad %s',
      ...follow, '--', ...paths], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch {
    // No repo, or no commits yet. Neither is a failure of the request.
    throw new Error('projects: no git history here');
  }
  process.stdout.write(out || 'projects: nothing recorded yet\n');
}

// Exported for the one test that asserts no theme key shadows a verb name, because main routes a
// theme filter before this lookup.
export const builtins = {
  // The slug is validated BEFORE stdin is read. The other way round, `projects current` with
  // no slug sits blocking on a terminal that is never going to send it an EOF.
  current: (root, rest) => {
    validateSlug(rest[0]);
    return cmdCurrent(root, rest, readFileSync(0, 'utf8'));
  },
  status: cmdStatus,
  register: cmdRegister,
  archive: cmdArchive,
  rename: cmdRename,
  set: cmdSet,
  log: cmdLog,
  // cmdSync returns the report rather than printing it, like renderList, so the tests stay
  // quiet and the exit code is decided in one place. A block sync cannot use is a real failure
  // (exit 1), where `list` degrades that row and stays 0. Matched at line start, so a filename
  // or a quoted reason merely containing the word cannot promote a clean report to a failure.
  // That guarantee rests on cmdSync squashing each flag to one line: a newline in a hand-edited
  // slug used to plant a MALFORMED line here and force exit 1 with nothing actually wrong.
  // The commit dates are fetched in parallel first, for every row cmdSync would ask about.
  sync: async (root, rest) => {
    const repos = readStore(root).projects.filter((p) => p.page && p.repo)
      .map((p) => resolve(root, p.repo)).filter((r) => existsSync(r));
    const dates = await lastCommitDates(repos);
    const out = cmdSync(root, rest, { commitDateFor: (r) => dates.get(r) ?? null });
    process.stdout.write(out);
    if (/^MALFORMED /m.test(out)) process.exit(1);
  },
  list: (root, rest) => process.stdout.write(renderList(root, readStore(root), rest[0] ?? null)),
  render: (root) => saveAndRender(root, readStore(root), [], 'projects: re-render index', {}),
  help: () => process.stdout.write(HELP),
  '--help': () => process.stdout.write(HELP),
  '-h': () => process.stdout.write(HELP),
};

const HELP = `projects: portfolio bookkeeping

  projects                     list every project grouped by theme, with its page's opening line
  projects <theme>             list one theme: ${THEME_ORDER.join(' | ')}
  projects current <slug>      replace that page's Current state from stdin
  projects status <slug> <s>   set status: active | paused | ops | done
  projects register <slug> --theme T [--name N --status S --where W --repo R]
  projects archive <slug>      move the page to archive/ and drop the row
  projects rename <old> <new>  change a slug, moving its page with it
  projects set <slug> [--name N --where W --repo R --theme T]   change a row's other fields
  projects log [slug] [-n N]   what happened, read from git. A slug follows its page
  projects sync                check every row against reality, reporting and never rewriting
  projects render              re-render INDEX.md from the store

INDEX.md is generated. Never hand-edit it.
`;

// The shapes every intentional throw in this file takes. validateSlug and validateStatus are
// the only two that do not carry the `projects: ` prefix.
const DELIBERATE = /^(projects: |invalid slug|unknown status|unknown theme)/;

// NO self-migration since 1.3.0. It read the packed docs/projects/_projects.json and sharded it,
// and that file is deleted, so there is nothing to migrate from: a root with no entries/ is a
// root with no projects registered, and the first `register` creates the directory. The
// per-verb catch that kept a corrupt packed file from making the CLI unusable went with it;
// readCollection now throws per RECORD instead, so one unparseable file names itself rather
// than emptying the list. To migrate a still-packed tree, install 1.1.1-1.2.0 once and let it
// shard, then upgrade. docs/runbooks/git-parity.md has the rollback.

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  // help reads no store, so it skips the git spawn that finds one.
  const root = ['help', '--help', '-h'].includes(cmd) ? '' : resolveRoot();
  try {
    if (root && !process.env.PROJECTS_STORE_SYNC) {
      installStoreHook(root);
      const result = syncStore(root);
      if (!['local', 'level', 'pulled', 'pushed'].includes(result)) {
        const readOnly = !cmd || Object.hasOwn(THEMES, cmd) || ['list', 'log', 'sync'].includes(cmd);
        if (!readOnly && ['conflict', 'busy', 'branch', 'locked'].includes(result)) throw new Error(`projects: shared store ${result}; retry after resolving it (see .git/projects-sync.log)`);
        console.error(`projects: shared store ${result}; using the local copy (see .git/projects-sync.log)`);
      }
    }
    if (!cmd) return builtins.list(root, []);
    // A theme reads as a filter, not a verb. Routed HERE rather than added to `builtins`,
    // which stays a map of verbs only so the Object.hasOwn guard below keeps doing exactly
    // the job its comment describes. Anything that is neither still exits 2 with help.
    if (Object.hasOwn(THEMES, cmd)) return builtins.list(root, [cmd]);
    // hasOwn, not truthiness: `builtins.constructor` and `builtins.toString` resolve up the
    // prototype chain, so `projects constructor` ran a function that is not a verb and exited 0.
    // An agent reads exit 0 as the command having worked.
    if (!Object.hasOwn(builtins, cmd)) {
      console.error(`projects: unknown command "${cmd}"\n\n${HELP}`);
      process.exit(2);
    }
    const out = builtins[cmd](root, rest);
    // sync is async, so its refusals arrive as a rejection and take the same exit path.
    if (out instanceof Promise) return out.catch(fail);
    return out;
  } catch (e) {
    fail(e);
  }
}

function fail(e) {
  const message = (e && e.message) || String(e);
  // Every deliberate refusal in this file carries a message we wrote. Anything else is a bug
  // HERE, and printing only its one-line message throws the stack away, which is how a typo
  // becomes an unexplained exit 1. A real bug gets to be loud.
  if (!DELIBERATE.test(message)) {
    console.error('projects: internal error, this is a bug in projects.mjs');
    console.error((e && e.stack) || message);
    process.exit(1);
  }
  console.error(message);
  // 2 is "you asked for something that is not a thing", 1 is "the operation failed".
  // A refused page write is a 1: the request was valid, the file on disk is not.
  // `Migrate it first` rides along here rather than in a code on the error, because classifying by
  // message fragment is what this function already does and one more fragment is less machinery
  // than a second convention. An unmigrated root is an environment problem, so 2.
  // No `unknown command` fragment: that branch above exits directly and never throws.
  // `is required` is the same class as `was given`: an invocation missing a required field is a
  // malformed command, not a failed operation, and without it ONE user mistake exits two
  // different ways depending on argv shape (`register demo --theme --name X` throws
  // `was given` → 2, `register demo` with no --theme at all → 1).
  process.exit(/unknown status|unknown theme|unknown project|invalid slug|was given|is required|no page|Migrate it first/.test(message) ? 2 : 1);
}

if (isMain(import.meta.url)) main();
