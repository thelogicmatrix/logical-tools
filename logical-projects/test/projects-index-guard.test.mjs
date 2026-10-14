import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from '../hooks/projects-index-guard.mjs';

const w = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });
const patch = (...lines) => ({ tool_name: 'apply_patch', tool_input: {
  command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n'),
} });

// Removing native command inspection must fail these without ever applying a patch.
for (const operation of ['Add File', 'Update File', 'Delete File']) {
  test(`native ${operation} denies every generated target`, () => {
    for (const path of ['docs/projects/INDEX.md',
                        'C:/Users/you/docs/projects/_projects.json',
                        'C:\\Users\\you\\docs\\projects\\entries\\alpha.json']) {
      const body = operation === 'Add File' ? ['+new']
        : operation === 'Update File' ? ['@@', '-old', '+new'] : [];
      const decision = decide(patch(`*** ${operation}: ${path}`, ...body));
      assert.equal(decision?.permissionDecision, 'deny', path);
      assert.equal(decision.permissionDecisionReason,
        decide(w('docs/projects/INDEX.md')).permissionDecisionReason);
    }
  });
}

test('native moves deny either generated endpoint', () => {
  for (const guarded of ['docs/projects/INDEX.md',
                         'docs/projects/_projects.json',
                         'docs/projects/entries/alpha.json']) {
    for (const [from, to] of [[guarded, 'docs/projects/alpha.md'],
                              ['docs/projects/alpha.md', guarded]]) {
      assert.equal(decide(patch(`*** Update File: ${from}`, `*** Move to: ${to}`,
        '@@', '-old', '+new'))?.permissionDecision, 'deny', `${from} -> ${to}`);
    }
  }
});

test('native mixed patches deny a generated target at any position', () => {
  const narrative = ['*** Add File: docs/projects/alpha.md', '+new'];
  for (const guarded of [
    ['*** Update File: docs/projects/INDEX.md', '@@', '-old', '+new'],
    ['*** Delete File: docs/projects/_projects.json'],
    ['*** Add File: docs/projects/entries/alpha.json', '+{}'],
    ['*** Update File: docs/projects/alpha.md',
     '*** Move to: docs/projects/entries/alpha.json', '@@', '-old', '+new'],
  ]) {
    for (const lines of [[...narrative, ...guarded], [...guarded, ...narrative]]) {
      assert.equal(decide(patch(...lines))?.permissionDecision, 'deny');
    }
  }
});

test('native targets use the established path normalization', () => {
  for (const path of ['docs//projects/INDEX.md', 'docs/projects/sub/../INDEX.md',
                      'C:\\Users\\you\\docs\\projects\\.\\INDEX.md',
                      '//server/share/docs/projects/entries/alpha.json',
                      '/c/Users/you/DOCS/PROJECTS/_PROJECTS.JSON']) {
    assert.equal(decide(patch(`*** Delete File: ${path}`))?.permissionDecision, 'deny', path);
    assert.equal(decide(patch('*** Update File: docs/projects/alpha.md',
      `*** Move to: ${path}`, '@@', '-old', '+new'))?.permissionDecision, 'deny', path);
  }
  const crlf = patch('*** Delete File: docs/projects/./INDEX.md');
  crlf.tool_input.command = crlf.tool_input.command.replace(/\n/g, '\r\n');
  assert.equal(decide(crlf)?.permissionDecision, 'deny');
});

// Rust's native parser trims headers in StartedPatch/AddFile/DeleteFile, but only
// trims the end in UpdateFile. U+0085 is Rust White_Space, unlike JavaScript trim().
for (const operation of ['Add File', 'Update File', 'Delete File']) {
  test(`native indented ${operation} headers deny generated files in header states`, () => {
    for (const whitespace of [' ', '\t', ' \t', '\u2003', '\u0085']) {
      for (const prefix of [[], ['*** Add File: docs/projects/narrative.md', '+prose'],
                            ['*** Delete File: docs/projects/old.md']]) {
        const body = operation === 'Add File' ? ['+new']
          : operation === 'Update File'
            ? ['*** Move to: docs/projects/narrative.md', '@@', '-old', '+new'] : [];
        for (const path of ['docs/projects/INDEX.md', 'docs/projects/_projects.json',
                            'docs/projects/entries/alpha.json']) {
          assert.equal(decide(patch(...prefix,
            `${whitespace}*** ${operation}: ${path}${whitespace}`, ...body))?.permissionDecision,
          'deny', `${operation} ${path} with ${JSON.stringify(whitespace)}`);
        }
      }
    }
  });
}

