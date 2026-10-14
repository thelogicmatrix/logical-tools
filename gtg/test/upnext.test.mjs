import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUpNext } from '../skills/gtg/lib/upnext.mjs';

const DOC = '# Handoff: X\n\n## Next Action\nShip it\n\n## Up next\n- First\n\n## Key Decisions Made\n- one\n\n## Resume Prompt\nSay: "gtg x"\n';

test('appends to an existing Up next list, before the next section', () => {
  const out = addUpNext(DOC, 'Second');
  assert.match(out, /## Up next\n- First\n- Second\n\n## Key Decisions Made/);
});

test('makes the section straight after Next Action when there is none', () => {
  const doc = '## Next Action\nShip it\n\n## Key Decisions Made\n- one\n';
  assert.equal(addUpNext(doc, 'Later'), '## Next Action\nShip it\n\n## Up next\n- Later\n\n## Key Decisions Made\n- one\n');
});

test('with no Next Action, goes before Resume Prompt, else at the end', () => {
  assert.match(addUpNext('# H\n\n## Resume Prompt\nSay: "gtg x"\n', 'A'), /## Up next\n- A\n\n## Resume Prompt/);
  assert.equal(addUpNext('## Next Action\nShip it\n', 'B'), '## Next Action\nShip it\n\n## Up next\n- B\n');
  assert.equal(addUpNext('# H\n', 'C'), '# H\n\n## Up next\n- C\n');
});

test('collapses whitespace and refuses an empty item', () => {
  assert.match(addUpNext(DOC, '  two\n  lines '), /- two lines\n/);
  assert.throws(() => addUpNext(DOC, '   '), /empty Up next item/);
});
