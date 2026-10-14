// gtg changes for Logic, the personal planner behind the Sales Ops Board: --due, upnext.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempRepo, gtg, HANDOFF_ARGS, BODY, active, backlog } from './gtg-harness.mjs';

const rec = (repo, slug) => active(repo).find((e) => e.slug === slug);

test('--due is stored, listed, and kept while the Next Action stays the same', () => {
  const repo = tempRepo();
  let r = gtg(repo, [...HANDOFF_ARGS('due-a', 'Due A'), '--due', '2026-10-14T18:00'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rec(repo, 'due-a').due, '2026-10-14T18:00');
  r = gtg(repo, ['list']);
  assert.match(r.stdout, /due 14 Oct 18:00/);
  r = gtg(repo, HANDOFF_ARGS('due-a', 'Due A'), { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rec(repo, 'due-a').due, '2026-10-14T18:00');
});

test('a new Next Action without --due drops the old date', () => {
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('due-b', 'Due B'), '--due', '2026-10-14'], { input: BODY });
  const r = gtg(repo, ['handoff', '--project', 'Due B', '--slug', 'due-b', '--next', 'a different step'],
    { input: BODY.replace('do the next thing', 'a different step') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rec(repo, 'due-b').due, undefined);
});

test('--due must be a real date, optionally with a time', () => {
  const repo = tempRepo();
  for (const bad of ['14 Oct', '2026-10-14 18:00', '2026-13-01', '2026-02-30', '2026-10-14T25:00', 'tomorrow']) {
    const r = gtg(repo, [...HANDOFF_ARGS('due-c', 'Due C'), '--due', bad], { input: BODY });
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /--due takes YYYY-MM-DD or YYYY-MM-DDTHH:MM/);
  }
  assert.equal(rec(repo, 'due-c'), undefined);
});

test('date-only due dates survive shelving and appear on the backlog', () => {
  const repo = tempRepo();
  let r = gtg(repo, [...HANDOFF_ARGS('due-shelf', 'Due Shelf'), '--due', '2026-10-14'], { input: BODY });
  assert.equal(r.status, 0, r.stderr);
  r = gtg(repo, ['back', 'due-shelf']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(backlog(repo).find((e) => e.slug === 'due-shelf').due, '2026-10-14');
  r = gtg(repo, ['backlog']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /due 14 Oct/);
  assert.doesNotMatch(r.stdout, /due 14 Oct \d{2}:/);
});

test('an explicit due date replaces the old date, accepting leap days and time boundaries', () => {
  const repo = tempRepo();
  for (const due of ['2028-02-29T00:00', '2028-02-29T23:59', '2028-02-29']) {
    const r = gtg(repo, [...HANDOFF_ARGS('due-replace', 'Due Replace'), '--due', due], { input: BODY });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rec(repo, 'due-replace').due, due);
  }
});

test('--due rejects a missing value, invalid minutes and non-leap days', () => {
  const repo = tempRepo();
  for (const args of [['--due'], ['--due', ''], ['--due', '2026-10-14T18:60'], ['--due', '2027-02-29']]) {
    const r = gtg(repo, [...HANDOFF_ARGS('due-invalid', 'Due Invalid'), ...args], { input: BODY });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /--due takes YYYY-MM-DD or YYYY-MM-DDTHH:MM/);
  }
  assert.equal(rec(repo, 'due-invalid'), undefined);
});

test('upnext adds to the handoff without touching updated or sessions', () => {
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('up-a', 'Up A'), '--due', '2026-10-14'], { input: BODY });
  const before = rec(repo, 'up-a');
  const r = gtg(repo, ['upnext', 'up-a', '--text', 'Then the docs']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Up next for Up A: Then the docs/);
  const after = rec(repo, 'up-a');
  assert.equal(after.updated, before.updated);
  assert.equal(after.sessions, before.sessions);
  assert.deepEqual(after, before, 'all project metadata, including Next Action and due, stays');
  assert.match(readFileSync(join(repo, after.file), 'utf8'), /## Up next\n- Then the docs/);
});

