#!/usr/bin/env node
// Compress a mailbox window into tags, so code can query what only prose held.
//
// A cheap judgement model like Jev fits two jobs: surfacing candidates in a body too large to read,
// and compressing many semi-structured fields into a few typed tags. This is the second, and the
// stronger of the two: many semi-structured fields reduced to a few typed columns. An email's subject and snippet carry meaning no column holds, so
// nothing downstream can filter on it. Eight nouls turn each message into eight numbers that sort,
// group and go in a WHERE clause.
//
// ⚠ THIS SENDS EMAIL CONTENT TO A THIRD PARTY (OpenRouter, then TypeSafe). Sender, subject and
// snippet leave the machine. That is fine for the author's own mailbox, an explicit
// decision made on 2026-09-22. It is NOT fine for anything with work or customer data in it, per AGENTS.md:
// customer PII never leaves the machine. The tag mode reads a pipe and cannot know which mailbox
// it came from, so check what you are piping in. The search mode runs postman itself, so it knows
// the identity and refuses `work` (the work mailbox) in code before anything is read or sent. A
// search over work mail stops at `postman search`, run by hand.
//
// Usage:
//   python postman.py inbox <identity> --days 30 --json | node jevmail.mjs      (tag a window)
//   node jevmail.mjs --in window.json --json tags.json
//   node jevmail.mjs --ask "<plain-English ask>" --identity <id> --query "<gmail query>"
//   node jevmail.mjs --ask "<plain-English ask>" --identity <id> --from <addr|domain> [--days N]
//       [--top 5] [--json hits.json]                                             (search)
//   node --test jevmail.test.mjs
//
// Search narrows first, server-side: --query runs `postman search` (X-GM-RAW, the newest 40 hits,
// Date, From, Subject and URLs but no body), --from runs `postman inbox --from --json` (one
// sender's slice, with a 2000-character text snippet). Then one Jev call per message scores the
// message and each of its links and passages against the ask, and prints a ranked shortlist.
// Jev generates no text, so it picks among the parts it is shown and never writes an answer.
//
// Deliberately NOT a generic engine. One chunker that knows what an email is, questions written
// out below. The generic version was specced (docs/superpowers/specs/2026-09-22-jevchecker-design.md)
// and dropped until a second real sweep exists to extract it from: every chunker strategy in that
// spec was a guess, and guessing structure before measuring is exactly what went wrong with the
// job-board scoring coefficients the same day.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CONCURRENCY, askJev, firedTags, isMain, noulsFrom, parseArgs, readKey, runPool, runSelftest } from './lib.mjs';

// The tag vocabulary. Adding one is nearly free (12 questions cost the same as 1, measured), so the
// bar for including a tag is whether anything would ever filter on it, not what it costs.
//
// ⚠ A tag nobody writes here stays invisible. Jev answers what it is asked and generates no text,
// so it cannot discover that a category was missing. When a sweep keeps surfacing something these
// eight do not name, add a ninth rather than reading around it.
export const TAGS = {
  is_rejection: 'This message tells the applicant they were not selected',
  is_interview_invite: 'This message invites the applicant to an interview or a call',
  is_assessment: 'This message asks the applicant to complete a test, take-home or assessment',
  is_recruiter_outreach: 'This is a recruiter approaching the applicant about a role, unprompted',
  is_from_agency: 'The sender is a recruitment agency or staffing firm rather than the hiring employer',
  // ⚠ BOTH OF THESE WERE REWORDED 2026-09-22 after the first live sweep, and the originals are the
  // worked example of how a tag goes wrong. 391 messages, 30-day window of a job-hunt mailbox:
  //
  //   is_automated: 'an automated or no-reply message rather than one a person wrote'  → fired 97%
  //   needs_reply:  'asks the applicant a question or requests an action from them'    → fired 92%
  //
  // Neither answer was wrong. A job-hunt mailbox really is 97% automated, and a LinkedIn alert
  // really does request an action ("apply to these"). They were USELESS, which is a different
  // failure: a tag that fires on almost everything cannot filter anything, and 352 messages came
  // back tagged both automated and needing a reply, which is a contradiction no downstream query
  // can act on.
  //
  // The fix in both cases is to make the RARE case the firing case, and to name the concrete
  // situation rather than the abstract property. Check a new tag's fire rate before trusting it:
  // above ~85% or below ~0.5% it is carrying no information whatever its precision looks like.
  is_personally_written: 'A person wrote this message specifically to this applicant, rather than it being generated by a system or sent to a list',
  needs_reply: 'A person is waiting for the applicant to write back to this particular message',
  mentions_compensation: 'This message states a salary, rate or compensation figure',
  // ADDED 2026-09-22, after the 40%-untagged warning below fired at 80% on the first clean sweep
  // and turned out to be right rather than a false alarm. 274 of the 313 untagged messages were
  // LinkedIn job alerts: a real category the vocabulary simply did not name. This is the failure
  // mode worth remembering — Jev cannot tell you a tag is missing, it can only fail to fire, so
  // the untagged pile is the only place that signal ever appears. Read it.
  is_job_listing_alert: 'This is an automated digest or alert advertising job openings, rather than correspondence about an application this applicant has made',
};

