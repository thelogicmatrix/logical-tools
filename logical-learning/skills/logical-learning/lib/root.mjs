// lib-cli/root.mjs. Canonical in the logical-tools repo, vendored into each plugin that lists it in a
// .framework.json. Edit the canonical copy, run node scripts/sync-lib.mjs, commit both.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

// The file lets a running desktop process see a newly configured portfolio without a restart.
export function configuredRoot(envName, { env = process.env, home = homedir() } = {}) {
  if (typeof env[envName] === 'string' && env[envName] !== '') return env[envName];
  if (envName !== 'PROJECTS_ROOT') return null;
  const path = env.PROJECTS_STORE_CONFIG || join(home, '.projects', 'store.json');
  if (!existsSync(path)) return null;
  const { root } = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof root !== 'string' || !root || (!isAbsolute(root) && !/^[A-Za-z]:[\\/]/.test(root))) {
    throw new Error('projects: persisted store root must be an absolute path');
  }
  return root;
}

// The git toplevel that holds cwd, or null outside a repo, when git is missing, or when it hangs.
// No shell, and a timeout, so a credential prompt or a stuck hook cannot hang the CLI that asked.
// git's stderr is dropped, since the caller says what went wrong in its own words.
export function gitTop(cwd = process.cwd(), { timeout = 2000 } = {}) {
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim();
    return top || null;
  } catch {
    return null;
  }
}

// A CLI's storage root: the named variable when it is set and not empty, else the git toplevel of
// cwd, else null. The caller prints the message for null, because only it knows its own name and
// which variable to tell the user to set.
export function hubRoot(envName, { env = process.env, cwd = process.cwd(), timeout, home } = {}) {
  const set = configuredRoot(envName, { env, home });
  if (set) return set;
  return gitTop(cwd, { timeout });
}