test('upnext refuses a missing slug, text or project', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('up-b', 'Up B'), { input: BODY });
  for (const args of [['upnext'], ['upnext', 'up-b'], ['upnext', 'up-b', '--text'],
    ['upnext', 'up-b', '--text', '  '], ['upnext', '--text', 'x']]) {
    const r = gtg(repo, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /Usage: gtg upnext/);
  }
  const r = gtg(repo, ['upnext', 'nope', '--text', 'x']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No project with slug 'nope'/);
});

test('upnext uses only the exact slug and also updates backlog handoffs', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('up-shelf', 'Up Shelf'), { input: BODY });
  gtg(repo, ['back', 'up-shelf']);
  const before = backlog(repo).find((e) => e.slug === 'up-shelf');
  const body = readFileSync(join(repo, before.file), 'utf8');
  for (const target of ['up', 'Up Shelf', 'UP-SHELF', '1', 'b1']) {
    const r = gtg(repo, ['upnext', target, '--text', 'Wrong target']);
    assert.equal(r.status, 2, target);
    assert.match(r.stderr, /No project with slug/);
  }
  assert.equal(readFileSync(join(repo, before.file), 'utf8'), body);
  const r = gtg(repo, ['upnext', 'up-shelf', '--text', '  Then\n the docs  ']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Up next for Up Shelf: Then the docs/);
  assert.deepEqual(backlog(repo).find((e) => e.slug === 'up-shelf'), before);
  assert.match(readFileSync(join(repo, before.file), 'utf8'), /## Up next\n- Then the docs/);
});

test('edit changes the named fields and nothing else', () => {
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('ed-a', 'Ed A'), '--due', '2026-10-14', '--eta', '~1h'], { input: BODY });
  const before = rec(repo, 'ed-a');
  const r = gtg(repo, ['edit', 'ed-a', '--eta', '~20m', '--due', '2026-10-20T09:30', '--parent', 'acme']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Edited Ed A: eta, due, parent/);
  const after = rec(repo, 'ed-a');
  const rest = (o) => { const c = { ...o }; delete c.eta; delete c.due; delete c.parent; return c; };
  assert.deepEqual(rest(after), rest(before));
  assert.equal(after.eta, '~20m'); assert.equal(after.due, '2026-10-20T09:30'); assert.equal(after.parent, 'acme');
});

test('edit --next rewrites the handoff section and stores its first line in the record', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('ed-b', 'Ed B'), { input: BODY });
  const long = 'x'.repeat(200);
  const r = gtg(repo, ['edit', 'ed-b', '--next', `First line ${long}\nSecond line`]);
  assert.equal(r.status, 0, r.stderr);
  const after = rec(repo, 'ed-b');
  assert.equal(after.next, `First line ${long}`.slice(0, 150));
  assert.match(readFileSync(join(repo, after.file), 'utf8'), /## Next Action\nFirst line x+\nSecond line\n/);
});

test('edit clears due and parent with none, and refuses bad values', () => {
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('ed-c', 'Ed C'), '--due', '2026-10-14'], { input: BODY });
  gtg(repo, ['edit', 'ed-c', '--parent', 'acme']);
  assert.equal(gtg(repo, ['edit', 'ed-c', '--due', 'none', '--parent', 'none']).status, 0);
  assert.equal(rec(repo, 'ed-c').due, undefined); assert.equal(rec(repo, 'ed-c').parent, undefined);
  for (const args of [['edit', 'ed-c'], ['edit'], ['edit', 'ed-c', '--due', '14 Oct'], ['edit', 'ed-c', '--parent', '../x'],
    ['edit', 'ed-c', '--next', '  '], ['edit', 'ed-c', '--eta'], ['edit', 'ed-c', '--next', 'a\n## b'],
    ['edit', 'ed-c', '--next', '  ## b']]) assert.equal(gtg(repo, args).status, 2, args.join(' '));
  const r = gtg(repo, ['edit', 'nope', '--eta', '1h']);
  assert.equal(r.status, 2); assert.match(r.stderr, /No project with slug 'nope'/);
});