test('native indented narrative Update still checks its generated move destination', () => {
  assert.equal(decide(patch('\t*** Update File: docs/projects/narrative.md',
    '*** Move to: docs/projects/entries/alpha.json\u0085', '@@', '-old', '+new'))?.permissionDecision,
  'deny');
});

test('native Update context keeps indented header-like narrative prose writable', () => {
  assert.equal(decide(patch('*** Update File: docs/projects/narrative.md', '@@',
    '-old', '+new', ' *** Add File: docs/projects/INDEX.md',
    ' *** Update File: docs/projects/_projects.json',
    ' *** Delete File: docs/projects/entries/alpha.json',
    ' *** Move to: docs/projects/INDEX.md',
    '+*** Delete File: docs/projects/INDEX.md',
    '-*** Update File: docs/projects/INDEX.md')), null);
  // A real Add header changes the parsing state back to accepting indented headers.
  assert.equal(decide(patch('*** Update File: docs/projects/narrative.md', '@@', '-old', '+new',
    ' *** Delete File: docs/projects/INDEX.md',
    '*** Add File: docs/projects/other.md', '+prose',
    '\t*** Delete File: docs/projects/entries/alpha.json'))?.permissionDecision, 'deny');
});

test('native patches allow narrative operations and paths outside the guarded shapes', () => {
  assert.equal(decide(patch('*** Add File: docs/projects/alpha.md', '+new',
    '*** Update File: docs/projects/beta.md', '*** Move to: docs/projects/archive/beta.md',
    '@@', '-old', '+new', '*** Delete File: docs/projects/gamma.md')), null);
  for (const path of ['docs/projects/../INDEX.md', 'docs/projects/INDEX.md.bak',
                      'docs/projects/archive/INDEX.md', 'mydocs/projects/INDEX.md',
                      'docs/projects/entries/alpha.md', 'docs/projects/archive/entries/alpha.json']) {
    assert.equal(decide(patch(`*** Delete File: ${path}`)), null, path);
  }
  // Patch body lines carry a content prefix, so header-like prose is not a target.
  assert.equal(decide(patch('*** Add File: docs/projects/alpha.md',
    '+*** Delete File: docs/projects/INDEX.md',
    '+*** Move to: docs/projects/entries/alpha.json')), null);
});

test('Claude tools and CLI ownership exceptions retain their decisions', () => {
  for (const tool_name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(decide({ ...w('docs/projects/INDEX.md'), tool_name })?.permissionDecision, 'deny');
    assert.equal(decide({ ...w('docs/projects/alpha.md'), tool_name }), null);
  }
  assert.equal(decide({ tool_name: 'NotebookEdit', tool_input: {
    notebook_path: 'docs/projects/INDEX.md',
  } }), null);
  assert.equal(decide({ tool_name: 'Bash', tool_input: {
    command: 'projects render', file_path: 'docs/projects/INDEX.md',
  } }), null);
  for (const tool_input of [undefined, {}, { command: null }, { command: 42 },
                            { command: '' }, { file_path: 'docs/projects/INDEX.md' }]) {
    assert.equal(decide({ tool_name: 'apply_patch', tool_input }), null);
  }
});

test('synthetic native hook stdin emits a deny verdict and stays silent for narrative edits', () => {
  const script = fileURLToPath(new URL('../hooks/projects-index-guard.mjs', import.meta.url));
  const denied = spawnSync(process.execPath, [script], {
    input: JSON.stringify(patch('*** Delete File: docs/projects/INDEX.md')), encoding: 'utf8',
  });
  assert.equal(denied.status, 0, denied.stderr);
  assert.notEqual(denied.stdout, '', 'guard must emit a verdict for a generated target');
  const output = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  const allowed = spawnSync(process.execPath, [script], {
    input: JSON.stringify(patch('*** Delete File: docs/projects/alpha.md')), encoding: 'utf8',
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, '');
});

test('denies the generated index and the store, on either slash style', () => {
  for (const p of ['C:/Users/you/docs/projects/INDEX.md',
                   'C:\\Users\\you\\docs\\projects\\INDEX.md',
                   '/c/Users/you/docs/projects/_projects.json']) {
    const d = decide(w(p));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.permissionDecisionReason, /projects current|projects status|generated/);
  }
});

