#!/usr/bin/env node
// UserPromptSubmit and PreToolUse Agent|Task: inject the runbooks this task needs.
//
// WHAT IT REPLACES. index.mjs distinguishes PULLED procedures (a slug routes you: you
// already know you are deploying the app) from PUSHED standards and references (nothing about the
// task says "read powershell.md first", so their purpose has to ride the index or they never fire).
// That pushed block reached 5.9KB in EVERY session, paid whether or not anything matched.
//
// A prompt is the thing that decides relevance, and SessionStart does not have one. So this runs on
// UserPromptSubmit, asks one Jev call whether each pushed runbook applies, and injects the matches.
//
// MEASURED 2026-09-22 (a one-call match probe): 67 runbooks as
// 67 Nouls in one call, 883ms, $0.0004. Self-eval over 12: 9/12 top-1, 12/12 in top-3, narrowing 67
// to a mean of 3.8. On "the nightly backup pruned nothing again" it returned exactly one hit.
//
// ⚠ FAIL LOUD, NOT FAIL OPEN. Changed 2026-09-22, and the old rule was the exact opposite, so read
// this before restoring it. No key, no network, a timeout, a bad response, a thrown error: every
// path injects a three-line notice that says routing is unavailable, says why, and says to read
// the runbooks folder directly. It used to emit the full index instead.
//
// WHY IT FLIPPED. That full index is 31,957 bytes, about 8,000 tokens, against the roughly 7,000
// the always-on arrangement this router replaced cost. So the fallback was more expensive than the
// problem, and one transient timeout wiped out a day of routing savings. The old rationale was that
// silently hiding a standard because an API blipped is worse than never having had the router. The
// notice answers that directly: nothing is hidden silently, the gap is named and the reader is told
// where to look, for about 250 bytes. Do not put the full-index fallback back.
//
// The single deliberate exception is a prompt under 12 characters, which injects nothing. That is
// not a failure, it is a continuation ("ok", "yes") inside a session that already routed the real
// task, and it is the difference between saving 35% of the old block and saving 89%.
//
// RETRY, ADDED 2026-09-22. A call costs about $0.0002, so a retry is free in money and expensive in
// the only currency that matters here: the user is sitting in front of their prompt waiting for it.
// So the bound is a total wall-clock budget, not a per-attempt timeout, and only the failures that
// could plausibly answer differently on a second try are retried at all. See TOTAL_BUDGET_MS and
// isRetryable below.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIndex, shortlist } from './prefilter.mjs';
import { settings, STATE_DIR } from './config.mjs';
import { DORMANT_RE, parseHeader, readInput, RETIRED_RE } from './index.mjs';
import { claimRunbooks, scopeOf } from './session.mjs';
import { isMain } from './lib/exit.mjs';

const HOME = os.homedir();
// Every prompt is posted here, with no customer-data screen.
const ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
const MODEL = 'jev-latest';
// THE BUDGET IS THE ONLY TIME CONSTANT. Measured call latency is 883 to 943ms. 4000ms over at most
// three attempts gives each one about 1.3s, roughly 40% headroom over the slowest measured call,
// and caps the worst case at 4s against the 3s a single attempt already cost. A per-attempt
// constant alongside this one would drift out of step with it, so each attempt takes what is left
// of the budget divided by the attempts still to come.
const TOTAL_BUDGET_MS = 4000;
const MAX_ATTEMPTS = 3;
// Flat, not exponential. Exponential backoff exists to stop a fleet of clients hammering a
// struggling service, and this is one call per prompt on one machine. Doubling here would only
// spend the budget waiting instead of calling, and the budget is 4 seconds in front of a human.
const RETRY_DELAY_MS = 100;
// RAISED 0.5 -> 0.8 on 2026-09-23, from 264 live firings in the transcripts. At 0.5
// the router never came back empty (jev scores an empty prompt at 0.48, see route()), it named 3.1
// documents a prompt, and the turn went on to touch one of them 2% of the time at 0.5-0.59, 7% at
// 0.6-0.69 and 5% at 0.7-0.79, against 35% at 0.8 and up. 0.8 cuts injected names from 809 to 26.
// It also drops 30 of the 39 low-score names a turn did touch, which was the accepted price.
// Exported for check.mjs, which grades runbook purpose lines against this same bar.
export const FIRES_AT = 0.8;
export const MAX_INJECT = 6;
// How many scores route() hands back beside its hits. resolve.mjs reads the top one to say how
// far under the bar a topic fell.
export const RANKED_N = 5;
// Runbook types worth pushing. A procedure is pulled by its slug and stays out.
// Procedures joined on 2026-09-22, and until then the router could not see one. That is why the
// 43-procedure block stayed in index.mjs at 2,973 tokens a session: a procedure is PULLED
// by name, and a slug only routes when the task happens to name the same noun. The 2026-08-17
// deploy task missed a container-networking runbook because it named the app rather than the
// mechanism.
//
// Gated on that exact case plus six more goal-worded tasks: 0 of 7 before, 6 of 7 after, that
// case among the hits. The 8 controls were compared on their FULL firing set rather than on the one
// document each names: no expected document lost, one
// incidental drop (a docker-networks runbook gave way to
// the container-networking runbook on a reverse-proxy prompt).
//
// Free in state size. Only standards bypass the shortlist, so these 47 compete for the same 30
// slots rather than adding to them.
export const RB_KEEP = new Set(['standard', 'reference', 'procedure']);
// A retired runbook is a tombstone. SessionStart names it once as "do not re-propose", and routing
// it would hand the session a dead process with a relevance score on it. A dormant runbook is a live
// process parked for now (2026-09-24): it never routes either, and index.mjs
// gives it no tombstone, which is the whole difference from retired. Both are read by index.mjs's
// own RETIRED_RE and DORMANT_RE, so a malformed retirement routes here exactly as the lint flags it.
const isParked = (status) => RETIRED_RE.test(status ?? '') || DORMANT_RE.test(status ?? '');

