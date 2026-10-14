// The public tree names no person, machine or private address. logical-tools is worked on in a private
// repo and published to GitHub by hand (scripts/release-public.mjs), and this runs in CI on every push
// so a leak fails before the publish instead of after it. On 2026-09-28 a hard-coded Tailscale address,
// two machine names and an employer's name were found already public.
//
// The private names themselves are not in this file: shipping them would publish them. They come
// from the publisher's terms file (scripts/public-scan.mjs). Without it only the generic rules run,
// unless REQUIRE_PUBLIC_TREE_TERMS is set, which makes a missing file a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERIC_RULES, decode, loadPrivateTerms, parseTerms, scanFiles, scanLine, scanPublic, termsFile } from '../scripts/public-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function trackedFiles() {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  return paths.flatMap((path) => {
    return [{ path, text: decode(readFileSync(join(ROOT, path))) }];
  });
}

// Made-up private terms, so the tests show the mechanism without naming anything real.
const SAMPLE = `# sample terms
machine name | \\b(hal9000|deepthought)\\b
employer | examplecorp
private project name | skunkworks | ^jevtools/
`;

test('each generic rule catches its named case and leaves the near misses alone', () => {
  const g = (file, line) => scanLine(file, line, GENERIC_RULES);
  assert.deepEqual(g('jevtools/scripts/x.mjs', "// Classify Nathan's repos"), ['owner name']);
  assert.deepEqual(g('jevtools/x.mjs', "const HOST = 'http://100.101.102.103:8080'"), ['Tailscale address']);
  assert.deepEqual(g('jevtools/x.mjs', 'http://100.64.0.1 and 100.127.255.255'), ['Tailscale address']);
  assert.deepEqual(g('x.md', 'box.tail1234.ts.net'), ['Tailscale hostname']);
  assert.deepEqual(g('x.md', '100.63.0.1 and 100.128.0.1 are public'), []);
  assert.deepEqual(g('x.md', 'http://192.168.1.20 and 10.0.0.5'), ['LAN address']);
  assert.deepEqual(g('gtg/test/x.mjs', "home: 'C:/Users/somebody'"), ['Windows home path']);
  assert.deepEqual(g('gtg/test/x.mjs', "home: 'C:\\Users\\somebody'"), ['Windows home path']);
  assert.deepEqual(g('gtg/test/x.mjs', "home: 'C:/Users/me' or C:/Users/<you>"), []);
});

test('private terms load from a file, with an optional path scope', () => {
  const rules = parseTerms(SAMPLE);
  assert.deepEqual(scanLine('gtg/x.mjs', "const HOST = 'hal9000'", rules), ['machine name']);
  assert.deepEqual(scanLine('postman/x.py', '# ExampleCorp logo', rules), ['employer']);
  assert.deepEqual(scanLine('jevtools/README.md', 'Skunkworks | 12%', rules), ['private project name']);
  assert.deepEqual(scanLine('gtg/test/x.mjs', 'skunkworks', rules), [], 'the scoped rule only reads jevtools');
  assert.throws(() => parseTerms('just a word'), /want "label \| regex/);

  const dir = mkdtempSync(join(tmpdir(), 'terms-'));
  writeFileSync(join(dir, 't.txt'), SAMPLE);
  assert.equal(loadPrivateTerms({ PUBLIC_TREE_TERMS: join(dir, 't.txt') }).length, 3);
  assert.equal(loadPrivateTerms({ PUBLIC_TREE_TERMS: join(dir, 'missing.txt') }), null);
});

test('paths, binary or UTF-16 files and the scanner files themselves get no free pass', () => {
  const rules = parseTerms(SAMPLE);
  assert.deepEqual(scanFiles([{ path: 'docs/hal9000-notes.md', text: 'clean' }], rules), ['docs/hal9000-notes.md: machine name: (in the file path)']);
  const utf16 = decode(Buffer.from('runs on hal9000', 'utf16le'));
  const nul = decode(Buffer.concat([Buffer.from('\0'), Buffer.from('examplecorp')]));
  assert.deepEqual(scanFiles([{ path: 'a.bin', text: utf16 }, { path: 'b.bin', text: nul }], rules).map((h) => h.split(': ')[1]), ['machine name', 'employer']);
  // The scanner's own files skip the generic rules, never the private ones.
  const own = [{ path: 'scripts/public-scan.mjs', text: "['owner name', /nathan/i]\nconst HOST = 'hal9000'" }];
  assert.deepEqual(scanPublic(own, rules).map((h) => h.split(': ')[1]), ['machine name']);
});

test('the IPv6 and Unix home path rules', () => {
  const g = (line) => scanLine('x.md', line, GENERIC_RULES);
  assert.deepEqual(g('fd7a:115c:a1e0::1234'), ['Tailscale IPv6 address']);
  assert.deepEqual(g("cwd: '/home/somebody/projects'"), ['Unix home path']);
  assert.deepEqual(g('see /Users/somebody/Desktop'), ['Unix home path']);
  assert.deepEqual(g('/home/user/x, /Users/dev/project, ~/home/x, /srv/home/x'), []);
});

test('the credit allowance is the full name in credit files only', () => {
  const rules = [...GENERIC_RULES, ...parseTerms(SAMPLE)];
  assert.deepEqual(scanLine('LICENSE', 'Copyright (c) 2026 Nathan Wong', rules), []);
  assert.deepEqual(scanLine('jevtools/.codex-plugin/plugin.json', '"developerName": "Nathan Wong",', rules), []);
  assert.deepEqual(scanLine('README.md', 'By [Nathan Wong](https://github.com/thelogicmatrix).', rules), []);
  assert.deepEqual(scanLine('jevtools/README.md', 'By Nathan Wong', rules), ['owner name'], 'a plugin README is not a credit file');
  assert.deepEqual(scanLine('LICENSE', 'Copyright (c) 2026 Nathan', rules), ['owner name'], 'the first name alone is not the credit');
  assert.deepEqual(scanLine('README.md', 'Nathan Wong runs this on hal9000', rules), ['machine name']);
});

test('no tracked file names a person, machine or private address', (t) => {
  const priv = loadPrivateTerms();
  if (!priv) {
    assert.ok(!process.env.REQUIRE_PUBLIC_TREE_TERMS, `REQUIRE_PUBLIC_TREE_TERMS is set but ${termsFile()} does not exist`);
    t.diagnostic(`no private terms at ${termsFile()}: generic rules only`);
  }
  const files = trackedFiles();
  assert.ok(files.length > 100, `git ls-files returned ${files.length} files, so the scan did not see the tree`);
  const hits = scanPublic(files, priv ?? []);
  assert.deepEqual(hits, [], `clear these before publishing:\n${hits.join('\n')}`);
});