// A tag fires when its probability clears this. 0.5 is the honest default for a calibrated
// probability and nothing here has been tuned; treat a firing tag as a candidate to read, never as
// a fact. Same discipline as the jevchecker spec: signal, not verdict.
const FIRES_AT = 0.5;

// The snippet arrives as clean text and goes in as-is. It used to be raw quoted-printable HTML for
// 8% of a 2026-09-22 window, cut to 2000 bytes before any decoding, and was scrubbed here with
// toText(). postman now extracts the text before the cut (fixed in postman, lm-tools #6).

// What Jev judges. Sender, subject and the snippet, which is all postman's --json carries per
// message anyway. Not the thread_id or attribution: those are a downstream pipeline's own derived fields and
// feeding a pipeline's guesses back in as evidence is how a wrong attribution becomes
// self-confirming.
export function stateFor(m) {
  return `From: ${m.from ?? ''}\nDate: ${m.date ?? ''}\nSubject: ${m.subject ?? ''}\n\n${m.snippet ?? ''}`;
}

const questions = Object.fromEntries(
  Object.entries(TAGS).map(([id, instructions]) => [id, { type: 'noul', instructions }]));

// A missing answer is recorded as null rather than 0: absent and "definitely not" are different,
// and folding them together would let a partial response read as a clean negative.
export const toTags = (answers) => noulsFrom(answers, Object.keys(TAGS));
export const fired = (tags) => firedTags(tags, FIRES_AT);

async function ask(m, key) {
  const { answers, cost } = await askJev(stateFor(m), questions, key);
  return { tags: toTags(answers), cost };
}

// One call per email, not one call for the whole mailbox. An email is self-contained, and a single
// shared state would let message 7's questions be answered partly from message 3's text — Jev
// evaluates every question against the WHOLE state. Packing is right when chunks need a common
// source (a resume against its basis); it is wrong when they are independent.
//
// A row that already carries tags came from an earlier run's tags file and is kept as it is, so
// feeding that file back in re-asks only the rows that failed.
export const sweep = (messages, key, onDone) => runPool(messages, async (m) => {
  if (m.tags) return m;
  const { error: _old, ...rest } = m;
  try {
    const { tags, cost } = await ask(rest, key);
    return { ...rest, tags, cost };
  } catch (e) {
    return { ...rest, tags: null, error: e.message };
  }
}, CONCURRENCY, onDone);