// index.mjs's parseHeader, so the router and the index agree on what a runbook says: the header
// inside its first 800 bytes, and a purpose on one physical line (the lint rejects a wrapped one).
// Verified keeps only its date, so a trailing note cannot turn the age into "never verified".
export function parse(text, file) {
  const h = parseHeader(text);
  return { file, type: h.type, purpose: h.purpose, status: h.status,
    verified: h.verified?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null };
}

// Directories never walked. archive/ holds facts that were deliberately superseded, and routing one
// would hand the session a dead fact with a relevance score on it. retired/ holds tombstones the
// same way. .git is the store's own history: 277 of the 291 directories the walk used to enter,
// measured 2026-09-29, and skipping it took loadAll from 33 to 45 ms down to 15 to 18 ms.
const SKIP_DIRS = new Set(['archive', 'retired', '.git']);

export function loadCorpus(root, parseFn, keep) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); }
      else if (e.name.endsWith('.md')) {
        const r = parseFn(fs.readFileSync(p, 'utf8'), path.relative(root, p));
        if (isParked(r.status)) continue;
        if (r.type && r.purpose && keep.has(r.type)) out.push(r);
      }
    }
  };
  try { walk(root); } catch { return []; }
  return out;
}

// A second corpus of notes existed until 2026-09-23, when its notes moved into the runbooks folder.
export const loadAll = (dir = settings({ cwd: process.cwd() }).dir) => dir ? loadCorpus(dir, parse, RB_KEEP) : [];

// Takes the entry, not the filename. The `rb_` is left over from two corpora and kept so the
// keys in the recorded run files still read the same.
export const keyFor = (e) => 'rb_' + e.file.replace(/[^a-z0-9]+/gi, '_').toLowerCase();

export function buildQuestions(books) {
  return Object.fromEntries(books.map((b) => [keyFor(b), {
    type: 'noul',
    instructions: `Before starting this task, the person should read a ${b.type} whose purpose is: ${b.purpose}`,
    // criteria, because they are the accuracy, not decoration: dropping them scored 4 of the 8
    // named cases against 8 of 8 with them, measured at this corpus size in
    // the router's criteria probe (run1). They are also the single largest thing in the request,
    // one identical copy per question, so what stays here is paid 179 times on every prompt.
    //
    // Each pole is ONE clause, and both were cut from a longer version by DELETING its second
    // clause rather than rewriting it. That distinction cost a run to learn: a reworded short
    // version lost a case and pushed every score down 0.12 to 0.18, while these two deletions
    // scored at or above the long version on 7 of 8 cases across two runs (run2, run3) and saved
    // 20,406 bytes a call, 20% of the whole request. Shorten further by deleting, never by
    // paraphrasing, and re-run the probe.
    //
    // The poles separate "in this subject area" from "shares vocabulary".
    criteria: {
      true: 'The task is squarely within what that document governs',
      false: 'The task is in a different area, or only shares vocabulary with that document',
    },
  }]));
}

