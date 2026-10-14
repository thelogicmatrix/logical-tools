// lib/view.mjs in-process: the list, the numbering and the review line, with no CLI spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { displayOrder, renderList, resolveEntry, reviewCandidate, takeReview } from '../skills/gtg/lib/view.mjs';

const DAY = 864e5;
const at = (days) => new Date(Date.now() - days * DAY).toISOString();
const entry = (o) => ({ eta: '1h', sessions: 1, worktree: 'repo root', branch: 'master', next: `next for ${o.slug}`, updated: at(0), ...o });
const ctxFor = (active, backlog = [], extra = {}) => ({
  root: '/hub', entries: (w) => structuredClone(w === 'active' ? active : backlog), countHandoffFiles: () => 7, ...extra,
});
// console.log captured for one call, restored even when the call throws.
function capture(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { fn(); } finally { console.log = real; }
  return lines.join('\n');
}

test('renderList groups families first, numbers down the screen and points at the backlog', () => {
  const active = [
    entry({ project: 'Solo', slug: 'solo', harness: 'codex', sessions: 3 }),
    entry({ project: 'Wiki', slug: 'wiki', parent: 'citsim', updated: at(2) }),
    entry({ project: 'Engine', slug: 'engine', parent: 'citsim', sessions: undefined }),
    entry({ project: 'Pack', slug: 'pack', parent: 'learning' }),
  ];
  const out = capture(() => renderList([], ctxFor(active, [entry({ project: 'Idea', slug: 'idea' })])));
  assert.equal(out, [
    '3 active gtg projects in 2 group(s):',
    '', '▸ citsim',
    '  1. Engine s7 [1h] (0h ago) master', '     → next for engine',
    '  2. Wiki s1 [1h] (2d ago) master', '     → next for wiki',
    '', '▸ standalone',
    '  3. Solo s3 [1h] (0h ago) ·codex master', '     → next for solo',
    '', '+ 1 backlogged - gtg backlog',
  ].join('\n'), 'the extension entry (learning) is hidden, and a missing sessions count asks countHandoffFiles');
});

