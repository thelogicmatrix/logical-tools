#!/usr/bin/env node
// Opt-in transport for a dedicated projects-store checkout. Local portfolios keep their old behavior.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCollection } from './lib/store.mjs';
import { renderIndex, REL_ENTRIES, REL_INDEX } from './lib/render.mjs';
import { isMain } from './lib/exit.mjs';

const MARKER = '.projects-store.json';
const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', PROJECTS_STORE_SYNC: '1' });
export function isSharedStore(root) {
  const marker = join(root, MARKER);
  if (!existsSync(marker)) return false;
  if (JSON.parse(readFileSync(marker, 'utf8')).version !== 1) throw new Error('projects: unsupported shared store version');
  return true;
}

export function acquireStoreLock(lock) {
  try { mkdirSync(lock); return true; } catch {}
  // Serialize recovery, then inspect the lock again. A second reaper must never delete a new owner's lock.
  const recovery = `${lock}.recovery`;
  try { mkdirSync(recovery); } catch { return false; }
  try {
    try {
      if (Date.now() - statSync(lock).mtimeMs <= 600000) return false;
      let alive = false;
      try {
        const { pid } = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; }
      } catch {}
      if (alive) return false;
      rmSync(lock, { recursive: true, force: true });
    } catch (error) { if (error.code !== 'ENOENT') return false; }
    try { mkdirSync(lock); return true; } catch { return false; }
  } finally { rmSync(recovery, { recursive: true, force: true }); }
}

// Every store commit starts a background sync (installStoreHook), so a second write right after
// the first meets that sync's lock. Wait for it to finish rather than refusing the write.
export function waitForStoreLock(lock, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    if (acquireStoreLock(lock)) return true;
    if (Date.now() >= until) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

// waitMs bounds the wait for another sync: a full sync is at most two 12-second fetches and a push.
export function syncStore(root, { waitMs = 30000 } = {}) {
  if (!isSharedStore(root)) return 'local';
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 12000, windowsHide: true,
  }).trim();
  const ok = (...args) => { try { git(...args); return true; } catch { return false; } };
  const canonical = path => {
    const full = realpathSync.native(resolve(path));
    return process.platform === 'win32' ? full.toLowerCase() : full;
  };
  if (canonical(git('rev-parse', '--show-toplevel')) !== canonical(root)) throw new Error('projects: shared store root must be its own repository');
  const gitDir = git('rev-parse', '--absolute-git-dir');
  const log = message => appendFileSync(join(gitDir, 'projects-sync.log'), `${new Date().toISOString()} ${message}\n`);
  const lock = join(gitDir, 'projects-sync.lock');
  if (!waitForStoreLock(lock, waitMs)) return 'locked';
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    if (git('symbolic-ref', '--short', '-q', 'HEAD') !== 'main') { log('skipped: checkout is not on main'); return 'branch'; }
    if (['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].some(f => existsSync(join(gitDir, f)))) {
      log('skipped: another Git operation is in progress'); return 'busy';
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!ok('fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main')) { log('fetch failed; committed work retained'); return 'offline'; }
      const target = 'refs/remotes/origin/main';
      const [ahead, behind] = git('rev-list', '--left-right', '--count', `HEAD...${target}`).split(/\s+/).map(Number);
      if (behind) {
        // Include untracked files: an incoming path could collide with an unfinished new narrative.
        if (git('status', '--porcelain')) { log('incoming changes pending: checkout has uncommitted work'); return 'dirty'; }
        if (!ok('merge', '-q', ...(ahead ? ['--no-edit'] : ['--ff-only']), target)) {
          const conflicts = git('diff', '--name-only', '--diff-filter=U').split(/\r?\n/).filter(Boolean);
          if (ahead && conflicts.length === 1 && conflicts[0] === REL_INDEX) {
            try {
              const projects = readCollection(root, REL_ENTRIES, { name: 'projects' });
              writeFileSync(join(root, REL_INDEX), renderIndex({ projects }));
              git('add', '--', REL_INDEX);
              git('commit', '-q', '--no-edit');
            } catch {
              if (!ok('merge', '--abort')) throw new Error('projects: index merge recovery failed; inspect the shared store');
              log('generated index could not be regenerated; merge aborted'); return 'conflict';
            }
          } else {
            if (!ok('merge', '--abort')) throw new Error('projects: merge recovery failed; inspect the shared store');
            log(`merge conflict, aborted; local commits retained: ${conflicts.join(', ') || 'merge refused'}`);
            return 'conflict';
          }
        }
      }
      if (!ahead) return behind ? 'pulled' : 'level';
      if (ok('push', '-q', 'origin', 'HEAD:refs/heads/main')) return 'pushed';
    }
    log('push failed twice; local commits retained'); return 'push-failed';
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
export function installStoreHook(root) {
  if (!isSharedStore(root)) return;
  const gitDir = execFileSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const hook = join(gitDir, 'hooks', 'post-commit');
  const signature = '# logical-projects shared store sync';
  const prior = existsSync(hook) ? readFileSync(hook, 'utf8') : '';
  // An owner's unrelated hook stays intact; the schedule still syncs its commits.
  if (prior && !prior.includes(signature)) return;
  const script = fileURLToPath(import.meta.url).replaceAll('\\', '/');
  const body = `#!/bin/sh\n${signature}\n[ "$PROJECTS_STORE_SYNC" = 1 ] && exit 0\n${quote(process.execPath.replaceAll('\\', '/'))} ${quote(script)} "$(git rev-parse --show-toplevel)" </dev/null >/dev/null 2>&1 &\n`;
  if (prior !== body) { mkdirSync(join(gitDir, 'hooks'), { recursive: true }); writeFileSync(hook, body, { mode: 0o755 }); }
}

if (isMain(import.meta.url)) {
  try {
    const root = process.argv[2] || process.env.PROJECTS_ROOT;
    if (!root) throw new Error('projects: store sync requires a root');
    installStoreHook(root);
    const result = syncStore(root);
    console.log(`projects store: ${result}`);
    if (!['local', 'level', 'pulled', 'pushed', 'locked'].includes(result)) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
