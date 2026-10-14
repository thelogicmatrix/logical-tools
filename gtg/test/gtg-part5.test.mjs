// gtg self-check, part 5 of 6 - assert-based, no framework. Runs every command against
// throwaway temp git repos. Non-zero exit on any failure. One file was ~97 s on its own, so the
// cases are split across gtg-part1..6.test.mjs, which the runner runs side by side (#128).
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readCollection, writeCollection } from '../skills/gtg/lib/store.mjs';
import { CLI, SHIM, ageFetchHead, tempRepo, tempRepoNoIdentity, gtg, HANDOFF_ARGS, BODY, ACTIVE, BACKLOG, active, backlog, PACKED_ACTIVE, PACKED_BACKLOG, seedActive, nameStatus, patchActive } from './gtg-harness.mjs';

// --- 54-57. unparent clears a parent, which rename cannot express ---
// rename's <new> is held to /^[A-Za-z0-9_-]+$/, so it can only re-POINT a parent. Re-pointing a
// dangling parent at the entry's own slug just trades it for a self-parent, the same defect.
{
  const dir = tempRepo();
  gtg(dir, ['handoff', '--project', 'Alpha', '--slug', 'alpha', '--next', 'x',
    '--parent', 'ghost'], { input: 'body\n' });
  // Bookkeeping is not work, so the idle clock the review question runs on must not restart.
  // Backdated first, and captured BEFORE the unparent:
  // reading `updated` afterwards can only catch a deletion, and nowIso() is second-
  // granularity, so a stamp taken "now" would compare equal to a restamp in the same second.
  const before = new Date(Date.now() - 2 * 86400000).toISOString();
  patchActive(dir, (h) => { h[0].updated = before; });
  const cleared = gtg(dir, ['unparent', 'alpha']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /Cleared parent 'ghost' from Alpha/);
  const entry = active(dir).find((e) => e.slug === 'alpha');
  // Deleted, not nulled: absent has ONE representation, which is what every reader
  // already branches on.
  assert.equal('parent' in entry, false);
  assert.equal(entry.updated, before, 'updated must not be restamped');
  console.log('ok 54 - unparent deletes the parent key and leaves updated alone');
}

{
  const dir = tempRepo();
  gtg(dir, ['handoff', '--project', 'Solo', '--slug', 'solo', '--next', 'x'],
    { input: 'body\n' });
  const twice = gtg(dir, ['unparent', 'solo']);
  assert.equal(twice.status, 2);
  assert.match(twice.stderr, /'solo' has no parent/);
  console.log('ok 55 - an entry with no parent is refused, not silently succeeded');
}

{
  const dir = tempRepo();
  const missing = gtg(dir, ['unparent', 'nope']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /No project matching 'nope'/);
  const noArg = gtg(dir, ['unparent']);
  assert.equal(noArg.status, 2);
  assert.match(noArg.stderr, /Usage: gtg unparent/);
  console.log('ok 56 - unparent rejects an unknown target and a missing argument');
}

