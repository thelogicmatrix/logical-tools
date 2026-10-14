import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUpNext, upNextItems, setUpNext, setSection } from '../skills/gtg/lib/upnext.mjs';

const DOC = '# Handoff: X\n\n## Where We Stopped\nHere.\n\n## Next Action\nDo A.\n\n## Up next\n- B\n- C wraps\n  onto two lines\n- D\n\n## Key Decisions Made\n- k\n';

test('upNextItems reads bullets in order and joins wrapped lines', () => {
  assert.deepEqual(upNextItems(DOC), ['B', 'C wraps onto two lines', 'D']);
  assert.deepEqual(upNextItems('## Next Action\nx\n'), []);
  assert.deepEqual(upNextItems(''), []);
});

test('setUpNext replaces the list in place and leaves other sections alone', () => {
  const out = setUpNext(DOC, ['D', 'B']);
  assert.deepEqual(upNextItems(out), ['D', 'B']);
  assert.match(out, /## Next Action\nDo A\.\n\n## Up next\n- D\n- B\n\n## Key Decisions Made\n- k\n$/);
});

test('setUpNext with no items removes the section', () => {
  const out = setUpNext(DOC, []);
  assert.doesNotMatch(out, /## Up next/);
  assert.match(out, /## Next Action\nDo A\.\n\n## Key Decisions Made/);
});

test('setUpNext adds a missing list where addUpNext would', () => {
  const doc = '## Next Action\nDo A.\n\n## Resume Prompt\nsay x\n';
  assert.equal(setUpNext(doc, ['B']), addUpNext(doc, 'B'));
});

test('setSection replaces a body, keeps neighbours, and accepts multi-line text', () => {
  const out = setSection(DOC, 'Next Action', 'New step.\nSecond line.');
  assert.match(out, /## Next Action\nNew step\.\nSecond line\.\n\n## Up next\n- B/);
  assert.match(out, /## Where We Stopped\nHere\.\n\n## Next Action/);
});

test('setSection inserts a missing section before Up next, else Resume Prompt, else at the end', () => {
  assert.match(setSection('## Up next\n- B\n', 'Next Action', 'A'), /^## Next Action\nA\n\n## Up next\n- B\n$/);
  assert.match(setSection('## Where We Stopped\nx\n\n## Resume Prompt\ny\n', 'Next Action', 'A'), /x\n\n## Next Action\nA\n\n## Resume Prompt\ny\n$/);
  assert.equal(setSection('## Where We Stopped\nx\n', 'Next Action', 'A'), '## Where We Stopped\nx\n\n## Next Action\nA\n');
});

test('headings match exactly, so a longer heading is not mistaken for the section', () => {
  const doc = '## Next Actions considered\nno\n\n## Next Action\nyes\n';
  assert.match(setSection(doc, 'Next Action', 'changed'), /## Next Actions considered\nno\n\n## Next Action\nchanged\n$/);
});

test('setUpNext keeps a lead-in above the items, across an unchanged rewrite and a remove', () => {
  const doc = '## Next Action\nx\n\n## Up next\nOrder matters:\n- A\n- B\n\n## Key\nk\n';
  assert.equal(setUpNext(doc, ['A', 'B']), doc);
  assert.match(setUpNext(doc, ['B']), /## Up next\nOrder matters:\n- B\n\n## Key/);
  const cleared = setUpNext(doc, []);
  assert.match(cleared, /## Next Action\nx\n\n## Up next\nOrder matters:\n\n## Key\nk\n$/);
  assert.deepEqual(upNextItems(cleared), []);
});

test('a trailer after the items is kept, separate from the last item', () => {
  const doc = '## Up next\n- A\n- B\n\nSee the plan for why.\n';
  assert.deepEqual(upNextItems(doc), ['A', 'B']);
  assert.equal(setUpNext(doc, ['B', 'A']), '## Up next\n- B\n- A\n\nSee the plan for why.\n');
  assert.equal(setUpNext(doc, []), '## Up next\nSee the plan for why.\n');
});

test('a bullet after a trailer paragraph still counts as an item', () => {
  const doc = '## Up next\n- A\n\nNote.\n- B\n';
  assert.deepEqual(upNextItems(doc), ['A', 'B']);
  assert.equal(setUpNext(doc, ['A', 'B']), '## Up next\n- A\n- B\n\nNote.\n');
});

test('only indented lines directly after a bullet continue it', () => {
  const doc = '## Up next\n- A\n  wraps\n  twice\n- B\n\n  indented after a blank\n';
  assert.deepEqual(upNextItems(doc), ['A wraps twice', 'B']);
  const out = setUpNext(doc, upNextItems(doc));
  assert.deepEqual(upNextItems(out), ['A wraps twice', 'B']);
  assert.match(out, /- A wraps twice\n- B\n\n  indented after a blank\n$/);
});

test('setUpNext removes a section that holds nothing else', () => {
  assert.doesNotMatch(setUpNext('## Up next\n- A\n\n## Key\nk\n', []), /Up next/);
});

test('setUpNext on a doc with no list equals repeated addUpNext', () => {
  const doc = '## Next Action\nDo A.\n\n## Resume Prompt\nsay x\n';
  assert.equal(setUpNext(doc, ['B', 'C', 'D']), addUpNext(addUpNext(addUpNext(doc, 'B'), 'C'), 'D'));
  assert.equal(setUpNext(doc, []), doc);
});

// Shared with Logic tests/logic/sync-lib.test.ts: the site's up_next must equal upNextItems(handoff),
// or a numbered edit on the site lands on a different item here.
const UP_NEXT_CASES = [
  ['a nested bullet joins its parent', '## Up next\n- A\n  - A1\n- B\n- C\n', ['A - A1', 'B', 'C']],
  ['a wrapped item keeps its wrapped part', '## Up next\n- A wraps\n  onto two lines\n- B\n', ['A wraps onto two lines', 'B']],
  ['an indented line after a blank is not an item', '## Up next\n- A\n\n  - indented after a blank\n- B\n', ['A', 'B']],
  ['lead-in lines are never items', '## Up next\nOrder matters:\n  - not an item\n- A\n- B\n', ['A', 'B']],
  ['a trailer is not an item', '## Up next\n- A\n- B\n\nSee the plan for why.\n', ['A', 'B']],
  ['a bullet after a trailer is still an item', '## Up next\n- A\n\nNote.\n- B\n', ['A', 'B']],
  ['star bullets and a one-space indent count', '## Up next\n* A\n * B\n', ['A', 'B']],
  ['only the Up next section is read', '## Next Action\n- x\n\n## up next\n- A\n\n## Key\n- not this\n', ['A']],
  ['no section means no items', '## Next Action\nx\n', []],
];

for (const [name, doc, items] of UP_NEXT_CASES) {
  test(`upNextItems shared fixture: ${name}`, () => assert.deepEqual(upNextItems(doc), items));
}

test('setSection refuses a body line that starts a section', () => {
  assert.throws(() => setSection(DOC, 'Next Action', 'ok\n## Sneaky'), /cannot contain a line starting with "## "/);
  assert.doesNotThrow(() => setSection(DOC, 'Next Action', 'a ## b\n### deeper'));
});