function report(rows) {
  const ok = rows.filter((r) => r.tags);
  const failed = rows.filter((r) => r.error);

  for (const r of ok) {
    const f = fired(r.tags);
    const who = String(r.from ?? '').slice(0, 34).padEnd(34);
    const subj = String(r.subject ?? '(no subject)').slice(0, 44).padEnd(44);
    console.log(`${who} ${subj} ${f.length ? f.map(([k, v]) => `${k} ${v}`).join(', ') : '(no tags)'}`);
  }

  // Per-tag counts, which is the point of the exercise: these are now countable.
  console.log('\n  tag                     fires   mean when fired');
  for (const id of Object.keys(TAGS)) {
    const vals = ok.map((r) => r.tags[id]).filter((v) => v !== null);
    const hits = vals.filter((v) => v >= FIRES_AT);
    const mean = hits.length ? hits.reduce((s, v) => s + v, 0) / hits.length : null;
    console.log(`  ${id.padEnd(22)} ${String(hits.length).padStart(5)}   ${mean === null ? '-' : mean.toFixed(2)}`);
  }

  const untagged = ok.filter((r) => fired(r.tags).length === 0).length;
  console.log(`\n  messages        ${ok.length}`);
  console.log(`  no tag fired    ${untagged}`);
  console.log(`  cost            $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(5)}`);
  if (failed.length) {
    console.log(`  failed          ${failed.length}  <- not judged. Write --json, then re-run with --in on that file to ask only these`);
    for (const f of failed.slice(0, 5)) console.log(`    ${String(f.subject).slice(0, 50)}: ${f.error}`);
  }
  // A high untagged count is the signal that the vocabulary is wrong, not that the mailbox is
  // quiet. Say so rather than leaving a number to interpret.
  if (ok.length && untagged / ok.length > 0.4) {
    console.log(`\n  ⚠ ${Math.round(untagged / ok.length * 100)}% of messages matched no tag. Either the window is`);
    console.log('    mostly noise, or TAGS is missing a category. Read a few of the untagged ones.');
  }
}

// ---- search mode ---------------------------------------------------------------------------

// ⚠ THE WORK MAILBOX NEVER REACHES OPENROUTER. It holds customer PII, and every message this mode
// judges is posted to a third party. Checked first, before postman runs or a key is read, so a
// refused search has read nothing and sent nothing. By name, because postman resolves an identity
// by exact key and has no aliases.
const REFUSED_IDENTITIES = new Set(['work']);
export function checkIdentity(identity) {
  const id = String(identity ?? '').trim();
  if (!id) throw new Error('--identity is required. Search never picks a mailbox by default.');
  if (REFUSED_IDENTITIES.has(id.toLowerCase())) {
    throw new Error(`refusing identity '${id}': it holds customer data and this mode posts mail to `
      + 'OpenRouter. Run `postman search` by hand instead. Nothing was read or sent.');
  }
  return id;
}

// postman.py comes from postman's own install, never a sibling folder: an installed jevtools has
// no postman beside it (#126). POSTMAN_PY first, then the newest postman in a Claude Code or Codex
// plugin cache (<config>/plugins/cache/<marketplace>/postman/<version>/). Resolved when a search
// runs, so tag mode and a refused identity never look.
const POSTMAN_PY = ['skills', 'postman', 'postman.py'];
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const subdirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
// Numeric segments, so 1.1.10 beats 1.1.9. A folder with no number sorts below every version.
const versionKey = (v) => (String(v).match(/\d+/g) ?? []).map(Number);
const byVersion = (a, b) => {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  return 0;
};

export function findPostman({ env = process.env, home = os.homedir() } = {}) {
  if (env.POSTMAN_PY) {
    if (isFile(env.POSTMAN_PY)) return env.POSTMAN_PY;
    throw new Error(`POSTMAN_PY is set to ${env.POSTMAN_PY}, which is not a file.`);
  }
  const configs = [...new Set([env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), env.CODEX_HOME || path.join(home, '.codex')]
    .filter(Boolean).map((d) => path.resolve(d)))];
  const found = [];
  for (const config of configs) {
    const cache = path.join(config, 'plugins', 'cache');
    for (const market of subdirs(cache)) {
      const plug = path.join(cache, market, 'postman');
      for (const version of subdirs(plug)) {
        const p = path.join(plug, version, ...POSTMAN_PY);
        if (isFile(p)) found.push({ p, version });
      }
    }
  }
  found.sort((a, b) => byVersion(b.version, a.version));
  if (found.length) return found[0].p;
  throw new Error('search needs the postman plugin, which is not installed. Install it with '
    + '`/plugin install postman@logical-tools` (Claude Code) or `codex plugin add postman@logical-tools` '
    + '(Codex), or set POSTMAN_PY to a postman.py. Nothing was read or sent.');
}

// --query is Gmail's own search (X-GM-RAW). --from is one sender's slice with text snippets.
export function postmanArgs({ identity, query, from, days }) {
  if (!query === !from) throw new Error('give exactly one of --query "<gmail query>" or --from <addr>');
  if (query) return ['search', identity, query];
  return ['inbox', identity, '--json', '--from', from, ...(days ? ['--days', String(days)] : [])];
}