{
  // A backlog entry resolves too, with active winning a collision the way rename does.
  const dir = tempRepo();
  gtg(dir, ['backlog', '--project', 'Shelved', '--slug', 'shelved', '--next', 'x',
    '--parent', 'ghost'], { input: 'body\n' });
  const out = gtg(dir, ['unparent', 'shelved']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal('parent' in backlog(dir).find((e) => e.slug === 'shelved'), false);
  console.log('ok 57 - unparent reaches a backlog entry too');
}

// --- 1.11.0: slug reuse in the CLI, --wip, after-handoff hook, harness ---
{
  // One name-matching entry lends its slug, so the skill needs no `list <name>` probe first.
  const dir = tempRepo();
  gtg(dir, HANDOFF_ARGS('alpha-project', 'Alpha Project'), { input: BODY });
  const r = gtg(dir, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /slug: reusing alpha-project/);
  const hs = active(dir);
  assert.equal(hs.length, 1, 'must update the existing entry, not mint a second');
  assert.equal(hs[0].slug, 'alpha-project');
  assert.equal(hs[0].sessions, 2);
  console.log('ok 58 - a fresh slug whose project name matches one entry reuses that slug');
}

{
  // --exact keeps the given slug (the `gtg [project]` override); two+ matches stay ambiguous.
  const dir = tempRepo();
  gtg(dir, HANDOFF_ARGS('alpha-one', 'Alpha One'), { input: BODY });
  const exact = gtg(dir, [...HANDOFF_ARGS('alpha', 'Alpha'), '--exact'], { input: BODY });
  assert.equal(exact.status, 0, exact.stderr);
  assert.doesNotMatch(exact.stdout, /slug: reusing/);
  assert.equal(active(dir).length, 2);
  gtg(dir, HANDOFF_ARGS('alpha-two', 'Alpha Two'), { input: BODY });
  const amb = gtg(dir, HANDOFF_ARGS('alpha-x', 'Alpha'), { input: BODY });
  assert.doesNotMatch(amb.stdout, /slug: reusing/);
  assert.equal(active(dir).length, 4, 'two name matches must not pick one');
  console.log('ok 59 - --exact and ambiguous matches keep the given slug');
}

{
  // --wip commits the worktree's uncommitted work in the same call; a clean tree is fine;
  // 'repo root' is never swept (a shared checkout).
  const hub = tempRepo();
  const wt = tempRepo();
  writeFileSync(join(wt, 'a.txt'), 'a\n');
  execSync('git add a.txt && git commit -q -m init', { cwd: wt });
  writeFileSync(join(wt, 'a.txt'), 'b\n');
  writeFileSync(join(wt, 'new.txt'), 'n\n');
  let r = gtg(hub, [...HANDOFF_ARGS('w', 'W'), '--worktree', wt, '--wip'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wip: committed/);
  assert.equal(execSync('git status --porcelain', { cwd: wt }).toString().trim(), '');
  assert.match(execSync('git log -1 --format=%s', { cwd: wt }).toString(), /wip: gtg checkpoint - W/);
  r = gtg(hub, [...HANDOFF_ARGS('w', 'W'), '--worktree', wt, '--wip'], { input: BODY });
  assert.equal(r.status, 0, 'a clean worktree is not an error');
  assert.doesNotMatch(r.stdout, /wip: committed/);
  writeFileSync(join(hub, 'stray.txt'), 'other session\n');
  r = gtg(hub, [...HANDOFF_ARGS('h', 'H'), '--wip'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.match(execSync('git status --porcelain', { cwd: hub }).toString(), /\?\? stray\.txt/,
    'repo root must never be swept by --wip');
  console.log('ok 60 - --wip checkpoints the worktree only');
}

{
  // after-handoff.mjs runs once the handoff is committed, sees the entry/body, and is skipped
  // for a backlog park. A throwing hook is reported (exit 1) without undoing the handoff.
  const dir = tempRepo();
  mkdirSync(join(dir, '.gtg'), { recursive: true });
  writeFileSync(join(dir, '.gtg', 'after-handoff.mjs'),
    `import { writeFileSync } from 'node:fs';
export default async (ctx) => {
  writeFileSync(ctx.root + '/hook-ran.json', JSON.stringify({ keys: Object.keys(ctx).sort(), slug: ctx.entry.slug, file: ctx.file, body: ctx.body, checkpoint: ctx.checkpoint }));
  console.log('hook says hi');
};\n`);
  let r = gtg(dir, HANDOFF_ARGS('hk', 'Hooked'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hook says hi/);
  const ran = JSON.parse(readFileSync(join(dir, 'hook-ran.json'), 'utf8'));
  assert.deepEqual(ran.keys, ['body', 'checkpoint', 'commit', 'entry', 'file', 'readStore', 'root', 'worktree', 'writeStore']);
  assert.equal(ran.slug, 'hk');
  assert.equal(ran.file, 'docs/handoffs/current/hk.md');
  assert.equal(ran.checkpoint, false);
  assert.equal(ran.body, BODY.trim());
  assert.ok(r.stdout.trim().endsWith('RESUME: "gtg hk"'), 'RESUME stays the last line');
  r = gtg(dir, [...HANDOFF_ARGS('hk', 'Hooked'), '--checkpoint'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'hook-ran.json'), 'utf8')).checkpoint, true,
    '--checkpoint must reach the hook without changing the handoff command');
  try { execFileSync('git', ['rm', '-q', '--cached', 'hook-ran.json'], { cwd: dir, stdio: 'ignore' }); }
  catch { /* absent from the index is the intended already-clean state */ }
  rmSync(join(dir, 'hook-ran.json'), { force: true });
  gtg(dir, ['backlog', '--project', 'Idea', '--slug', 'idea', '--next', 'x'], { input: 'body\n' });
  assert.equal(existsSync(join(dir, 'hook-ran.json')), false, 'hook must not fire on a backlog park');
  writeFileSync(join(dir, '.gtg', 'after-handoff.mjs'), `export default () => { throw new Error('boom'); };\n`);
  r = gtg(dir, HANDOFF_ARGS('hk2', 'Hooked Two'), { input: BODY });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /after-handoff hook failed - boom/);
  assert.ok(active(dir).some((e) => e.slug === 'hk2'), 'handoff survives a failing hook');
  assert.match(execSync('git log -1 --format=%s', { cwd: dir }).toString(), /^handoff: Hooked Two/);
  console.log('ok 61 - after-handoff hook: ctx, handoff-only, failure reported not hidden');
}

{
  // Which harness wrote it: detected from the env, --harness overrides, shown on the list row.
  const dir = tempRepo();
  let r = gtg(dir, HANDOFF_ARGS('c', 'Claude Side'), { input: BODY, env: { CLAUDECODE: '1' } });
  assert.equal(active(dir)[0].harness, 'claude');
  r = gtg(dir, HANDOFF_ARGS('x', 'Codex Side'), { input: BODY, env: { CLAUDECODE: '', CODEX_HOME: 'C:/x' } });
  assert.equal(active(dir).find((e) => e.slug === 'x').harness, 'codex');
  r = gtg(dir, [...HANDOFF_ARGS('o', 'Other'), '--harness', 'hermes'], { input: BODY, env: { CLAUDECODE: '1' } });
  assert.equal(active(dir).find((e) => e.slug === 'o').harness, 'hermes');
  const list = gtg(dir, ['list']).stdout;
  assert.match(list, /Claude Side s1 \[~2h\] \([^)]*\) ·claude/);
  assert.match(list, /Codex Side s1 \[~2h\] \([^)]*\) ·codex/);
  assert.match(list, /Other s1 \[~2h\] \([^)]*\) ·hermes/);
  // An unidentified caller leaves the field off rather than guessing.
  r = gtg(dir, HANDOFF_ARGS('u', 'Unknown'), { input: BODY, env: { CLAUDECODE: '' }, noCodex: true });
  const u = active(dir).find((e) => e.slug === 'u');
  assert.equal('harness' in u && u.harness !== undefined, false);
  assert.doesNotMatch(gtg(dir, ['list']).stdout, /Unknown s1 \[~2h\] \([^)]*\) ·/);
  console.log('ok 62 - harness recorded from env or --harness and shown on the row');
}

