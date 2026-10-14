// gtg.test's shared harness: temp repos, the CLI runner and the store readers. Not a test file
// (the glob is *.test.mjs), so it never runs on its own. The cases import it from gtg-part*.test.mjs.
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readCollection, writeCollection } from '../skills/gtg/lib/store.mjs';

export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');
export const SHIM = (name) => pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), name)).href;
// Two minutes back, past syncHub's one-minute fetch skip (#101): the next resume fetches again.
export const ageFetchHead = (repo) => { const t = new Date(Date.now() - 120e3); utimesSync(join(repo, '.git', 'FETCH_HEAD'), t, t); };

export function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gtg-'));
  execSync('git init -q -b main', { cwd: dir });
  appendFileSync(join(dir, '.git', 'config'), '\n[user]\n\temail = test@test\n\tname = test\n');
  return dir;
}

// Like tempRepo() but deliberately WITHOUT a local identity, so commit() can be
// forced into a genuine (non-"nothing to commit") git failure by also isolating
// global/system config (see the commit-failure test below).
export function tempRepoNoIdentity() {
  const dir = mkdtempSync(join(tmpdir(), 'gtg-noid-'));
  execSync('git init -q -b main', { cwd: dir });
  return dir;
}

// Run the CLI. GTG_HUB is stripped from the inherited env unless opts.hub is given,
// so the dev machine's own hub setting can't leak into the tests.
// GIT_CEILING_DIRECTORIES pins git's upward repo search at tmpdir so a bare
// temp dir can't resolve to an enclosing repo (e.g. a git-tracked home dir).
// opts.session pins the session id undo scopes itself to: a string names one, null
// strips it entirely (the no-identity case). Defaulted rather than inherited so a run
// inside a Claude session and a run in CI behave identically - a real
// CLAUDE_CODE_SESSION_ID leaking in would make undo pass locally and fail in CI.
export function gtg(cwd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  delete env.GTG_HUB;
  if (!(opts.env && 'PROJECTS_ROOT' in opts.env)) delete env.PROJECTS_ROOT;
  env.PROJECTS_STORE_CONFIG = join(tmpdir(), 'gtg-test-no-projects-config.json');
  if (opts.noCodex) {
    for (const key of Object.keys(env)) if (key.startsWith('CODEX_')) delete env[key];
  }
  if (!(opts.env && 'CLAUDE_CODE_SESSION_ID' in opts.env)) delete env.CLAUDE_CODE_SESSION_ID;
  env.GIT_CEILING_DIRECTORIES = tmpdir();
  if (opts.session === null) delete env.GTG_SESSION_ID;
  else env.GTG_SESSION_ID = opts.session || 'test-session';
  if (opts.hub) env.GTG_HUB = opts.hub;
  // opts.tty: run gtg's TTY branch with stdout still piped to the test (colour off).
  // opts.spawnLog: print the child processes gtg ran, as one GTG_SPAWNS line on stderr.
  const pre = [];
  if (opts.tty) { pre.push('--import', SHIM('tty-shim.mjs')); env.NO_COLOR = '1'; }
  if (opts.spawnLog) pre.push('--import', SHIM('spawn-log-shim.mjs'));
  // opts.lockMerge: the first `git merge` meets a held index.lock (after spawnLog, so both tries log).
  if (opts.lockMerge) pre.push('--import', SHIM('lock-once-shim.mjs'));
  return spawnSync(process.execPath, [...pre, CLI, ...args], {
    cwd, env, encoding: 'utf8', input: opts.input ?? '',
  });
}

export const HANDOFF_ARGS = (slug, project) => [
  'handoff', '--project', project, '--slug', slug,
  '--eta', '~2h', '--next', 'do the next thing',
];
export const BODY = '## What Was Done This Session\n- stuff\n\n## Next Action\ndo the next thing\n';

// Store readers. Through readCollection, not a hand-rolled file read, so every fixture is read
// the same way gtg reads it.
export const ACTIVE = 'docs/handoffs/active';
export const BACKLOG = 'docs/handoffs/backlog';
export const active = (root) => readCollection(root, ACTIVE);
export const backlog = (root) => readCollection(root, BACKLOG);
// The packed stores, DELETED in 3.3.0. Named only by the cases that are ABOUT the pre-shard era:
// the two effort cases that read git history across the migration, case 71 asserting no packed
// file is present, and case 72 seeding one as the whole-file JSON that a third-party extension
// hands to readStore. No fixture may seed one and expect the CLI to read it as a store.
export const PACKED_ACTIVE = 'docs/handoffs/_active.json';
export const PACKED_BACKLOG = 'docs/handoffs/_backlog.json';
// One active record per file, written straight to disk. Cases 18 and 25 need an entry with NO
// `sessions` field, which no gtg verb will write - a handoff always stamps one - so the fixture
// has to place the record itself. It used to place a packed _active.json and let the startup
// migration shard it; there is no migration now, so it writes the record file directly.
export const seedActive = (root, recs) => {
  mkdirSync(join(root, ACTIVE), { recursive: true });
  for (const r of recs) writeFileSync(join(root, ACTIVE, `${r.slug}.json`), JSON.stringify(r, null, 2) + '\n');
};
// What a commit actually named, as "<status>\t<path>" lines. --no-renames on purpose: a park
// moves a record between two directories with the body barely changing, and rename detection
// would collapse the pair into one R line - hiding whether BOTH paths were named, which is the
// only thing that decides whether the removal gets committed or left for the next session.
export const nameStatus = (root, ref) =>
  execSync(`git show --no-renames --name-status --format= ${ref}`, { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);

// Mutate the store the way the other machine would: read, edit, write each record back.
// Several cases backdate `updated` to prove stale work stays explicit and bookkeeping leaves
// activity timestamps alone.
export const patchActive = (root, fn) => {
  const items = active(root);
  fn(items);
  writeCollection(root, ACTIVE, items);
};