test('edit works on a backlog entry and honours --exact --expected-shelf', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('ed-d', 'Ed D'), { input: BODY });
  gtg(repo, ['back', 'ed-d']);
  assert.equal(gtg(repo, ['edit', 'ed-d', '--eta', '~2h', '--exact', '--expected-shelf', 'backlog']).status, 0);
  assert.equal(backlog(repo).find((e) => e.slug === 'ed-d').eta, '~2h');
  const r = gtg(repo, ['edit', 'ed-d', '--eta', '~3h', '--exact', '--expected-shelf', 'active']);
  assert.equal(r.status, 2); assert.match(r.stderr, /changed shelf/);
});

const UP_BODY = '## Next Action\ndo the next thing\n\n## Up next\n- one\n- two\n- three\n';
const items = (repo, slug) => {
  const doc = readFileSync(join(repo, rec(repo, slug).file), 'utf8');
  return [...doc.matchAll(/^- (.*)$/gm)].map((m) => m[1]).filter((x) => ['one', 'two', 'three', 'TWO', 'new'].includes(x));
};

test('upnext --edit, --remove and --move change one item by position', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('ul-a', 'UL A'), { input: UP_BODY });
  assert.equal(gtg(repo, ['upnext', 'ul-a', '--edit=2', '--text', 'TWO']).status, 0);
  assert.deepEqual(items(repo, 'ul-a'), ['one', 'TWO', 'three']);
  assert.equal(gtg(repo, ['upnext', 'ul-a', '--move=3', '--to=1']).status, 0);
  assert.deepEqual(items(repo, 'ul-a'), ['three', 'one', 'TWO']);
  assert.equal(gtg(repo, ['upnext', 'ul-a', '--remove=2']).status, 0);
  assert.deepEqual(items(repo, 'ul-a'), ['three', 'TWO']);
});

test('upnext positions out of range fail without touching the list', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('ul-b', 'UL B'), { input: UP_BODY });
  for (const args of [['--remove=4'], ['--remove=0'], ['--edit=9', '--text', 'x'], ['--move=1', '--to=5'], ['--remove=x']]) {
    const r = gtg(repo, ['upnext', 'ul-b', ...args]);
    assert.equal(r.status, 2, args.join(' '));
  }
  assert.match(gtg(repo, ['upnext', 'ul-b', '--remove=4']).stderr, /Up next has only 3 items/);
  assert.deepEqual(items(repo, 'ul-b'), ['one', 'two', 'three']);
});

test('upnext --promote makes item 1 the Next Action and clears the old due date', () => {
  const repo = tempRepo();
  gtg(repo, [...HANDOFF_ARGS('ul-c', 'UL C'), '--due', '2026-10-14'], { input: UP_BODY });
  const r = gtg(repo, ['upnext', 'ul-c', '--promote']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Next Action for UL C: one/);
  const after = rec(repo, 'ul-c');
  assert.equal(after.next, 'one'); assert.equal(after.due, undefined);
  const doc = readFileSync(join(repo, after.file), 'utf8');
  assert.match(doc, /## Next Action\none\n\n## Up next\n- two\n- three\n/);
});

test('upnext --promote on an empty list fails and changes nothing', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('ul-d', 'UL D'), { input: BODY });
  const before = rec(repo, 'ul-d');
  const r = gtg(repo, ['upnext', 'ul-d', '--promote']);
  assert.equal(r.status, 2); assert.match(r.stderr, /Up next is empty/);
  assert.deepEqual(rec(repo, 'ul-d'), before);
});

