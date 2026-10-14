import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempRepo, gtg, HANDOFF_ARGS, BODY, active } from './gtg-harness.mjs';

test('GTG family lookup uses the separate configured portfolio', t => {
  const hub = tempRepo(), portfolio = tempRepo();
  t.after(() => { rmSync(hub, { recursive: true, force: true }); rmSync(portfolio, { recursive: true, force: true }); });
  mkdirSync(join(portfolio, 'docs/projects'), { recursive: true });
  writeFileSync(join(portfolio, 'docs/projects/INDEX.md'), '| [Widget](widget.md) | active |\n');
  const result = gtg(hub, HANDOFF_ARGS('widget-stats', 'Widget Stats'), { input: BODY, env: { PROJECTS_ROOT: portfolio } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(active(hub)[0].parent, 'widget');
});