// Same shape as the other postman callers: stderr inherited so postman's own errors show, 2 = credentials and
// 1 = IMAP carried on the thrown error's status.
const runPostman = (args) => execFileSync('python', [findPostman(), ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
});

// `postman search` output: a `[n/K] Date | From | Subject` line per hit, its URLs indented under
// it. A fetch-failed line has no ` | ` and opens no message, so URLs after it attach to nothing.
// ponytail: a display name holding " | " shifts part of it into the subject. Ask postman for a
// --json search output if that ever bites.
export function parseSearch(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const hit = line.match(/^\[\d+\/\d+\] (.*)$/);
    if (hit) {
      const [date, from, ...rest] = hit[1].split(' | ');
      cur = rest.length ? { date, from, subject: rest.join(' | '), snippet: '', urls: [] } : null;
      if (cur) out.push(cur);
    } else if (cur && /^ {4}\S/.test(line)) {
      cur.urls.push(line.trim());
    }
  }
  return out;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const PASSAGE_CHARS = 300;
// ponytail: a tracking-heavy mail can carry more links than this, and the rest are not asked.
// The count of dropped parts is kept on the row. Split into two calls if a real hit is ever lost.
export const MAX_PARTS = 40;
// A narrowing step that still returns more than this has not narrowed. Refused before any call.
export const MAX_MESSAGES = 60;

// The candidates Jev picks among: prose passages first (a 2000-character snippet makes at most
// about eight), then every distinct link.
export function partsFor(m) {
  const snippet = String(m.snippet ?? '');
  const urls = [...new Set([...(m.urls ?? []), ...(snippet.match(URL_RE) ?? [])])];
  const passages = [];
  for (const s of snippet.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)) {
    if (!s) continue;
    if (passages.length && passages.at(-1).length + s.length < PASSAGE_CHARS) passages[passages.length - 1] += ` ${s}`;
    else passages.push(s);
  }
  const all = [...passages, ...urls];
  return { parts: all.slice(0, MAX_PARTS), dropped: Math.max(0, all.length - MAX_PARTS) };
}

// The mail is untrusted. A `[p3]` written into it would point a question at the wrong part, the
// same attack jevchecker's deforge closes for `[cN]`.
const unmark = (t) => String(t ?? '').replace(/\[\s*p\d+\s*\]/gi, '(marker removed)');
export function searchStateFor(m, parts) {
  return `From: ${unmark(m.from)}\nDate: ${unmark(m.date)}\nSubject: ${unmark(m.subject)}\n\n`
    + `Parts of this message:\n${parts.map((p, i) => `[p${i}] ${unmark(p)}`).join('\n')}`;
}

export function searchQuestions(ask, n) {
  const q = { message: { type: 'noul', instructions: `This message contains what the person is looking for: ${ask}` } };
  for (let i = 0; i < n; i++) {
    q[`p${i}`] = { type: 'noul', instructions: `For the part marked [p${i}]: this link or passage is what the person is looking for: ${ask}` };
  }
  return q;
}

const byScore = (a, b) => (b.score ?? -1) - (a.score ?? -1);

// Narrow with postman, then one call per message, ranked. `run` is the postman call, replaced in
// the tests so nothing touches a mailbox.
export async function searchMail({ ask, identity, query, from, days }, { key, run = runPostman, onDone } = {}) {
  const id = checkIdentity(identity);
  if (!String(ask ?? '').trim()) throw new Error('--ask needs the plain-English question');
  const args = postmanArgs({ identity: id, query, from, days });
  const raw = run(args);
  const messages = query ? parseSearch(raw) : JSON.parse(raw);
  if (messages.length > MAX_MESSAGES) {
    throw new Error(`${messages.length} messages matched, over ${MAX_MESSAGES}. Narrow the query. Nothing was sent.`);
  }
  const rows = await runPool(messages, async (m) => {
    const { parts, dropped } = partsFor(m);
    const base = { from: m.from, date: m.date, subject: m.subject, dropped };
    try {
      const { answers, cost } = await askJev(searchStateFor(m, parts), searchQuestions(ask, parts.length), key);
      const s = noulsFrom(answers, ['message', ...parts.map((_, i) => `p${i}`)]);
      return { ...base, score: s.message, parts: parts.map((text, i) => ({ text, score: s[`p${i}`] })).sort(byScore), cost };
    } catch (e) {
      return { ...base, score: null, parts: [], error: e.message };
    }
  }, CONCURRENCY, onDone);
  return rows.sort(byScore);
}

