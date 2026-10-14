// gtg refresh and gtg migrate <device> (lib/move.mjs and the move builtin in gtg.mjs): one call
// writes the handoff and opens the thread through the hub's .gtg/t3-launch.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { gtg, tempRepo, active, BODY } from './gtg-harness.mjs';

const here = hostname().toLowerCase();
// Records each call in launched.json and returns the done line, as a hub launcher does.
const RECORDING = `import { writeFileSync } from 'node:fs';
export default (c) => {
  writeFileSync(new URL('../launched.json', import.meta.url), JSON.stringify(c));
  return \`\${c.done} \${c.name} to \${c.target}: thread t-1\`;
};
`;

function hub({ servers = { laptop: { home: 'C:/Users/me' } }, launcher = RECORDING } = {}) {
  const repo = tempRepo();
  mkdirSync(join(repo, '.gtg'), { recursive: true });
  writeFileSync(join(repo, '.gtg', 't3-servers.json'), JSON.stringify(servers));
  if (launcher) writeFileSync(join(repo, '.gtg', 't3-launch.mjs'), launcher);
  return repo;
}
const launched = (repo) => JSON.parse(readFileSync(join(repo, 'launched.json'), 'utf8'));
const lastLine = (s) => s.trim().split('\n').at(-1);
// No T3 markers from the session running the tests, so a result never depends on where it ran.
const NO_T3 = { T3CODE_CLI_PATH: '', T3_ACP_MCP_NODE: '', GTG_T3: '' };
const IN_T3 = { env: { ...NO_T3, T3CODE_CLI_PATH: 'C:/t3.cmd' } };
const HANDOFF = (slug, project) => ['--project', project, '--slug', slug, '--eta', '~1h'];

test('refresh writes the handoff, then opens the thread here, printing REFRESHED in place of RESUME', () => {
  const repo = hub();
  const r = gtg(repo, ['refresh', ...HANDOFF('alpha', 'Alpha')], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('RESUME:'), r.stdout);
  assert.equal(lastLine(r.stdout), `REFRESHED Alpha to ${here}: thread t-1`);
  assert.deepEqual(active(repo).map((e) => e.slug), ['alpha']);
  assert.deepEqual(launched(repo), { root: launched(repo).root, target: here, slug: 'alpha', name: 'Alpha', verb: 'refresh', done: 'REFRESHED' });
});

test('migrate opens the thread on the device, and launches under the slug the handoff reused', () => {
  const repo = hub();
  assert.equal(gtg(repo, ['handoff', ...HANDOFF('alpha', 'Alpha')], { input: BODY }).status, 0);
  const r = gtg(repo, ['migrate', 'Laptop', ...HANDOFF('other', 'Alpha')], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lastLine(r.stdout), 'MIGRATED Alpha to laptop: thread t-1');
  assert.equal(launched(repo).slug, 'alpha');
  assert.equal(launched(repo).verb, 'migrate laptop');
});

test('an unknown device is refused before anything is written', () => {
  const repo = hub();
  const r = gtg(repo, ['migrate', 'nowhere', ...HANDOFF('alpha', 'Alpha')], { input: BODY });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no device named nowhere/);
  assert.deepEqual(active(repo), []);
  assert.match(gtg(repo, ['migrate']).stderr, /usage: gtg migrate <device>/);
  assert.match(gtg(repo, ['refresh', 'laptop', '--slug', 's']).stderr, /for another device, gtg migrate <device>/);
});

test('a launcher failure keeps the handoff and says how to resume it', () => {
  const repo = hub({ launcher: "export default () => { throw new Error('ssh: connect to host laptop timed out'); };\n" });
  const r = gtg(repo, ['migrate', 'laptop', ...HANDOFF('alpha', 'Alpha')], { input: BODY });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the handoff is saved, but the thread did not open - ssh: connect to host laptop timed out/);
  assert.match(r.stderr, /resume it on laptop with "gtg alpha"/);
  assert.deepEqual(active(repo).map((e) => e.slug), ['alpha']);
});

test('--slug alone opens the thread for a handoff already written', () => {
  const repo = hub();
  const r = gtg(repo, ['refresh', '--slug', 'beta', '--name', 'Beta']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `REFRESHED Beta to ${here}: thread t-1`);
  assert.deepEqual(active(repo), []);
});

test('without a launcher the line names the T3 MCP calls instead', () => {
  const repo = hub({ launcher: null });
  const r = gtg(repo, ['refresh', '--slug', 's', '--name', 'A B'], IN_T3);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith('GTG-LAUNCH: call mcp__t3-code__t3_thread_launch with {"title":"A B","message":"gtg s","workspaceStrategy":{"type":"root"}}.'));
  assert.ok(r.stdout.includes(`REFRESHED A B to ${here}: [A B](t3-thread://v1/<threadId>)`));

  const m = gtg(repo, ['migrate', 'laptop', '--slug', 's'], IN_T3).stdout;
  assert.ok(m.startsWith('GTG-LAUNCH: call mcp__t3-laptop__t3_project_list and keep the id of the project whose workspaceRoot is C:/Users/me'));
  assert.ok(m.includes('mcp__t3-laptop__t3_thread_launch with {"projectId":"<the home project id>","title":"s","message":"gtg s","runtimeMode":"full-access","modelSelection":'));
});

test('a launcher that returns no done line is a failure, not a silent success', () => {
  const repo = hub({ launcher: "export default () => 'opened something';\n" });
  const r = gtg(repo, ['refresh', '--slug', 's']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /returned no REFRESHED line: opened something/);
});

test('outside T3 with no launcher both verbs refuse before writing, and GTG_T3=1 overrides', () => {
  const repo = hub({ launcher: null });
  for (const args of [['refresh'], ['migrate', 'laptop']]) {
    const r = gtg(repo, [...args, ...HANDOFF('alpha', 'Alpha')], { input: BODY, env: NO_T3 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(`gtg ${args[0]} needs T3 Code: .*Nothing was written\. Depart with plain gtg instead`));
  }
  assert.deepEqual(active(repo), []);
  const forced = gtg(repo, ['refresh', '--slug', 's'], { env: { ...NO_T3, GTG_T3: '1' } });
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(forced.stdout.startsWith('GTG-LAUNCH:'));
  // A hub launcher reaches T3 from anywhere, so it needs no marker.
  assert.equal(gtg(hub(), ['refresh', '--slug', 's'], { env: NO_T3 }).status, 0);
});