// What a failure injects instead of the index. Written for a model that will act on it: what is
// broken, why, and the one thing to do about it. Nothing else belongs here, because every line
// added is paid on every failure.
// The attempt count rides along so the reader can tell a one-off blip from a hard outage: one
// attempt means the failure was not worth retrying, three means it was and none of them worked.
export function failNotice(why, attempts = 1) {
  const tried = `${attempts} attempt${attempts === 1 ? '' : 's'}`;
  return `Runbook routing is unavailable (${why}, ${tried}), so no procedure, standard or reference `
    + 'was matched to this prompt.\n'
    + 'Treat the absence as unknown, not as "nothing applies".\n'
    + 'If this task touches a procedure, a standard or a stored fact, read the runbooks folder '
    + 'directly before starting.';
}

// LOUD FAILURES. The notice above reaches only the model, which reads past it, so a missing key
// once left a whole device without routing for a day. A failure no retry or wait can fix (no key,
// a rejected key, no credits) also goes to the user as a systemMessage on every prompt until fixed.
// Transient failures stay quiet: the outage breaker already handles them.
export const isLoud = (why) => why === 'no key' || /^http 40[123]$/.test(String(why));
export function loudMessage(why) {
  const fix = why === 'no key'
    ? 'set OPENROUTER_KEY_RUNBOOKS in ~/.jev.env or the environment'
    : 'check the OpenRouter key and its credits';
  return `Runbook routing is down (${why}): no runbooks reach this session until you ${fix}.`;
}

// Freshness. The age rides the injected line only. The model never sees it, so routing scores
// cannot move.
export const STALE_DAYS = 30;
export const STALE_LINE = `A runbook verified over ${STALE_DAYS} days ago, or never: before acting on one of its facts, `
  + 'check that fact against the live system, fix the runbook if it is wrong, and set Verified to today.';
// A missing or invalid date (2026-13-45 parses to NaN) reads as never verified.
const daysSince = (d, now) => (d ? Math.floor((now - new Date(`${d}T00:00:00Z`)) / 86_400_000) : NaN);
export function ageLabel(verified, now = new Date()) {
  const d = daysSince(verified, now);
  if (Number.isNaN(d)) return 'never verified';
  return d <= 0 ? 'verified today' : `verified ${d} day${d === 1 ? '' : 's'} ago`;
}

export function matchedBlock(hits, now = new Date()) {
  if (!hits.length) return '';
  // NaN fails every comparison, so a missing or invalid date counts as stale here.
  const stale = hits.some((h) => !(daysSince(h.verified, now) <= STALE_DAYS));
  return 'Runbooks matched to this task (read before starting):\n'
    + hits.map((h) => `- ${h.file.replace(/\.md$/, '')} (${h.type}, `
      + `${h.p.toFixed(2)}, ${ageLabel(h.verified, now)}) — ${h.purpose}`).join('\n')
    + (stale ? `\n${STALE_LINE}` : '');
}

// The Codex contract, as a function so the selftest checks the field names the hook actually
// emits rather than a copy retyped beside them. Codex ignores stdout that is not this shape,
// and ignores it without a word, so a typo here is a router that appears to match nothing.
export const codexEnvelope = (text) => ({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
});