// The store is one file per project now, so the guarded shape is a directory of records rather
// than one array file. The reason is the same as it always was: a hand-edit skips validateSlug,
// validateStatus and assertRenderable, and leaves the rendered index disagreeing with the store.
// A slug is also a FILENAME now, so a hand-edit can put a record somewhere no verb will find it.
test('denies a per-project record file under entries/', () => {
  for (const p of ['docs/projects/entries/alpha.json',
                   'C:/Users/you/docs/projects/entries/alpha.json',
                   'C:\\Users\\you\\docs\\projects\\entries\\alpha.json',
                   'docs/projects/entries/./alpha.json',
                   'docs//projects/entries/alpha.json']) {
    assert.equal(decide(w(p)).permissionDecision, 'deny', p);
  }
});

test('does not deny things that only look like a record file', () => {
  for (const p of ['docs/projects/entries.md',
                   'docs/projects/entries/alpha.md',
                   'docs/projects/archive/entries/alpha.json',
                   'C:/dev/other/mydocs/projects/entries/alpha.json']) {
    assert.equal(decide(w(p)), null, p);
  }
});

test('allows narrative pages, which are hand-written by design', () => {
  for (const p of ['C:/Users/you/docs/projects/price-alerts.md',
                   'C:/Users/you/docs/projects/CRITIQUES.md',
                   'C:/Users/you/docs/projects/archive/old.md']) {
    assert.equal(decide(w(p)), null);
  }
});

test('allows an INDEX.md belonging to some other folder', () => {
  assert.equal(decide(w('C:/dev/other/docs/INDEX.md')), null);
  assert.equal(decide(w('C:/dev/other/INDEX.md')), null);
});

test('ignores tools that are not writes, and malformed input', () => {
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: 'docs/projects/INDEX.md' } }), null);
  assert.equal(decide({}), null);
  assert.equal(decide({ tool_name: 'Write' }), null);
  assert.equal(decide({ tool_name: 'Write', tool_input: {} }), null);
});

// Pins the deliberate ruling on scope. The guard matches the path segment wherever it sits, so
// another repo with its own docs/projects/INDEX.md is denied too. The alternative, anchoring on
// a real home directory, cannot pass the /c/Users/... case in the first test above, and a
// false allow silently destroys the hand-written prose this hook exists to protect, while a
// false deny costs one retry. `mydocs/` is not the segment and stays allowed.
test('matches the path segment anywhere, but only on a segment boundary', () => {
  assert.equal(decide(w('C:/dev/other/docs/projects/INDEX.md')).permissionDecision, 'deny');
  assert.equal(decide(w('docs/projects/_projects.json')).permissionDecision, 'deny');
  assert.equal(decide(w('C:/dev/other/mydocs/projects/INDEX.md')), null);
});

// Separator normalisation alone left these reaching the guarded files past an anchored regex.
// The double-slash form is the reachable one: it falls out of any `${root}/` + `docs/projects/...`
// join, and skill-driven writes are this guard's main audience.
test('denies non-canonical paths that resolve to a guarded file', () => {
  for (const p of ['docs//projects/INDEX.md',
                   'docs/projects/./INDEX.md',
                   'docs/projects/sub/../INDEX.md',
                   'C:/Users/you/docs//projects/INDEX.md',
                   'C:\\Users\\you\\docs\\projects\\.\\INDEX.md',
                   'C:/Users/you/docs/projects/sub/../_projects.json',
                   '//server/share/docs/projects/INDEX.md']) {
    assert.equal(decide(w(p)).permissionDecision, 'deny', p);
  }
});

// The mirror image: normalising must not pull in a path that resolves somewhere else.
test('still allows paths that only look like the guarded ones', () => {
  for (const p of ['docs/projects/../INDEX.md',
                   'docs/projects/INDEX.md.bak',
                   'docs/projects/archive/INDEX.md',
                   'C:/dev/other/mydocs//projects/INDEX.md']) {
    assert.equal(decide(w(p)), null, p);
  }
});

// The deny string is read by a human mid-task and every verb in it must exist. `sync` is
// deliberately absent: it is read-only and is not a remedy for a denied write.
test('the reason names only verbs the CLI has, and no banned punctuation', () => {
  const reason = decide(w('docs/projects/INDEX.md')).permissionDecisionReason;
  assert.match(reason, /projects current|projects status|generated/);
  for (const verb of ['register', 'status', 'current', 'archive', 'render']) {
    assert.match(reason, new RegExp('`projects ' + verb + '\\b'));
  }
  assert.doesNotMatch(reason, /[\u2013\u2014;]/);
  assert.doesNotMatch(reason, /projects (sync|list|help)/);
  // The load-bearing sentence: without it the deny points at a CLI that exits 2 on an
  // unmigrated root and gives no next action.
  assert.match(reason, /not migrated yet/);
});
