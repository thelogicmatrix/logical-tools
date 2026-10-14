#!/usr/bin/env node
// The outbound gate for a public release. Builds one commit on top of the public main whose tree is
// this checkout's HEAD minus the paths in .public-exclude, scans that exact tree and the commit
// message (scripts/public-scan.mjs, generic rules plus the publisher's private terms), and pushes
// only with --push. One new commit, never the private history: private commit messages carry
// review URLs with the private server's address.
//
//   node scripts/release-public.mjs [--remote github] [--branch main] [--push]
//
// Refuses when the tree is dirty, when the private terms file is missing, when the scan finds
// anything, or when the public main changed outside a release (a web edit: bring it into the
// private repo first).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GENERIC_RULES, decode, loadPrivateTerms, scanFiles, scanPublic, termsFile } from './public-scan.mjs';

// stderr captured: a probe for a file that may not exist must not print git's fatal line.
const git = (root, args, opts = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();

export function excludes(root, ref = 'HEAD') {
  let text = '';
  try { text = git(root, ['show', `${ref}:.public-exclude`]); } catch { return []; }
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// The release tree: ref's tree without the excluded paths, built in a throwaway index.
export function buildTree(root, ref = 'HEAD') {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(root, ['read-tree', ref], { env });
    for (const p of excludes(root, ref)) git(root, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', p], { env });
    return git(root, ['write-tree'], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every text file in a tree, read in one git process.
export function treeFiles(root, tree) {
  const entries = git(root, ['ls-tree', '-r', '-z', tree], { maxBuffer: 64 << 20 }).split('\0').filter(Boolean)
    .map((l) => { const [meta, path] = l.split('\t'); return { path, sha: meta.split(' ')[2], type: meta.split(' ')[1] }; })
    .filter((e) => e.type === 'blob');
  const out = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: entries.map((e) => e.sha).join('\n') + '\n', maxBuffer: 256 << 20 }).stdout;
  const files = [];
  let at = 0;
  for (const e of entries) {
    const nl = out.indexOf(0x0a, at);
    const size = Number(out.subarray(at, nl).toString().split(' ')[2]);
    const buf = out.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    files.push({ path: e.path, text: decode(buf) });
  }
  return files;
}

export function scanRelease({ files, message, privateRules }) {
  return [
    ...scanPublic(files, privateRules),
    ...scanFiles([{ path: '(commit message)', text: message }], [...GENERIC_RULES, ...privateRules]),
  ];
}

// Whether the public main is something a release made, or an ancestor of what we release from.
// Anything else means someone edited the public repo directly.
export function checkBase(root, base, source) {
  const recorded = /^Release-Tree: ([0-9a-f]{40})$/m.exec(git(root, ['log', '-1', '--format=%B', base]))?.[1];
  if (recorded) {
    if (recorded === git(root, ['rev-parse', `${base}^{tree}`])) return null;
    return `${base} changed after the last release (its tree is not the one the release recorded). Bring that change into this repo first.`;
  }
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', base, source], { cwd: root }).status === 0;
  return ancestor ? null : `${base} has commits that are neither a release nor in ${source}. Bring them into this repo first.`;
}

export function releaseMessage(root, source, tree, date = new Date().toISOString().slice(0, 10)) {
  const versions = git(root, ['ls-tree', '--name-only', tree]).split('\n').flatMap((dir) => {
    try { return [`${dir} ${JSON.parse(git(root, ['show', `${tree}:${dir}/.claude-plugin/plugin.json`])).version}`]; } catch { return []; }
  });
  return `Release ${date}\n\n${versions.join('\n')}\n\nRelease-Source: ${source}\nRelease-Tree: ${tree}\n`;
}

export function release({ root, remote = 'github', branch = 'main', push = false, env = process.env, log = console.log }) {
  if (git(root, ['status', '--porcelain'])) throw new Error('the working tree has uncommitted changes: commit or stash them first');
  const priv = loadPrivateTerms(env);
  if (!priv) throw new Error(`no private terms at ${termsFile(env)}: the scan would miss the names that matter`);
  git(root, ['fetch', '-q', remote]);
  const base = `${remote}/${branch}`;
  const source = git(root, ['rev-parse', 'HEAD']);
  const baseProblem = checkBase(root, base, source);
  if (baseProblem) throw new Error(baseProblem);
  const tree = buildTree(root, source);
  if (tree === git(root, ['rev-parse', `${base}^{tree}`])) { log(`nothing to release: ${base} already has this tree`); return null; }
  const message = releaseMessage(root, source, tree);
  const hits = scanRelease({ files: treeFiles(root, tree), message, privateRules: priv });
  if (hits.length) throw new Error(`the release would publish ${hits.length} private match(es):\n${hits.join('\n')}`);
  const commit = git(root, ['commit-tree', tree, '-p', git(root, ['rev-parse', base]), '-F', '-'], { input: message });
  log(`release ${commit} on ${base}, scan clean, excluded: ${excludes(root, source).join(', ') || 'nothing'}`);
  // The author and committer publish too, so show them before the push.
  log(git(root, ['log', '-1', '--format=author %an <%ae>, committer %cn <%ce>', commit]));
  log(git(root, ['diff', '--shortstat', base, commit]));
  if (!push) { log(`not pushed. To publish: git push ${remote} ${commit}:refs/heads/${branch}  (or rerun with --push)`); return commit; }
  git(root, ['push', remote, `${commit}:refs/heads/${branch}`]);
  log(`pushed ${commit} to ${remote} ${branch}`);
  return commit;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  try {
    release({ root: git(process.cwd(), ['rev-parse', '--show-toplevel']), remote: opt('--remote'), branch: opt('--branch'), push: args.includes('--push') });
  } catch (e) {
    console.error(`release-public: ${e.message}`);
    process.exitCode = 1;
  }
}
