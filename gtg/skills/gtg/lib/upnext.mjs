// One item onto a handoff's "## Up next" list. The list ends at the next "## " heading. With no list,
// a new one goes straight after the Next Action section, else before "## Resume Prompt", else at the end.
export function addUpNext(doc, item) {
  const clean = String(item).replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('empty Up next item');
  const lines = String(doc).replace(/\s*$/, '').split('\n');
  const heading = (re) => lines.findIndex((l) => re.test(l));
  const sectionEnd = (from) => { let i = from + 1; while (i < lines.length && !/^## /.test(lines[i])) i++; return i; };
  const list = heading(/^## Up next\s*$/i);
  if (list >= 0) {
    let last = sectionEnd(list) - 1;
    while (last > list && !lines[last].trim()) last--;
    lines.splice(last + 1, 0, `- ${clean}`);
    return lines.join('\n') + '\n';
  }
  const next = heading(/^## Next Action\s*$/);
  let at = next >= 0 ? sectionEnd(next) : -1;
  if (at < 0 || at === lines.length) {
    const resume = heading(/^## Resume Prompt\s*$/);
    at = resume >= 0 ? resume : lines.length;
  }
  if (at === lines.length) return `${lines.join('\n')}\n\n## Up next\n- ${clean}\n`;
  while (at > 0 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, '', '## Up next', `- ${clean}`);
  return lines.join('\n') + '\n';
}

// The lines of a doc, split into a heading-free preamble and "## " sections. Each section keeps
// its heading line and body lines. Rebuilding normalises the blank lines between sections and
// trims trailing whitespace, so it does not reproduce a doc byte for byte.
function sections(doc) {
  const lines = String(doc).replace(/\s*$/, '').split('\n');
  const out = [{ heading: null, lines: [] }];
  for (const line of lines) {
    if (/^## /.test(line)) out.push({ heading: line.slice(3).trim(), lines: [line] });
    else out.at(-1).lines.push(line);
  }
  return out;
}

const trimBlank = (lines) => {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

// Blocks joined with exactly one blank line between them and a single trailing newline.
function rebuild(blocks) {
  return blocks.map((b) => trimBlank(b)).filter((b) => b.length).map((b) => b.join('\n')).join('\n\n') + '\n';
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// A section's body as lead-in (text before the first bullet), items, and trailer (non-bullet text
// after a blank line that follows the items). An indented line directly after a bullet or another
// continuation joins that item. A bullet after a trailer paragraph is still an item.
function parseUpNext(lines) {
  const lead = [], items = [], trailer = [];
  let open = false;
  for (const line of lines.slice(1)) {
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (m && !/^\s{2,}/.test(line)) { items.push(m[1]); open = true; }
    else if (!line.trim()) { open = false; (items.length ? trailer : lead).push(''); }
    else if (open && /^\s/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    else (items.length ? trailer : lead).push(line);
  }
  while (lead.length && !lead[0].trim()) lead.shift();
  return { lead, items, trailer: trimBlank(trailer) };
}

export function upNextItems(doc) {
  const s = sections(doc).find((x) => x.heading && same(x.heading, 'Up next'));
  return s ? parseUpNext(s.lines).items : [];
}

export function setSection(doc, heading, body) {
  const text = String(body).trim().split('\n');
  if (text.some((l) => /^## /.test(l))) throw new Error('A section body cannot contain a line starting with "## "');
  const all = sections(doc);
  const block = [`## ${heading}`, ...text];
  const at = all.findIndex((x) => x.heading && same(x.heading, heading));
  if (at >= 0) all[at] = { heading, lines: block };
  else {
    const before = ['Up next', 'Resume Prompt'].map((h) => all.findIndex((x) => x.heading && same(x.heading, h))).find((i) => i >= 0);
    all.splice(before ?? all.length, 0, { heading, lines: block });
  }
  return rebuild(all.map((x) => x.lines));
}

// Replaces the items and keeps the section's lead-in above them and its trailer below. With no
// items the section stays only if it holds lead-in or trailer text.
export function setUpNext(doc, items) {
  const clean = items.map((i) => String(i).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = sections(doc);
  const at = all.findIndex((x) => x.heading && same(x.heading, 'Up next'));
  if (at < 0) return clean.reduce((d, item) => addUpNext(d, item), String(doc));
  const { lead, trailer } = parseUpNext(all[at].lines);
  const body = clean.length ? [...lead, ...clean.map((i) => `- ${i}`)] : trimBlank(lead);
  const kept = [...body, ...(body.length && trailer.length ? [''] : []), ...trailer];
  if (!trimBlank(kept).length) return rebuild(all.filter((_, i) => i !== at).map((x) => x.lines));
  all[at] = { heading: 'Up next', lines: ['## Up next', ...kept] };
  return rebuild(all.map((x) => x.lines));
}