function reportSearch(rows, top) {
  const ok = rows.filter((r) => !r.error);
  const cleared = ok.filter((r) => r.score !== null && r.score >= FIRES_AT).length;
  console.log(`judged ${ok.length} messages, ${cleared} cleared ${FIRES_AT}, `
    + `cost $${ok.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(5)}\n`);
  for (const r of ok.slice(0, top)) {
    console.log(`${r.score === null ? '  - ' : r.score.toFixed(2)}  ${r.date ?? ''} | ${r.from ?? ''} | ${r.subject ?? ''}`);
    for (const p of r.parts.filter((p) => p.score !== null && p.score >= FIRES_AT).slice(0, 3)) {
      console.log(`      ${p.score.toFixed(2)}  ${p.text.length > 200 ? `${p.text.slice(0, 200)}...` : p.text}`);
    }
    if (r.dropped) console.log(`      (${r.dropped} parts not asked, over the ${MAX_PARTS} cap)`);
  }
  const failed = rows.filter((r) => r.error);
  if (failed.length) {
    console.log(`\n  failed ${failed.length}`);
    for (const f of failed.slice(0, 5)) console.log(`    ${String(f.subject).slice(0, 50)}: ${f.error}`);
  }
  console.log('\nA score is a signal, not a verdict. Open the message before acting on it.');
}

async function main(argv) {
  const { opt, flag } = parseArgs(argv);
  if (flag('selftest')) return runSelftest(new URL('./jevmail.test.mjs', import.meta.url));

  if (flag('ask')) {
    try {
      checkIdentity(opt('identity'));       // first, so a refused search never needs a key either
      const key = readKey();
      if (!key) throw new Error('no OPENROUTER_API_KEY in the environment or ~/.jev.env.');
      const rows = await searchMail(
        { ask: opt('ask'), identity: opt('identity'), query: opt('query'), from: opt('from'), days: opt('days') },
        { key, onDone: (done, total) => console.error(`  [${done}/${total}]`) });
      reportSearch(rows, Number(opt('top') ?? 5));
      if (opt('json')) {
        fs.writeFileSync(opt('json'), JSON.stringify(rows, null, 2));
        console.log(`hits written to ${opt('json')}`);
      }
    } catch (e) {
      console.error(`jevmail: ${e.message}`);
      // ⚠ exitCode, never process.exit(), after a network call. A socket from the calls above may
      // still be closing, and on Windows process.exit() then aborts in libuv and ends 127 (measured
      // in jevclick, 2026-09-22). postman's 2 = credentials, carried through.
      process.exitCode = e.status === 2 ? 2 : 1;
    }
  } else {
    // Tag mode. Its process.exit calls all come before any socket opens.

    const raw = opt('in') ? fs.readFileSync(opt('in'), 'utf8') : fs.readFileSync(0, 'utf8');
    const messages = JSON.parse(raw);
    if (!Array.isArray(messages)) {
      console.error('expected the JSON array from `inbox.py <identity> --json`');
      process.exit(1);
    }

    const key = readKey();
    if (!key) {
      console.error('no OPENROUTER_API_KEY in the environment or ~/.jev.env (see jevtools/README.md)');
      process.exit(1);
    }

    console.log(`sweeping ${messages.length} messages, ${CONCURRENCY} at a time\n`);
    let last = 0;
    const rows = await sweep(messages, key, (done, total) => {
      if (done - last >= 25 || done === total) { console.error(`  ${done}/${total}`); last = done; }
    });
    report(rows);
    if (opt('json')) {
      fs.writeFileSync(opt('json'), JSON.stringify(rows.map(({ cost, ...r }) => r), null, 2));
      console.log(`\ntags written to ${opt('json')}`);
    }
  }
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