// --- 2.0.0: --next from the body, worktree from cwd, git + task sections the CLI appends ---
{
  const dir = tempRepo();
  const body = '## Where We Stopped\npara\n\n## Next Action\nShip the thing.\nsecond line ignored\n';
  let r = gtg(dir, ['handoff', '--project', 'Derived', '--slug', 'derived'], { input: body });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(active(dir)[0].next, 'Ship the thing.');
  r = gtg(dir, ['handoff', '--project', 'NoNext', '--slug', 'nonext'], { input: '## Where We Stopped\nx\n' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing --next \(or a ## Next Action section in the body\)/);
  console.log('ok 63 - --next is read from the body; a body with neither is refused');
}

// --- 63b. a blank line after the heading is still a section ---
// sectionOf's lookahead used to end on a bare `$` under the `m` flag, where `$` matches at every
// line end, so a lazy capture starting at a blank line matched EMPTY. The section then read as
// absent: the handoff below was refused for "missing --next" with its Next Action right there
// (it bit a real departure on 2026-09-02, worked around by passing --next by hand), and a Task
// list the caller wrote itself was read as missing and a second one appended underneath it.
{
  const dir = tempRepo();
  const body = '## Where We Stopped\n\npara\n\n## Next Action\n\nShip the thing.\n\n## Task list\n\n- [x] mine\n';
  const r = gtg(dir, ['handoff', '--project', 'Blank Lines', '--slug', 'blanks'], { input: body });
  assert.equal(r.status, 0, `a well-formed body must not be refused for a blank line: ${r.stderr}`);
  assert.equal(active(dir)[0].next, 'Ship the thing.');
  const doc = readFileSync(join(dir, active(dir)[0].file), 'utf8');
  assert.equal(doc.match(/^## Task list$/gm)?.length, 1,
    'a Task list read as absent gets a second one appended under it');
  console.log('ok 63b - a section with a blank line after its heading is read, not seen as absent');
}

// --- 63c. a slug the store would refuse is refused BEFORE the markdown is written ---
// writeHandoff writes the .md to disk and only then saves the entry, so its no-orphan-file
// guarantee holds only while nothing after that write can still refuse. `--slug _foo` passed the
// CLI's looser [A-Za-z0-9_-]+ and then threw inside writeCollection, whose SLUG_OK demands an
// alphanumeric first character: an untracked .md left in docs/handoffs, no entry anywhere, and
// the body - which came from stdin - simply gone. Same hazard Task 6 closed on the projects side.
{
  const dir = tempRepo();
  const r = gtg(dir, ['handoff', '--project', 'Bad Slug', '--slug', '_foo', '--next', 'x'], { input: BODY });
  assert.equal(r.status, 2, `a leading underscore must be refused, got: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /--slug must start with a letter or digit/);
  assert.equal(existsSync(join(dir, 'docs/handoffs')), false,
    'refused BEFORE any write: nothing may be left on disk for the user to find and clean up');
  assert.deepEqual(active(dir), []);
  console.log('ok 63c - a slug the store would refuse is refused before the handoff file is written');
}

{
  // Run from a worktree: worktree + branch inferred, commits and files since the session
  // start appended. Run from the hub: 'repo root', no git sections (a shared checkout).
  const hub = tempRepo();
  const wt = tempRepo();
  writeFileSync(join(wt, 'a.txt'), 'a\n');
  execSync('git add a.txt && git commit -q -m "feat: first"', { cwd: wt });
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  let r = gtg(wt, [...HANDOFF_ARGS('inf', 'Inferred'), '--wip'], { input: BODY, hub });
  assert.equal(r.status, 0, r.stderr);
  const e = active(hub)[0];
  const norm = (s) => s.toLowerCase().split(String.fromCharCode(92)).join("/");
  assert.equal(norm(e.worktree), norm(wt));
  assert.equal(e.branch, 'main');
  const doc = readFileSync(join(hub, e.file), 'utf8');
  assert.match(doc, /## Commits this session\n- [0-9a-f]+ wip: gtg checkpoint - Inferred\n- [0-9a-f]+ feat: first/);
  assert.match(doc, /## Files touched\n- a\.txt\n- b\.txt/);
  r = gtg(hub, HANDOFF_ARGS('root', 'Root Project'), { input: BODY, hub });
  const e2 = active(hub).find((x) => x.slug === 'root');
  assert.equal(e2.worktree, 'repo root');
  assert.doesNotMatch(readFileSync(join(hub, e2.file), 'utf8'), /## Commits this session/);
  console.log('ok 64 - worktree inferred from cwd; commits + files appended for a worktree only');
}

{
  // Task list read from the harness store; a body that carries its own is left alone.
  const dir = tempRepo();
  const cfg = mkdtempSync(join(tmpdir(), 'gtg-cfg-'));
  mkdirSync(join(cfg, 'tasks', 'sess-1'), { recursive: true });
  writeFileSync(join(cfg, 'tasks', 'sess-1', '2.json'), JSON.stringify({ id: '2', subject: 'Second', status: 'in_progress' }));
  writeFileSync(join(cfg, 'tasks', 'sess-1', '1.json'), JSON.stringify({ id: '1', subject: 'First', status: 'completed' }));
  writeFileSync(join(cfg, 'tasks', 'sess-1', '.lock'), '');
  const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'sess-1' };
  let r = gtg(dir, HANDOFF_ARGS('t', 'Tasked'), { input: BODY, env });
  assert.equal(r.status, 0, r.stderr);
  let doc = readFileSync(join(dir, active(dir)[0].file), 'utf8');
  assert.match(doc, /## Task list\n- \[completed\] First\n- \[in_progress\] Second\n/);
  r = gtg(dir, HANDOFF_ARGS('t2', 'Own List'), { input: BODY + '\n## Task list\n- [pending] mine\n', env });
  doc = readFileSync(join(dir, active(dir).find((x) => x.slug === 't2').file), 'utf8');
  assert.equal((doc.match(/## Task list/g) || []).length, 1);
  assert.match(doc, /- \[pending\] mine/);
  r = gtg(dir, HANDOFF_ARGS('t3', 'No Session'), { input: BODY, env: { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'nope' } });
  assert.doesNotMatch(readFileSync(join(dir, active(dir).find((x) => x.slug === 't3').file), 'utf8'), /## Task list/);
  console.log('ok 65 - task list appended from the harness store, never duplicated, absent when unknown');
}

// --- resume prints the current handoff and always retains it ---
{
  // --keep remains compatible and tells hooks this was a read rather than a pickup.
  const dir = tempRepo();
  gtg(dir, HANDOFF_ARGS('one', 'Only One'), { input: BODY });
  let r = gtg(dir, ['resume', 'one', '--keep']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^RESUME: "Only One" - handoff of \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(docs\/handoffs\/current\/one\.md\)\n# Handoff: Only One\n/);
  assert.match(r.stdout, /## Next Action\ndo the next thing/);
  assert.match(r.stdout, /Kept: Only One \(current handoff retained\)/);
  assert.equal(active(dir).length, 1, '--keep must retain');
  // Bare resume with exactly one active project picks it without a name.
  r = gtg(dir, ['resume']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESUME: "Only One"/);
  assert.match(r.stdout, /Kept: Only One \(current handoff retained\)$/m);
  assert.equal(active(dir).length, 1);
  assert.match(execSync('git log -1 --format=%s', { cwd: dir }).toString(), /^handoff: Only One - session 1/);
  r = gtg(dir, ['resume']);
  assert.equal(r.status, 0, 'the retained handoff remains resumable');
  assert.match(r.stdout, /RESUME: "Only One"/);
  console.log('ok 66 - resume prints and retains; --keep remains compatible');
}

{
  // Several candidates are a question (exit 1 + list), never a guess: bare with 2+, a name
  // fragment fitting 2+, or a project sharing its token with a command.
  const dir = tempRepo();
  gtg(dir, HANDOFF_ARGS('alpha-one', 'Alpha One'), { input: BODY });
  gtg(dir, HANDOFF_ARGS('alpha-two', 'Alpha Two'), { input: BODY });
  let r = gtg(dir, ['resume']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Alpha One[\s\S]*Alpha Two[\s\S]*Which\? gtg <project>/);
  r = gtg(dir, ['resume', 'alpha']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /'alpha' matches 2 active projects:\n  1\. Alpha One \(alpha-one\)/);
  assert.equal(active(dir).length, 2, 'ambiguity must not consume');
  r = gtg(dir, ['resume', 'alpha-two']);
  assert.equal(r.status, 0, 'an exact slug is never ambiguous');
  gtg(dir, HANDOFF_ARGS('learn', 'Learn Triage'), { input: BODY });
  r = gtg(dir, ['resume', 'learn']);
  assert.equal(r.status, 1, 'project + bundled command of the same name must ask');
  assert.match(r.stdout, /'learn' is both a project and a command:\n  1\. Learn Triage \(learn\)[\s\S]*2\. run the `learn` command/);
  r = gtg(dir, ['resume', 'stats']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /'stats' is a command - run gtg stats/);
  console.log('ok 67 - resume asks on ambiguity and on a project/command collision');
}

{
  // after-resume.mjs receives retained-state and pickup-intent separately; a throwing hook is
  // reported without clearing the current handoff.
  const dir = tempRepo();
  mkdirSync(join(dir, '.gtg'), { recursive: true });
  writeFileSync(join(dir, '.gtg', 'after-resume.mjs'),
    `import { writeFileSync } from 'node:fs';
export default async (ctx) => { writeFileSync(ctx.root + '/resumed.json', JSON.stringify({ keys: Object.keys(ctx).sort(), slug: ctx.entry.slug, kept: ctx.kept, resumed: ctx.resumed, hasBody: ctx.body.includes('## Next Action') })); console.log('resume hook ran'); };\n`);
  gtg(dir, HANDOFF_ARGS('hk', 'Hooked'), { input: BODY });
  let r = gtg(dir, ['resume', 'hk']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Kept: Hooked \(current handoff retained\)\nresume hook ran/);
  const ran = JSON.parse(readFileSync(join(dir, 'resumed.json'), 'utf8'));
  assert.deepEqual(ran.keys, ['body', 'commit', 'entry', 'file', 'kept', 'readStore', 'resumed', 'root', 'writeStore']);
  assert.deepEqual([ran.slug, ran.kept, ran.resumed, ran.hasBody], ['hk', true, true, true]);
  r = gtg(dir, ['resume', 'hk', '--keep']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'resumed.json'), 'utf8')).resumed, false,
    '--keep must retain its non-pickup signal for hooks');
  writeFileSync(join(dir, '.gtg', 'after-resume.mjs'), `export default () => { throw new Error('kaboom'); };\n`);
  gtg(dir, HANDOFF_ARGS('hk2', 'Hooked Two'), { input: BODY });
  r = gtg(dir, ['resume', 'hk2']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /after-resume hook failed - kaboom/);
  assert.equal(active(dir).length, 2, 'a failing hook must not clear either current handoff');
  console.log('ok 68 - after-resume hook: retained state, pickup intent, failure reported');
}

// --- 69. unrelated project edits on two machines produce disjoint file sets ---
// The whole reason the store was sharded. store.test.mjs already pins this at the
// writeCollection level; what it cannot see is whether a real handoff through the CLI still
// rewrites only its own record. If it names a second project's file, two machines editing
// unrelated projects still collide on bytes neither of them meant to touch, and a JSON array
// conflict has no semantic merge.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('beta', 'Beta'), { input: BODY });

  const server = gtg(repo, [...HANDOFF_ARGS('alpha', 'Alpha'), '--next', 'from server'], { input: BODY });
  assert.equal(server.status, 0, server.stderr);
  const aFiles = nameStatus(repo, 'HEAD');
  const laptop = gtg(repo, [...HANDOFF_ARGS('beta', 'Beta'), '--next', 'from laptop'], { input: BODY });
  assert.equal(laptop.status, 0, laptop.stderr);
  const bFiles = nameStatus(repo, 'HEAD');

  const records = (lines) => lines.map((l) => l.split('\t')[1])
    .filter((f) => f.startsWith(`${ACTIVE}/`)).sort();
  assert.deepEqual(records(aFiles), [`${ACTIVE}/alpha.json`],
    `Alpha's handoff must rewrite Alpha's record and no other, got: ${aFiles.join(' | ')}`);
  assert.deepEqual(records(bFiles), [`${ACTIVE}/beta.json`],
    `Beta's handoff must rewrite Beta's record and no other, got: ${bFiles.join(' | ')}`);
  assert.equal(records(aFiles).some((f) => records(bFiles).includes(f)), false,
    'the two projects still share a record file, so the two machines still conflict');
  console.log('ok 69 - unrelated project edits touch disjoint record files');
}

// --- 70. a park commits both the created and the deleted record file by name ---
// commit() names its paths on `git add` AND `git commit`. A move between the two stores is
// now a delete plus a create in different directories, and the delete is the half that goes
// missing: unnamed, it stays in the working tree for whichever session commits next, which is
// exactly the ownerless-staged-file class the pathspec rule exists to stop.
{
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('alpha', 'Alpha'), { input: BODY });
  const r = gtg(repo, ['back', 'alpha', '--no-list']);
  assert.equal(r.status, 0, r.stderr);

  const files = nameStatus(repo, 'HEAD');
  assert.ok(files.includes(`D\t${ACTIVE}/alpha.json`),
    `the deletion must be in the commit, got: ${files.join(' | ')}`);
  assert.ok(files.includes(`A\t${BACKLOG}/alpha.json`),
    `the creation must be in the commit, got: ${files.join(' | ')}`);
  const st = execSync('git status --porcelain', { cwd: repo, encoding: 'utf8' });
  assert.equal(st.trim(), '',
    `nothing may be left staged or dirty for another session to commit:\n${st}`);
  console.log('ok 70 - a park commits both the created and the deleted record file');
}

// --- 82. a hub that is not a checkout's top never borrows the caller's git history ---
// An agent hub (ATOM's /state/atom, or ~/.atom inside home) sits inside some other checkout or
// none. Before 4.8.0 any repo a command ran in counted as the project's worktree, so the handoff
// carried that repo's commits and files. Case 64 holds the other half: a hub that IS a checkout's
// top still records the caller's worktree and its commits.
// The hub folder is tracked, not ignored as ~/.atom is in home: ATOM's hubs hold the forge store,
// which commits nothing locally, and a file store in an ignored folder fails its own `git add`.
{
  const outer = tempRepo(); // like home, holding a hub folder below its top
  const hub = join(outer, 'hub');
  mkdirSync(hub);
  writeFileSync(join(outer, 'README'), 'outer\n');
  execSync('git add README && git commit -qm base', { cwd: outer });
  const work = tempRepo(); // a checkout the command happens to run in
  writeFileSync(join(work, 'f.txt'), 'x');
  execSync('git add f.txt && git commit -qm "work commit"', { cwd: work });
  const body = 'Kind: errand\nGoal: g\n\n## Next Action\nnothing\n';
  const r = gtg(work, ['handoff', '--project', 'P', '--slug', 'p', '--exact', '--checkpoint'], { hub, input: body });
  assert.equal(r.status, 0, r.stderr);
  const shown = gtg(work, ['show', 'p'], { hub }).stdout;
  assert.match(shown, /Worktree: repo root/);
  assert.doesNotMatch(shown, /## Commits this session|## Files touched|work commit/);
  console.log('ok 82 - a hub that is not a checkout top never borrows the caller\'s git history');
}

// Every file under docs/handoffs with its bytes, and git's view of the tree, so a read command that
// wrote anything (a REVIEW stamp committed or left uncommitted) fails the comparison.
const handoffTree = (root) => ({
  files: readdirSync(join(root, 'docs/handoffs'), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name)).sort()
    .map((f) => [f, readFileSync(f, 'utf8')]),
  status: execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }),
  log: execSync('git log --oneline', { cwd: root, encoding: 'utf8' }),
});
// An active entry untouched long enough that any REVIEW-taking command would ask about it and
// stamp `nudged` on its record. Committed, so the tree starts clean.
const addStaleEntry = (root, slug) => {
  gtg(root, ['handoff', '--project', slug.toUpperCase(), '--slug', slug, '--exact', '--checkpoint'],
    { hub: root, input: `Goal: ${slug}\n\n## Next Action\ndo ${slug}\n` });
  patchActive(root, (items) => { items.find((x) => x.slug === slug).updated = new Date(Date.now() - 10 * 864e5).toISOString(); });
  execSync('git add -A && git commit -qm backdate', { cwd: root });
};

// --- 83. list --json prints both shelves with their handoffs, and nothing else ---
// Code reads the register through this (Rodney's ATOM), so stdout is one JSON object: no list,
// no REVIEW question, no stale notice, and no write.
{
  const hub = tempRepo();
  for (const s of ['a', 'b']) {
    gtg(hub, ['handoff', '--project', s.toUpperCase(), '--slug', s, '--exact', '--checkpoint'],
      { hub, input: `Goal: ${s}\n\n## Next Action\ndo ${s}\n` });
  }
  gtg(hub, ['back', 'b', '--wake', '2099-01-01', '--no-list'], { hub });
  addStaleEntry(hub, 'old');
  const before = handoffTree(hub);
  const r = gtg(hub, ['list', '--json'], { hub });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(handoffTree(hub), before, 'list --json writes nothing, not even a REVIEW stamp');
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.active.map((x) => x.slug), ['a', 'old']);
  assert.equal(doc.backlog[0].slug, 'b');
  assert.equal(doc.backlog[0].wake, '2099-01-01');
  assert.equal(doc.active[0].shelf, 'active');
  assert.equal(doc.backlog[0].shelf, 'backlog');
  assert.match(doc.active[0].handoff, /Goal: a/);
  assert.match(doc.backlog[0].handoff, /Goal: b/);
  assert.doesNotMatch(r.stdout + r.stderr, /REVIEW:/);
  // The stale entry is really eligible: a plain list asks about it.
  assert.match(gtg(hub, ['list'], { hub }).stdout, /REVIEW: OLD \[old\]/);
  console.log('ok 83 - list --json prints both shelves with their handoffs');
}

// --- 84. show prints one handoff, --json the record, and refuses an unknown slug ---
{
  const hub = tempRepo();
  gtg(hub, ['handoff', '--project', 'A', '--slug', 'a', '--exact', '--checkpoint'],
    { hub, input: 'Goal: a\n\n## Next Action\ndo a\n' });
  addStaleEntry(hub, 'old');
  const before = handoffTree(hub);
  assert.match(gtg(hub, ['show', 'a'], { hub }).stdout, /# Handoff: A[\s\S]*Goal: a/);
  const rec = JSON.parse(gtg(hub, ['show', 'a', '--json'], { hub }).stdout);
  assert.equal(rec.slug, 'a');
  assert.equal(rec.shelf, 'active');
  assert.match(rec.handoff, /Goal: a/);
  const miss = gtg(hub, ['show', 'zz'], { hub });
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /gtg show: no entry 'zz'/);
  assert.deepEqual(handoffTree(hub), before, 'show writes nothing, not even a REVIEW stamp');
  assert.match(gtg(hub, ['list'], { hub }).stdout, /REVIEW: OLD \[old\]/, 'the stale entry is really eligible');
  console.log('ok 84 - show prints one handoff, --json the record, and refuses an unknown slug');
}

console.log('ALL PASS (part 5)');
