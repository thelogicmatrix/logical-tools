// The one place every runbooks script resolves paths and settings.
// .runbooks/ is the user tier: project root first, then ~/.runbooks. First found wins, no merging.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitTop } from './lib/root.mjs';

// Spend and dedupe logs. LOCALAPPDATA on Windows, XDG-style state dir elsewhere.
export const STATE_DIR = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'claude-router')
  : join(homedir(), '.local', 'state', 'claude-router');

// Measured values the router was tuned at.
const DEFAULTS = { firesAt: 0.8, maxInject: 6, shortlist: 30 };

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// Git top of cwd, or cwd itself when it is not in a repo or git is unavailable.
export function projectRoot(cwd) {
  return resolve(gitTop(cwd) ?? cwd);
}

function rootFrom(project, cwd, home) {
  return [join(project, '.runbooks'), join(resolve(cwd), '.runbooks'), join(home, '.runbooks')].find(isDir) ?? null;
}

export function findRoot(cwd, home = homedir()) {
  return rootFrom(projectRoot(cwd), cwd, home);
}

export function loadConfig(rootDir) {
  if (!rootDir) return {};
  try {
    const c = JSON.parse(readFileSync(join(rootDir, 'config.json'), 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch { return {}; }
}

// Relative paths in config.json are relative to the folder holding .runbooks/.
const fromRoot = (root, p) => (isAbsolute(p) || !root ? resolve(p) : resolve(dirname(root), p));

// A relative RUNBOOKS_DIR resolves from the cwd argument, not the process cwd, which for a hook is
// wherever the harness happened to start it.
// A config.dir pins the store so worktrees of a repo do not route their empty copies. Read from
// ~/.runbooks as the fallback for another repo, that pin would hide the repo's own docs/runbooks,
// so there it ranks below them (#132).
function dirFrom({ cwd, project, root, config, env, home }) {
  const named = typeof config.dir === 'string' && config.dir && fromRoot(root, config.dir);
  const own = join(project, 'docs', 'runbooks');
  const candidates = [
    [env.RUNBOOKS_DIR && resolve(cwd, env.RUNBOOKS_DIR), 'named'],
    ...(homeTier(root, project, home) ? [[own, 'found'], [named, 'named']] : [[named, 'named'], [own, 'found']]),
    [join(home, 'docs', 'runbooks'), 'found'],
  ];
  const hit = candidates.find(([p]) => p && isDir(p));
  return hit ? { dir: hit[0], from: hit[1] } : { dir: null, from: null };
}

// .runbooks/ holds the topics map only for the runbooks it sits beside, or the ones its config or
// RUNBOOKS_DIR named. Otherwise a map scored against one repo's runbooks lands in another's
// .runbooks/, where its slugs are dead (#121). A found folder is owned only when it is exactly
// <parent of .runbooks>/docs/runbooks. Any folder under that parent was too loose, because for
// ~/.runbooks the parent is the whole home folder and every repo under it would write home's map.
function ownsDir(root, dir, from) {
  if (!root || !dir) return false;
  return from === 'named' || resolve(dir) === resolve(dirname(root), 'docs', 'runbooks');
}

// ~/.runbooks reached from a repo other than home itself.
const homeTier = (root, project, home) =>
  Boolean(root) && resolve(root) === resolve(home, '.runbooks') && resolve(project) !== resolve(home);

// A worktree of home is home, on any branch. The ones under C:/dev that carry docs/runbooks are on
// branches from before the store moved out, so that folder is a stale copy, not runbooks of their
// own. Read from the .git file and commondir rather than a git spawn, because this runs on every
// prompt. A .git folder means a repo of its own; a .git file with no commondir is a submodule.
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
function isHomeWorktree(project, home) {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(project, '.git'), 'utf8'));
    if (!m) return false;
    const gitdir = resolve(project, m[1]);
    const common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim());
    return samePath(common, resolve(home, '.git'));
  } catch { return false; }
}

function resolveAll({ cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  const top = projectRoot(cwd);
  const asHome = isHomeWorktree(top, home);
  const project = asHome ? resolve(home) : top;
  const root = asHome ? rootFrom(project, project, home) : rootFrom(project, cwd, home);
  const config = loadConfig(root);
  const { dir, from } = dirFrom({ cwd, project, root, config, env, home });
  return { root, config, dir, topicsRoot: ownsDir(root, dir, from) ? root : null };
}

export function resolveDir(opts) {
  return resolveAll(opts).dir;
}

// A non-numeric value in config.json falls back to the default rather than reaching the router.
const num = (v, d) => (Number.isFinite(v) ? v : d);

export function settings(opts) {
  const { root, config, dir, topicsRoot } = resolveAll(opts);
  const firesAt = num(config.firesAt, DEFAULTS.firesAt);
  // A writeBar under firesAt would pass a purpose the router never fires on, so it falls back too.
  const writeBar = num(config.writeBar, -Infinity);
  // A ledger is keyed by slug like the topics map, so a .runbooks/ that does not own the runbooks
  // in use does not get their entries either.
  const ledger = topicsRoot && typeof config.ledger === 'string' && config.ledger
    ? fromRoot(root, config.ledger)
    : dir && join(dir, '.router-ledger.json');
  return {
    root,
    dir,
    topicsRoot,
    firesAt,
    writeBar: writeBar >= firesAt ? writeBar : +(firesAt + 0.05).toFixed(2),
    maxInject: num(config.maxInject, DEFAULTS.maxInject),
    shortlist: num(config.shortlist, DEFAULTS.shortlist),
    ledger: ledger || null,
  };
}

const listFiles = (dir, ext) => (isDir(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : []);

// <root>/<kind>/*.mjs whose default export is a function. A file that throws on import is skipped,
// and so is a *.test.mjs, so an extension's own tests can sit beside it without running as one.
export async function loadExtensions(root, kind) {
  if (!root) return [];
  const dir = join(root, kind);
  const out = [];
  for (const file of listFiles(dir, '.mjs').filter((f) => !f.endsWith('.test.mjs'))) {
    try {
      const mod = await import(pathToFileURL(join(dir, file)).href);
      if (typeof mod.default === 'function') out.push({ name: basename(file, '.mjs'), fn: mod.default });
    } catch {}
  }
  return out;
}

