// Gate 3: every vendored lib-cli file matches its canonical copy. Gate 5: no plugin reaches a file
// outside its own folder, because an installed plugin has no siblings. Both read the real repo.
// Gate 5 reads import specifiers, `new URL('<relative>', import.meta.url)`, and a join or resolve of
// string literals onto the file's own folder. jevmail ran a sibling plugin's postman.py through the
// second form, which the import-only scan missed (#126). A path built any other way (a variable
// holding '..', a base that is not the file's own folder) is still out of its reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { REPO, plugins, status } from '../scripts/sync-lib.mjs';

const rel = (p) => relative(REPO, p).split(sep).join('/');

test('every vendored lib-cli file matches its canonical copy', () => {
  const off = status(REPO).filter((r) => r.state !== 'same').map((r) => `${r.state}: ${rel(r.target)}`);
  assert.deepEqual(off, [], 'run node scripts/sync-lib.mjs and commit the copies');
});

// Static `from '...'`, side-effect `import '...'` and dynamic `import('...')` with a relative literal.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;
function sources(dir, out = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.superpowers'].includes(d.name)) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) sources(p, out);
    else if (/\.(mjs|js)$/.test(d.name)) out.push(p);
  }
  return out;
}

// `new URL('../x', import.meta.url)`, the form jevmail used to run postman.py.
const URL_SPEC = /\bnew\s+URL\(\s*(['"`])(\.{1,2}\/[^'"`]*)\1\s*,\s*import\.meta\.url\b/g;
// A name bound to the file's own folder: import.meta.dirname or dirname(fileURLToPath(import.meta.url)).
const OWN_DIR = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:import\.meta\.dirname\b|(?:path\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\))/g;
// join(base, 'a', '..') or resolve(...), with only string literals after the base.
const JOIN = /\b(?:path\.)?(?:join|resolve)\(\s*([A-Za-z_$][\w$.]*)\s*((?:,\s*(['"])[^'"]*\3\s*)+)\)/g;
const LIT = /(['"])([^'"]*)\1/g;

// Every relative path a source file reaches: [form, the path as written].
export function reaches(text) {
  const out = [];
  for (const [, , spec] of text.matchAll(SPEC)) out.push(['imports', spec]);
  for (const [, , spec] of text.matchAll(URL_SPEC)) out.push(['new URL', spec]);
  const own = new Set(['import.meta.dirname', '__dirname', ...[...text.matchAll(OWN_DIR)].map((m) => m[1])]);
  for (const [, base, args] of text.matchAll(JOIN)) {
    if (own.has(base)) out.push(['joins', [...args.matchAll(LIT)].map((m) => m[2]).join('/')]);
  }
  return out;
}

test('no plugin reaches a file outside its own folder', () => {
  const bad = [];
  for (const p of plugins(REPO)) {
    const root = join(REPO, p);
    for (const file of sources(root)) {
      for (const [form, spec] of reaches(readFileSync(file, 'utf8'))) {
        if (relative(root, resolve(dirname(file), spec)).startsWith('..')) bad.push(`${rel(file)} ${form} ${spec}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

// Pinned by form, so a regex that stops matching one of them cannot pass the gate above by
// finding nothing.
test("gate 5 sees all three forms, and only paths built on the file's own folder", () => {
  const src = [
    "import x from '../a.mjs';",
    "const P = fileURLToPath(new URL('../../postman/skills/postman/postman.py', import.meta.url));",
    'const HERE = path.dirname(fileURLToPath(import.meta.url));',
    "const Q = path.join(HERE, '..', '..', 'postman', 'postman.py');",
    "const R = resolve(import.meta.dirname, '../b');",
    "const S = join(ROOT, '..', 'not-own-dir');",
    "const T = new URL('./same.mjs', import.meta.url);",
  ].join('\n');
  assert.deepEqual(reaches(src), [
    ['imports', '../a.mjs'],
    ['new URL', '../../postman/skills/postman/postman.py'],
    ['new URL', './same.mjs'],
    ['joins', '../../postman/postman.py'],
    ['joins', '../b'],
  ]);
});
