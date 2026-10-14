// A failed duration read must not masquerade as successfully read untimed work (#100).
// Keep git and the store real; inject only the selected git failure at the process boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempRepo } from './gtg-harness.mjs';
import { buildReport, readDurations } from '../skills/gtg/extensions/lib/history.mjs';
import stats from '../skills/gtg/extensions/commands/stats.mjs';
import report from '../skills/gtg/extensions/commands/report.mjs';

function fixture(timed = true) {
  const root = tempRepo();
  mkdirSync(join(root, 'docs/handoffs/active'), { recursive: true });
  writeFileSync(join(root, 'docs/handoffs/active/alpha.json'), JSON.stringify({
    slug: 'alpha', project: 'Alpha', sessions: 1, ...(timed ? { duration_min: 120 } : {}),
  }, null, 2) + '\n');
  cp.execFileSync('git', ['-C', root, 'add', '--', 'docs/handoffs/active/alpha.json']);
  cp.execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'handoff: Alpha - session 1', '--', 'docs/handoffs/active/alpha.json']);
  return root;
}

function capture(fn) {
  const lines = [];
  const previous = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = previous; }
  return lines.join('\n');
}

for (const failure of ['events', 'durations', 'both']) {
  test(`${failure} git failure identifies unavailable data in JSON, stats and report`, (t) => {
    const root = fixture();
    const original = cp.execFileSync;
    t.mock.method(cp, 'execFileSync', (file, args, opts) => {
      if (file === 'git' && args.includes('log')) {
        const duration = args.includes('-p');
        if (failure === 'both' || (duration ? failure === 'durations' : failure === 'events')) {
          throw Object.assign(new Error('injected history overflow'), { code: 'ENOBUFS' });
        }
      }
      return original(file, args, opts);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

    const doc = buildReport(root);
    assert.equal(doc.historyAvailable, failure === 'durations');
    assert.equal(doc.effort.available, failure === 'events');
    assert.equal(doc.counts.active, 1, 'current store remains readable');
    if (failure === 'events') assert.equal(doc.effort.total, 120);

    const text = capture(() => stats({ root }));
    assert.equal(text.includes('history unavailable:'), failure !== 'durations');
    assert.equal(text.includes('effort unavailable:'), failure !== 'events');
    if (failure !== 'events') assert.doesNotMatch(text, /\b0h timed|\b0 sessions timed/);

    const summary = capture(() => report({ root, args: [] }));
    const saved = JSON.parse(readFileSync(join(root, 'docs/handoffs/_report.json'), 'utf8'));
    assert.equal(saved.effort.available, failure === 'events');
    assert.equal(summary.includes('effort unavailable'), failure !== 'events');
    assert.equal(summary.includes('no git history'), failure !== 'durations');
    if (failure !== 'events') assert.doesNotMatch(summary, /\b0 sessions timed/);
  });
}

test('successful timed and untimed history retain their counters and output', () => {
  for (const timed of [true, false]) {
    const root = fixture(timed);
    const doc = buildReport(root);
    assert.equal(doc.historyAvailable, true);
    assert.equal(readDurations(root).available, true);
    assert.equal(doc.effort.available, true);
    assert.equal(doc.effort.total, timed ? 120 : 0);
    assert.equal(doc.effort.sessionsTimed, timed ? 1 : 0);
    const text = capture(() => stats({ root }));
    assert.doesNotMatch(text, /unavailable|partial/);
    if (timed) assert.match(text, /2h timed across 1 sessions/);
    const summary = capture(() => report({ root, args: [] }));
    assert.match(summary, new RegExp(`gtg report: 1 active .* 0 shipped .* ${timed ? 1 : 0} sessions timed .* history ok$`));
  }
});