test('upnext --remove keeps a wrapped item whole', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('ul-e', 'UL E'), { input: '## Next Action\nx\n\n## Up next\n- one\n- two wraps\n  here\n- three\n' });
  assert.equal(gtg(repo, ['upnext', 'ul-e', '--remove=1']).status, 0);
  assert.match(readFileSync(join(repo, rec(repo, 'ul-e').file), 'utf8'), /## Up next\n- two wraps here\n- three\n/);
});

test('upnext --promote refuses a head item starting with "## " and changes nothing', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('ul-f', 'UL F'), { input: UP_BODY });
  assert.equal(gtg(repo, ['upnext', 'ul-f', '--edit=1', '--text', '## Fake']).status, 0);
  const before = rec(repo, 'ul-f');
  const docBefore = readFileSync(join(repo, before.file), 'utf8');
  const r = gtg(repo, ['upnext', 'ul-f', '--promote']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gtg upnext: the first Up next item cannot start with "## "/);
  assert.doesNotMatch(r.stderr, /at .*\.mjs/);
  assert.deepEqual(rec(repo, 'ul-f'), before);
  assert.equal(readFileSync(join(repo, before.file), 'utf8'), docBefore);
});

test('upnext position flags need a number, not a bare flag', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('ul-g', 'UL G'), { input: UP_BODY });
  for (const args of [['--remove'], ['--edit', '--text', 'x'], ['--move=2'], ['--move', '--to=1']]) {
    assert.equal(gtg(repo, ['upnext', 'ul-g', ...args]).status, 2, args.join(' '));
  }
  assert.deepEqual(items(repo, 'ul-g'), ['one', 'two', 'three']);
});

test('rename --exact changes only the named entry and keeps its slug when asked', () => {
  const repo = tempRepo();
  gtg(repo, HANDOFF_ARGS('12', 'Twelve'), { input: BODY });
  gtg(repo, HANDOFF_ARGS('rn-a', 'RN A'), { input: BODY });
  gtg(repo, [...HANDOFF_ARGS('rn-kid', 'RN kid'), '--due', '2026-12-01', '--parent', 'acme'], { input: BODY });
  // '12' is a numeric slug. Without --exact it is list position 12, which does not exist.
  const r = gtg(repo, ['rename', '12', 'twelve', '--name', 'Twelve renamed', '--exact', '--expected-shelf', 'active']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rec(repo, 'twelve').project, 'Twelve renamed');
  assert.equal(rec(repo, '12'), undefined);
  assert.equal(rec(repo, 'rn-a').project, 'RN A');
  const miss = gtg(repo, ['rename', 'acme', 'acme2', '--exact']);
  assert.equal(miss.status, 2, 'an exact rename never renames a parent reference');
  assert.equal(rec(repo, 'rn-kid').parent, 'acme');
});

test('supersede --exact needs an existing --into slug', () => {
  const repo = tempRepo();
  for (const s of ['sp-a', 'sp-b']) gtg(repo, HANDOFF_ARGS(s, s.toUpperCase()), { input: BODY });
  let r = gtg(repo, ['supersede', 'sp-a', '--into', 'nope', '--exact', '--expected-shelf', 'active']);
  assert.equal(r.status, 2); assert.match(r.stderr, /No project with slug 'nope'/);
  r = gtg(repo, ['supersede', 'sp-a', '--into', 'sp-b', '--exact', '--expected-shelf', 'active']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rec(repo, 'sp-a'), undefined); assert.ok(rec(repo, 'sp-b'));
});

test('supersede --exact reads a numeric --into as a slug, not a list position', () => {
  const repo = tempRepo();
  for (const [s, n] of [['sn-a', 'Alpha'], ['sn-b', 'Bravo'], ['2', 'Slug two']]) gtg(repo, HANDOFF_ARGS(s, n), { input: BODY });
  const r = gtg(repo, ['supersede', 'sn-a', '--into', '2', '--exact', '--expected-shelf', 'active']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Superseded: Alpha -> Slug two/);
  assert.equal(rec(repo, 'sn-a'), undefined);
  assert.ok(rec(repo, 'sn-b')); assert.ok(rec(repo, '2'));
});
