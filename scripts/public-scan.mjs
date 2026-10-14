// What may not leave in a public release: the generic rules below, plus private terms the
// publisher keeps outside the repo. Shipping the private terms would publish the names they
// guard, so they live in a file of their own: $PUBLIC_TREE_TERMS, else
// ~/.config/logical-tools/public-tree-terms.txt. One rule per line, `label | regex` with an
// optional `| path regex` that limits it to matching files. Regexes are case-insensitive.
// Blank lines and lines starting with # are skipped.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Safe to publish: they name a shape, not a person or place.
export const GENERIC_RULES = [
  ['owner name', /nathan/i],
  // 100.64.0.0/10, the range Tailscale hands out. 100.63.x and 100.128.x are public addresses.
  ['Tailscale address', /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ['Tailscale hostname', /\.ts\.net\b/i],
  ['LAN address', /\b(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/],
  // A real user folder; me, you, user and a placeholder like <you> or ... are fine.
  ['Tailscale IPv6 address', /\bfd7a:115c:a1e0:/i],
  // A real user folder; me, you, user and a placeholder like <you> or ... are fine.
  ['Windows home path', /[A-Z]:[\\/]Users[\\/](?!(me|you|user)\b)[A-Za-z0-9][A-Za-z0-9._-]*/i],
  // Three characters or more: /home/u is a placeholder. Fixture and example names are fine too.
  ['Unix home path', /(?<![\w.~:\\-])\/(home|Users)\/(?!(me|you|user|dev|runner|someone|fixture|example)\b)[A-Za-z0-9][A-Za-z0-9._-]{2,}/],
];

// The author credit is the one place the name belongs: the license holder, the manifest author
// fields and the root README byline. Only the full name is allowed, and only in these files.
export const CREDIT = 'Nathan Wong';
export const isCreditFile = (file) =>
  file === 'LICENSE' || file === 'README.md' || /(^|\/)\.(claude|codex)-plugin\/(plugin|marketplace)\.json$/.test(file);

// The scanner's own files hold the generic patterns and the credit, so they would match themselves.
export const SCANNER_FILES = new Set(['scripts/public-scan.mjs', 'test/public-tree.test.mjs']);

export const termsFile = (env = process.env) =>
  env.PUBLIC_TREE_TERMS || join(homedir(), '.config', 'logical-tools', 'public-tree-terms.txt');

export function parseTerms(text) {
  const rules = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [label, re, scope] = line.split(/\s+\|\s+/);
    if (!label || !re) throw new Error(`terms line ${i + 1}: want "label | regex [| path regex]"`);
    rules.push([label, new RegExp(re, 'i'), scope ? new RegExp(scope) : undefined]);
  });
  return rules;
}

// The private rules, or null when the publisher has none on this machine.
export function loadPrivateTerms(env = process.env) {
  const f = termsFile(env);
  return existsSync(f) ? parseTerms(readFileSync(f, 'utf8')) : null;
}

export function scanLine(file, line, rules) {
  const text = isCreditFile(file) ? line.split(CREDIT).join('') : line;
  return rules.filter(([, re, scope]) => (!scope || scope.test(file)) && re.test(text)).map(([name]) => name);
}

// Text for a file's bytes. A NUL marks binary or UTF-16, which is read both as latin1 and as
// UTF-16 rather than skipped, so a stray NUL cannot hide a name.
export const decode = (buf) => (buf.includes(0) ? `${buf.toString('latin1')}\n${buf.toString('utf16le')}` : buf.toString('utf8'));

// files: [{ path, text }]. Returns "path:line: rule: text" for every hit, the path itself included.
export function scanFiles(files, rules) {
  const hits = [];
  for (const { path, text } of files) {
    for (const rule of scanLine(path, path, rules)) hits.push(`${path}: ${rule}: (in the file path)`);
    text.split(/\r?\n/).forEach((line, i) => {
      for (const rule of scanLine(path, line, rules)) hits.push(`${path}:${i + 1}: ${rule}: ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

// The whole scan. The scanner's own files carry the generic patterns and the credit, so they skip
// the generic rules, but never the private ones.
export function scanPublic(files, privateRules) {
  const own = files.filter((f) => SCANNER_FILES.has(f.path));
  const rest = files.filter((f) => !SCANNER_FILES.has(f.path));
  return [...scanFiles(rest, [...GENERIC_RULES, ...privateRules]), ...scanFiles(own, privateRules)];
}
