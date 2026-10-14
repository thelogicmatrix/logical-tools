import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the report separates attributable calls from legacy and external spend', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls.jsonl');
  const legacy = join(dir, 'legacy.jsonl');
  // Today, so the log stays a partial first day whenever the test runs.
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(calls, [
    { t: `${day}T06:00:00Z`, tool: 'runbooks', activity: 'active_route', session: 's1', cost: 0.0002 },
    { t: `${day}T06:01:00Z`, tool: 'runbooks', activity: 'purpose_test', session: 's1', target: 'a.md', cost: 0.0001 },
    { t: `${day}T06:02:00Z`, tool: 'jevmail', activity: 'tool', session: null, cost: null },
  ].map(JSON.stringify).join('\n') + '\n');
  writeFileSync(legacy, '{"t":"2026-09-28T00:00","c":0.003}\n');
  const stdout = execFileSync(process.execPath, [join(import.meta.dirname, 'spend-report.mjs'), '--json'],
    { encoding: 'utf8', env: { ...process.env, JEV_SPEND_LOG: calls, JEV_LEGACY_SPEND_LOG: legacy } });
  const report = JSON.parse(stdout);
  assert.equal(report.reported_cost, 0.0003);
  assert.equal(report.unreported_calls, 1);
  assert.equal(report.by_activity.find((row) => row.name === 'purpose_test').reported_cost, 0.0001);
  assert.equal(report.by_session.find((row) => row.name === 's1').calls, 2);
  assert.deepEqual(report.legacy_unclassified, { calls: 1, reported_cost: 0.003 });
  assert.deepEqual(report.external_unallocated, ['Hindsight reranker']);
  assert.equal(report.projected_30d, null, 'a partial first day cannot support a monthly run rate');
});

test('monthly run rate uses seven complete days even when the view has a since filter', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-projection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls.jsonl');
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const beforeWindow = new Date(end.getTime() - 8 * 86_400_000).toISOString();
  const yesterday = new Date(end.getTime() - 86_400_000).toISOString();
  writeFileSync(calls, [
    { t: beforeWindow, tool: 'runbooks', activity: 'active_route', cost: 0.01 },
    { t: yesterday, tool: 'runbooks', activity: 'active_route', cost: 0.02 },
  ].map(JSON.stringify).join('\n') + '\n');
  const afterYesterday = end.toISOString().slice(0, 10);
  const stdout = execFileSync(process.execPath,
    [join(import.meta.dirname, 'spend-report.mjs'), '--json', '--since', afterYesterday],
    { encoding: 'utf8', env: { ...process.env, JEV_SPEND_LOG: calls,
      JEV_LEGACY_SPEND_LOG: join(dir, 'missing') } });
  const report = JSON.parse(stdout);
  assert.equal(report.calls, 0, 'the view filter applies to displayed groups');
  assert.equal(report.projected_30d, Number((0.02 * 30 / 7).toFixed(6)),
    'the projection still uses the complete seven-day window');
});
