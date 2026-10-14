#!/usr/bin/env node
import { posix } from 'node:path';

// PreToolUse guard: docs/projects/INDEX.md is rendered from the store, so a hand-edit to the
// index is lost the next time any verb runs. The store is hand-editable by design (see the note
// above `rank` in lib/render.mjs), so it is guarded for a different reason: editing it directly
// skips validateSlug, validateStatus and assertRenderable, and leaves the rendered index
// disagreeing with the store until someone renders again.
//
// The store is docs/projects/entries/<slug>.json, one file per project, and it is the ONLY store.
// docs/projects/_projects.json is the packed array it replaced: DELETED in projects 1.3.0 and
// read by nothing, and still guarded for exactly that reason - writing it now creates a file no
// verb will ever look at, so the edit is silently IGNORED, which is worse than being refused.
// A slug is a filename, so a hand-edit under entries/ can likewise file a record where no verb
// will look for it.
//
// The segment is matched wherever it sits in the path rather than under one absolute root. The
// spec includes /c/Users/you/docs/projects/_projects.json, which no absolute-root anchor
// matches, so a root anchor cannot satisfy the tests. The cost is that another repo's own
// docs/projects/INDEX.md is denied too. That trade is deliberate: a false deny costs one retry,
// a false allow costs hand-written prose.
const GUARDED = [/(^|\/)docs\/projects\/INDEX\.md$/i,
  /(^|\/)docs\/projects\/_projects\.json$/i,
  /(^|\/)docs\/projects\/entries\/[^/]+\.json$/i];

// NotebookEdit passes a notebook_path rather than a file_path, so it can never reach the regexes.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function decide(input) {
  if (!input) return null;
  let paths;
  if (input.tool_name === 'apply_patch') {
    // Native Edit/Write matchers retain apply_patch and put the patch in command. Mirror the
    // native parser's header whitespace: StartedPatch/AddFile/DeleteFile trim both ends,
    // UpdateFile trims only the end so indented header-like context stays narrative prose.
    // Rust trim uses Unicode White_Space (including U+0085), not JavaScript's trim set.
    const command = input.tool_input && input.tool_input.command;
    if (typeof command !== 'string') return null;
    paths = [];
    let update = false;
    let canMove = false;
    for (const raw of command.split('\n')) {
      const line = update ? raw.replace(/\p{White_Space}+$/u, '')
        : raw.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
      if (line === '*** End Patch') break;
      const header = line.match(/^\*\*\* (Add File|Update File|Delete File): (.*)$/);
      if (header) {
        paths.push(header[2]);
        update = header[1] === 'Update File';
        canMove = update;
      } else if (update) {
        // A move is metadata only before the first Update chunk and only once.
        if (canMove && line.startsWith('*** Move to: ')) {
          paths.push(line.slice('*** Move to: '.length));
        }
        canMove = false;
      }
    }
  } else {
    if (!WRITE_TOOLS.has(input.tool_name)) return null;
    const raw = input.tool_input && input.tool_input.file_path;
    if (typeof raw !== 'string' || !raw) return null;
    paths = [raw];
  }
  // Separators alone are not enough: `${root}/` + `docs/projects/...` yields a double slash, and
  // `docs/projects/./INDEX.md` reaches the same file past an anchored regex. normalize collapses
  // both. It also rewrites a leading // to /, which keeps a UNC path denied because the regex
  // anchors on a segment boundary rather than on the start of the string.
  if (!paths.some((raw) => {
    const path = posix.normalize(raw.replace(/\\/g, '/'));
    return GUARDED.some((re) => re.test(path));
  })) return null;
  return {
    permissionDecision: 'deny',
    permissionDecisionReason:
      'docs/projects/INDEX.md is rendered from docs/projects/entries/<slug>.json, so a hand-edit '
      + 'to the index is lost the next time any verb runs, and a hand-edit to a record skips the '
      + "CLI's validation and leaves the index out of sync. Use `projects register <slug>` to add "
      + 'a project, `projects status <slug> <status>` to set its status, `projects current <slug>` '
      + "to replace a page's Current state from stdin, `projects archive <slug>` to retire one, "
      + '`projects rename <old> <new>` to change a slug, `projects render` to rebuild the index. '
      + 'The narrative pages at docs/projects/<slug>.md '
      + 'are hand-written and are not guarded. If the CLI refuses because the index carries rows '
      + 'the store does not, this root is not migrated yet, so stop and say so rather than '
      + 'hand-editing the file.',
  };
}

// Node resolves process.argv[1] to an absolute native path before we see it, so the basename
// test holds for every invocation form, and stays false when the test file imports this module.
if (process.argv[1] && process.argv[1].endsWith('projects-index-guard.mjs')) {
  let raw = '';
  // Decode at the stream, not per chunk. `raw += chunk` on a Buffer stringifies each chunk
  // independently, so a multi-byte character split across a chunk boundary becomes replacement
  // characters. Executed both ways: the corruption is real but JSON.parse still succeeds, because
  // replacement characters are legal inside a JSON string, and no verdict here changes because
  // the guarded tail is ASCII and ASCII bytes are never split. So this prevents corrupt values,
  // not a bypass. The sibling hooks in this folder still concatenate Buffers.
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let input = null;
    try {
      input = JSON.parse(raw);
    } catch {
      return; // unparseable input: never block
    }
    const d = decide(input);
    if (d) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...d } }));
  });
}