test('renderList marks dirty and unreachable worktrees and warns on a shared branch', () => {
  const wt = mkdtempSync(join(tmpdir(), 'gtg-view-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: wt });
    writeFileSync(join(wt, 'x.txt'), 'x');
    const active = [
      entry({ project: 'A', slug: 'a', worktree: wt, branch: 'fix/x' }),
      entry({ project: 'B', slug: 'b', worktree: wt, branch: 'fix/x' }),
      entry({ project: 'C', slug: 'c', worktree: join(wt, 'gone'), branch: 'fix/y' }),
    ];
    // The dirty flag is TTY-only (#96), and node --test pipes stdout.
    const wasTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    let out;
    try { out = capture(() => renderList([], ctxFor(active))); } finally { process.stdout.isTTY = wasTTY; }
    assert.match(out, /1\. A s1 \[1h\] \(0h ago\) fix\/x ● 1 uncommitted/);
    assert.match(out, /3\. C s1 \[1h\] \(0h ago\) fix\/y ● \? uncommitted/, 'a missing worktree is ?, not clean');
    assert.match(out, /⚠ 2 projects share fix\/x @ .* - A, B/);
    const piped = capture(() => renderList([], ctxFor(active)));
    assert.doesNotMatch(piped, /uncommitted/, 'piped: no dirty flag, not even the ? of an unchecked dir');
    assert.match(piped, /⚠ 2 projects share fix\/x @ .* - A, B/, 'the shared-branch warning stays');
  } finally { rmSync(wt, { recursive: true, force: true }); }
});

test('a filtered renderList searches every entry and names a shelved extension entry', () => {
  const active = [entry({ project: 'Router', slug: 'router' }), entry({ project: 'Pack', slug: 'pack', parent: 'learning' })];
  const backlog = [entry({ project: 'Shelved pack', slug: 'shelf', parent: 'learning', updated: at(3) })];
  const out = capture(() => renderList(['pack'], ctxFor(active, backlog)));
  assert.match(out, /^1 active gtg project in 1 group\(s\) matching 'pack':\n\n▸ learning\n/, 'under its family heading');
  assert.match(out, /  pack: Pack s1/, 'an extension entry is labelled by slug, never a number');
  assert.match(out, /shelved: Shelved pack \(parked 3d ago\) - gtg active shelf/);
  const none = capture(() => renderList(['zzz'], ctxFor(active, backlog)));
  assert.equal(none, "No active gtg projects matching 'zzz'.", 'the shelved extension entry is not counted as backlog');
});

test('displayOrder and resolveEntry agree on what a number means', () => {
  const active = [entry({ project: 'Zed', slug: 'z' }), entry({ project: 'Beta', slug: 'b', parent: 'fam' }),
    entry({ project: 'Alpha', slug: 'a', parent: 'fam' }), entry({ project: 'Hidden', slug: 'h', parent: 'learning' })];
  assert.deepEqual(displayOrder(active).map((e) => e.slug), ['a', 'b', 'z']);
  assert.equal(resolveEntry(active, '3', displayOrder).slug, 'z');
  assert.equal(resolveEntry(active, 'h').slug, 'h', 'an extension entry stays reachable by slug');
  assert.equal(resolveEntry(active, 'bet').slug, 'b');
  assert.equal(resolveEntry(active, '9'), null);
});

test('reviewCandidate asks about a woken shelf first, then stale active, then stale backlog', () => {
  // Every date from this one `now`. Taken separately, a date made a millisecond after `now` is
  // 30.99 days old and floors to 30.
  const now = Date.now();
  const at = (days) => new Date(now - days * DAY).toISOString();
  const stale = entry({ project: 'Stale', slug: 'stale', updated: at(6) });
  const woken = entry({ project: 'Woken', slug: 'woken', updated: at(20), wake: at(1).slice(0, 10) });
  const later = entry({ project: 'Later', slug: 'later', updated: at(40), wake: at(-5).slice(0, 10) });
  const dusty = entry({ project: 'Dusty', slug: 'dusty', updated: at(31) });
  assert.match(reviewCandidate({ entries: ctxFor([stale], [woken, dusty]).entries }, now), /^REVIEW: Woken \[woken\] was parked until /);
  assert.match(reviewCandidate({ entries: ctxFor([stale], [later, dusty]).entries }, now), /^REVIEW: Stale \[stale\] untouched 6d\./);
  assert.match(reviewCandidate({ entries: ctxFor([], [later, dusty]).entries }, now), /^REVIEW: Dusty \[dusty\] parked 31d\./);
  assert.equal(reviewCandidate({ entries: ctxFor([], [later]).entries }, now), null, 'a future wake date stays out');
  assert.equal(reviewCandidate({ entries: ctxFor([stale]).entries, skip: 'stale' }, now), null, 'never the entry being worked on');
  const reviewed = { ...stale, reviewed: at(1) };
  assert.equal(reviewCandidate({ entries: ctxFor([reviewed]).entries }, now), null, '`keep` restarts the clock');
  assert.equal(reviewCandidate({ entries: ctxFor([{ ...stale, resumedAt: at(1) }]).entries }, now), null, 'a resume restarts it too');
  assert.equal(reviewCandidate({ entries: ctxFor([], [{ ...dusty, updated: at(29) }]).entries }, now), null, 'backlog waits 30 days');
  assert.equal(reviewCandidate({ entries: ctxFor([{ ...stale, nudged: at(29) }]).entries }, now), null, 'asked 29 days ago');
  assert.match(reviewCandidate({ entries: ctxFor([{ ...stale, nudged: at(30) }]).entries }, now), /^REVIEW: Stale/, 'asked 30 days ago');
});

test('takeReview stamps the question, stays quiet on a filtered list and a checkpoint, and never fails its command', () => {
  const stamped = [];
  const ctx = { ...ctxFor([entry({ project: 'Stale', slug: 'stale', updated: at(6) })]), stampNudged: (which, slug) => stamped.push(`${which}/${slug}`) };
  assert.match(takeReview('list', [], ctx), /^REVIEW: Stale/);
  assert.deepEqual(stamped, ['active/stale']);
  assert.equal(takeReview('list', ['stale'], ctx), null);
  assert.equal(takeReview('handoff', ['--checkpoint'], ctx), null);
  const errs = [];
  const real = console.error;
  console.error = (m) => errs.push(m);
  try {
    assert.equal(takeReview('list', [], { entries: () => { throw new Error('store gone'); } }), null);
  } finally { console.error = real; }
  assert.deepEqual(errs, ['gtg: review skipped - store gone']);
});