// ~/.jev.env is the canonical home, shared with jevtools. The match and the lookup order are
// jevtools/scripts/lib.mjs's: anchored to the line start so a commented old line cannot win, a shell
// `export` prefix allowed, one pair of surrounding quotes stripped (left in, they give a 401 on every
// prompt), and OPENROUTER_KEY_<CONSUMER> (here RUNBOOKS) before the legacy shared OPENROUTER_API_KEY.
export function readKey(env = process.env, file = path.join(HOME, '.jev.env'), consumer = 'RUNBOOKS') {
  const own = `OPENROUTER_KEY_${consumer}`;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* not there, and a missing file is a fallback, never an error */ }
  for (const name of [own, 'OPENROUTER_API_KEY']) {
    if (env[name]) return env[name];
    const m = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`, 'm'));
    const v = m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
    if (v) return v;
  }
  return null;
}

// ⚠ WHICH FAILURES ARE WORTH A SECOND CALL. Spelled out rather than implied, because the obvious
// "simplification" is to retry everything, and everything is the wrong set. A missing key, a 4xx
// that is not 429, and a 200 whose body has no answers all fail identically on the next call: the
// retry buys nothing and spends a second of the user's waiting time to reach the same notice.
// A timeout, a 5xx, a thrown network error and a 429 are the ones a second call can answer.
export const isRetryable = (r) => r.thrown === true || r.why === 'timeout' || r.why === 'http 429'
  || /^http 5\d\d$/.test(r.why);

// ⚠ THE OUTAGE BREAKER. A dead endpoint used to cost the whole 4 s budget on every prompt. Now a
// full failure on a retryable reason writes the time to OUTAGE_LOG, and for OUTAGE_MS after it the
// hook injects the notice without calling. A bad key or a bad request never trips it: those fail
// in one fast call, so there is no latency to save and a real fix to surface.
// ponytail: a fixed window, not a half-open probe. The first prompt after it pays the budget again
// if the API is still down. Add a probe if outages are ever measured to outlast a minute often.
export const OUTAGE_LOG = path.join(STATE_DIR, 'outage.json');
export const OUTAGE_MS = 60_000;
export const tripsBreaker = (r) => r.mode === 'fallback' && r.attempts > 0 && isRetryable(r);
// A marker from the future is a clock step, and reads as no marker rather than a long outage.
export const breakerOpen = (prev, now, windowMs = OUTAGE_MS) =>
  Number.isFinite(prev?.t) && now >= prev.t && now - prev.t < windowMs;
export function readOutage(file = OUTAGE_LOG) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
export function markOutage(file = OUTAGE_LOG, t = Date.now()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ t }));
  } catch { /* a marker is never worth failing a prompt over */ }
}

// One call. Returns the matched block, or the reason it failed for route to classify and count.
// What every call actually cost, from the API's own usage block rather than a price table. Written
// because every monthly figure this project has quoted came from a projection, and two of them were
// wrong: the volume was last read off a code comment and the per-call cost did not reproduce.
// One compact receipt per API attempt. Live routing and purpose-line tests share a journal but
// carry different activity labels. A failed call with no usage has null cost, never an invented 0.
// Keep the journal outside the repo and AppData: both harnesses can read it, and Codex-created
// files under AppData can land in the packaged app's private cache on Windows.
export const SPEND_LOG = path.join(HOME, '.local', 'state', 'jev-spend', 'calls.jsonl');
const SPEND_RUN = crypto.randomUUID();
const spendNumber = (v) => v === null || v === undefined || v === '' || !Number.isFinite(Number(v))
  ? null : Number(v);
function meter(usage, asked, fired, spend, status = 'ok') {
  if (process.env.JEV_SPEND_DISABLED === '1') return;
  if (!usage && !spend) return;
  const row = { t: new Date().toISOString(), tool: 'runbooks',
    activity: spend?.activity ?? 'unclassified',
    session: spend?.session || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID
      || process.env.CLAUDE_CODE_SESSION_ID || null,
    run: SPEND_RUN, target: spend?.target ?? null, status, model: MODEL,
    cost: spendNumber(usage?.cost), input_tokens: spendNumber(usage?.input_tokens),
    output_tokens: spendNumber(usage?.output_tokens), questions: asked, hits: fired };
  try {
    const file = process.env.JEV_SPEND_LOG || SPEND_LOG;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  } catch (error) { console.error(`runbooks: could not write Jev usage (${error.code || error.message})`); }
}

async function attempt(prompt, books, key, fetchImpl, timeoutMs, firesAt, maxInject, spend) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state: `A task is about to be started. The task: ${prompt}`,
        questions: buildQuestions(books) }),
    });
    if (!res.ok) { meter(null, books.length, 0, spend, 'unreported'); return { mode: 'fallback', why: `http ${res.status}` }; }
    const body = await res.json();
    if (!body?.answers) { meter(body?.usage, books.length, 0, spend, 'no_answers'); return { mode: 'fallback', why: 'no answers' }; }
    const scored = books.map((b) => ({ ...b, p: body.answers[keyFor(b)]?.noul ?? 0 }))
      .sort((x, y) => y.p - x.p);
    const hits = scored.filter((b) => b.p >= firesAt).slice(0, maxInject);
    meter(body.usage, books.length, hits.length, spend, body.usage ? 'ok' : 'unreported');
    return { text: matchedBlock(hits), mode: 'matched', hits: hits.length,
      files: hits.map((h) => h.file), ranked: scored.slice(0, RANKED_N).map(({ file, p }) => ({ file, p })) };
  } catch (e) {
    meter(null, books.length, 0, spend, 'unreported');
    // A thrown fetch is a network-level failure, which is retryable. The message still rides along
    // in the notice, because "network" alone does not tell the reader what broke.
    return e.name === 'AbortError'
      ? { mode: 'fallback', why: 'timeout' }
      : { mode: 'fallback', why: String(e.message).slice(0, 60), thrown: true };
  } finally { clearTimeout(timer); }
}

// How many documents BM25 hands to jev, on top of the standards that always ride along. Set from
// the WORST rank the probe measured (11 of 179 over eight prompts) with headroom, not tuned against
// those eight: a ninth prompt has to fit too. The router's levers probe (run2) holds the run.
// --- one prompt, one call ---
// This hook can be registered twice, in user settings and in project settings. Claude Code merges
// the two and runs the command once per registration, so every prompt was routed twice: double the
// bill, double the injected tokens, and a match block printed twice with the scores a drift apart.
// It ran a full day unnoticed, because a duplicated block reads exactly like a normal one.
//
// Neither registration can simply go. Each one covers sessions the other does not reach. So the
// guard lives here, where every copy routes through it.
// One file per session (#102). A single shared dedupe.json let another session's prompt overwrite
// the record between this session's two copies, so the second copy read as new and injected again.
export const DEDUPE_MS = 20_000;
// A session file older than this is from a session that is over. The first write in a session
// prunes them, and the legacy shared dedupe.json with them.
export const DEDUPE_KEEP_MS = 86_400_000;
const DEDUPE_NAME = /^dedupe(-[0-9a-f]{12})?\.json$/;
export const dedupeFile = (sessionId, dir = STATE_DIR) => path.join(dir,
  `dedupe-${crypto.createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 12)}.json`);
function pruneDedupe(dir, now) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!DEDUPE_NAME.test(name)) continue;
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > DEDUPE_KEEP_MS) fs.rmSync(file, { force: true });
    }
  } catch { /* pruning is housekeeping, never worth failing a prompt over */ }
}

// The written record, as its own function so the selftest checks the real field names rather than
// a literal retyped beside them. An output-redaction guard blocks a `key` holding 8+ opaque
// characters, and a sha1 under that name blocked two tool calls before the rename.
export const dedupeRecord = (promptHash, t) => ({ promptHash, t });

// Pure half, so the window is testable without touching a file. A repeat of the same text in the
// same session inside 20s is a second copy of this hook, not the user asking twice.
export function isDuplicate(promptHash, now, prev, windowMs = DEDUPE_MS) {
  return !!prev && prev.promptHash === promptHash && now - prev.t < windowMs;
}

// ponytail: last-write-wins on the session's file, not a lock. Two copies launched in the same
// millisecond could both read before either writes. The claim is staked BEFORE the ~380ms API call
// rather than after it, which leaves a window of microseconds against a gap of a third of a second.
// If Claude Code ever runs hook groups in true parallel, this needs an O_EXCL create instead.
export function claimPrompt(sessionId, prompt, { dir = STATE_DIR, now = Date.now() } = {}) {
  // Named promptHash, not key: an output-redaction guard blocks any `key` holding 8+ opaque
  // characters, and a sha1 under that name reads exactly like a leaked credential. It fired on
  // this file twice before the rename.
  const promptHash = crypto.createHash('sha1').update(`${sessionId}\0${prompt}`).digest('hex');
  const file = dedupeFile(sessionId, dir);
  let seen = false;
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    seen = true;
    if (isDuplicate(promptHash, now, prev)) return false;
  } catch { /* absent or corrupt reads as "not seen", which only ever costs one extra call */ }
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!seen) pruneDedupe(dir, now);
    fs.writeFileSync(file, JSON.stringify(dedupeRecord(promptHash, now)));
  } catch { /* never fail a prompt */ }
  return true;
}

export const SHORTLIST = 30;

// Narrow locally before spending a token. jev bills input, and the corpus IS the input, so the bill
// was linear in how many documents exist. It also has a wall: jev 1.13's window is 32K and the old
// call used 18,546 of it at 103.6 tokens a document, so the router stopped fitting at about 310
// documents. This is what keeps adding a runbook cheap instead of fatal.
//
// Every STANDARD rides along unconditionally, and that is not a safety blanket, it is the measured
// hole in a word-matcher. "I need the cloudflare api token to change a dns record" shares NOT ONE
// word with the secrets standard's purpose, so BM25 ranks it 57 of 179 while jev scores it 0.88 and puts
// it first. A standard is a rule you must not break, so they are never filtered out on vocabulary.
// That only stays cheap while the set is small: merging in a second corpus took it to 43 and the 2026-09-24
// review cut it back to 17 by retyping the references and procedures. Anything else earns its place
// lexically.
export function narrow(prompt, books, n = SHORTLIST) {
  if (books.length <= n) return books;
  const picked = new Set(shortlist(prompt, buildIndex(books), n).map((b) => b.file));
  return books.filter((b) => picked.has(b.file) || b.type === 'standard');
}

export async function route(prompt, books, key, fetchImpl = fetch, opts = {}) {
  const budgetMs = opts.budgetMs ?? TOTAL_BUDGET_MS;
  const delayMs = opts.delayMs ?? RETRY_DELAY_MS;
  // Config overrides ride in opts, so the exported constants check.mjs grades against stay put.
  const firesAt = opts.firesAt ?? FIRES_AT;
  const maxInject = opts.maxInject ?? MAX_INJECT;
  // No key means no call was made at all, and the notice says 0 attempts rather than inventing one.
  if (!key) return { text: failNotice('no key', 0), mode: 'fallback', why: 'no key', attempts: 0 };
  // ⚠ Never send a near-empty state: given nothing to read Jev answers from a prior (measured mean
  // 0.48 on an empty string), so a one-word prompt would produce confident matches.
  //
  // A short prompt injects NOTHING, and this is the one place that deliberately returns less than
  // the old routing. It is not a failure path. "ok" is a continuation inside a session that already
  // routed the real task a few turns back, so the standards it needed are already in context.
  // Measured 2026-09-22: 48 of 198 prompts that day were under 12 chars, ten of them literally
  // "ok", and falling back on each one cost 83k tokens, 83% of the router's entire daily spend.
  if (String(prompt ?? '').trim().length < 12) {
    return { text: '', mode: 'skipped', why: 'short prompt' };
  }
  // The breaker, open. After the short-prompt skip, so a continuation still injects nothing.
  if (opts.skipApi) return { text: failNotice(opts.skipApi, 0), mode: 'fallback', why: opts.skipApi, attempts: 0 };
  // After the short-prompt skip, so a prompt that injects nothing never pays to be indexed.
  books = opts.narrow === false ? books : narrow(prompt, books, opts.shortlist ?? SHORTLIST);
  const deadline = Date.now() + budgetMs;
  let n = 0;
  for (;;) {
    n += 1;
    // Each attempt gets an equal share of what is left, so a slow first call cannot eat the whole
    // budget and leave the retries no room. This IS the per-attempt timeout, derived not declared.
    const slice = Math.max(1, Math.floor((deadline - Date.now()) / (MAX_ATTEMPTS - n + 1)));
    const r = await attempt(prompt, books, key, fetchImpl, slice, firesAt, maxInject, opts.spend);
    if (r.mode === 'matched') return { ...r, attempts: n };
    if (!isRetryable(r) || n >= MAX_ATTEMPTS || Date.now() + delayMs >= deadline) {
      return { text: failNotice(r.why, n), mode: 'fallback', why: r.why, attempts: n };
    }
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
  }
}

// --- hook entry ---
// Only run the hook when this file IS the command. An import wants the exports, not a stdin read.
// isMain (lib/exit.mjs) compares real paths, so a junctioned plugin cache still runs main().
// The selftest lives in test/router.test.mjs now (#37). `--selftest` is still named in runbooks, so
// it runs that file. NODE_TEST_CONTEXT is dropped so a run started inside a test runner reports as
// its own.
if (isMain(import.meta.url) && process.argv.includes('--selftest')) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', fileURLToPath(new URL('../test/router.test.mjs', import.meta.url))],
    { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}
if (isMain(import.meta.url)) {
  // index.mjs's read, with its 500 ms deadline. `for await` over stdin waited for an EOF that a
  // caller holding the pipe open never sends, and the hook hung until the harness killed it.
  const input = await readInput();
  const agent = process.argv.includes('--agent');
  const json = process.argv.includes('--json');
  // PreToolUse sees the parent's session, before the child has an agent_id. Append to the
  // dispatch brief itself: additionalContext here would go to the parent, not the child.
  const field = json ? 'message' : 'prompt';
  if (agent && (!['Agent', 'Task', 'spawn_agent'].includes(input?.tool_name)
    || typeof input?.tool_input?.[field] !== 'string' || !input.tool_input[field].trim())) process.exit(0);
  const prompt = agent ? input.tool_input[field] : typeof input.prompt === 'string' ? input.prompt : '';
  const sessionId = input.session_id ?? '';
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();

  // No runbooks folder: silent, and before the dedupe claim so a repo without runbooks writes nothing.
  // ponytail: settings() spawns git rev-parse, so a duplicate copy pays that spawn before it exits.
  // The first copy needs the folder to route at all, so moving it after the claim spares only the
  // duplicate. Cache the git top per cwd in STATE_DIR if the spawn is ever measured to matter.
  const cfg = settings({ cwd: cwd || process.cwd() });
  if (!cfg.dir) process.exit(0);

  // Second copy of this hook on the same prompt. Exit before the API call, not after it.
  // Each child needs its own context, even with the same brief as the parent or another child.
  // A tool id dedupes duplicate registrations for ONE dispatch. Without one, route every child.
  const dedupeScope = agent
    ? (sessionId && input.tool_use_id ? `${sessionId}\0dispatch\0${input.tool_use_id}` : null)
    : sessionId;
  if (prompt && dedupeScope !== null && !claimPrompt(dedupeScope, prompt)) process.exit(0);

  const books = loadAll(cfg.dir);
  if (!books.length) process.exit(0);
  const prev = readOutage();
  const skipApi = breakerOpen(prev, Date.now())
    ? `the API failed at ${new Date(prev.t).toISOString().slice(11, 19)} UTC, calls paused ${OUTAGE_MS / 1000} s` : null;
  const r = await route(prompt, books, readKey(), fetch,
    { firesAt: cfg.firesAt, maxInject: cfg.maxInject, shortlist: cfg.shortlist, skipApi,
      spend: { activity: 'active_route', session: sessionId } });
  if (tripsBreaker(r)) markOutage();
  // So the skill and action triggers do not hand this conversation the same runbook again.
  // The future child's id is unknown here; recording this in the parent's ledger would wrongly
  // suppress runbooks the parent has never received. Child skill/action hooks keep their own scope.
  if (!agent && r.files?.length) claimRunbooks(scopeOf(input), r.files);
  const { text, mode, why, hits, attempts } = r;
  // Claude Code takes plain stdout as context. Codex reads only the JSON envelope and drops
  // anything else on the floor, silently, which looks exactly like a router that found no match.
  // Same routing, same corpus, one flag: --json is the whole Codex port.
  // ponytail: Claude Code prompts only. Codex (--json) and subagent dispatches keep their quiet
  // shapes; the parent prompt has already warned. Add systemMessage there if Codex is seen to show it.
  if (text && !agent && !json && mode === 'fallback' && isLoud(why)) {
    console.log(JSON.stringify({ systemMessage: loudMessage(why),
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
  } else if (text) console.log(agent ? JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    // Codex requires allow alongside updatedInput. Claude accepts the rewrite independently,
    // so leave its permission evaluation untouched.
    ...(json ? { permissionDecision: 'allow' } : {}),
    updatedInput: { ...input.tool_input, [field]: `${prompt}\n\n${text}` },
  } }) : json ? JSON.stringify(codexEnvelope(text)) : text);
  // One line so a fallback is visible rather than silent: if this says "fallback" every time, the
  // router is costing latency and buying nothing. It prints even when the injection is empty,
  // because a zero-hit result is still a call that happened and still cost the attempts it names.
  //
  // ⚠ THE ATTEMPT NUMBER IS NOT DECORATION. A retry that succeeds quietly is how a degrading API
  // keeps looking healthy until it stops working entirely. If "(attempt 2)" starts appearing on
  // ordinary prompts, the endpoint is failing most of the time and the router is paying a second
  // of latency per prompt to hide it.
  if (mode !== 'skipped') {
    console.error(mode === 'matched'
      ? `runbooks: ${hits} matched${attempts > 1 ? ` (attempt ${attempts})` : ''}`
      : `runbooks: fallback (${why}, ${attempts} attempt${attempts === 1 ? '' : 's'})`);
  }
}
