// jevmail's offline tests, moved out of the script's --selftest branch. The model call is mocked by
// replacing `fetch`, as lib.test.mjs does, and the postman call by the injected `run`. Invented data only.
import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTEMPTS } from './lib.mjs';
import { MAX_MESSAGES, MAX_PARTS, TAGS, checkIdentity, findPostman, fired, parseSearch, partsFor, postmanArgs, searchMail,
  searchStateFor, stateFor, sweep, toTags } from './jevmail.mjs';

const JEVMAIL = fileURLToPath(new URL('./jevmail.mjs', import.meta.url));

test('tags: a missing answer is null, and the state carries only the judged fields', () => {
  // A missing answer is null, never 0 — otherwise a partial response reads as a clean negative.
  assert.strictEqual(toTags({}).is_rejection, null);
  assert.strictEqual(toTags({ is_rejection: {} }).is_rejection, null);
  assert.strictEqual(toTags({ is_rejection: { noul: 0 } }).is_rejection, 0);
  // Every tag is present in the output even when the answer set is partial, so a consumer can rely
  // on the shape.
  assert.deepStrictEqual(Object.keys(toTags({})), Object.keys(TAGS));
  // Rounding to 2dp, because a noul of 0.8300000000000001 in a report is noise.
  assert.strictEqual(toTags({ needs_reply: { noul: 0.834 } }).needs_reply, 0.83);
  // The threshold is inclusive at the boundary, and a null never fires.
  assert.deepStrictEqual(fired({ a: 0.5, b: 0.49, c: null }).map(([k]) => k), ['a']);
  // Fired tags come back strongest first.
  assert.deepStrictEqual(fired({ a: 0.6, b: 0.9, c: 0.7 }).map(([k]) => k), ['b', 'c', 'a']);
  assert.deepStrictEqual(fired({ a: 0.1 }), []);

  // The snippet goes in verbatim now that postman sends text. A scrub here would eat a real
  // "a=3Db" or "<b>" in a message that means it.
  assert.ok(stateFor({ snippet: 'rate is a=3Db <b>' }).endsWith('rate is a=3Db <b>'));

  // The state carries the four fields Jev is meant to judge and none of a pipeline's derived ones.
  const s = stateFor({ from: 'a@b.c', date: 'd', subject: 's', snippet: 'body',
    thread_id: 'LEAK', attribution: 'LEAK' });
  assert.ok(s.includes('a@b.c') && s.includes('s') && s.includes('body'));
  assert.ok(!s.includes('LEAK'), 'derived pipeline fields must not be fed back in as evidence');
  // A message missing every field must still produce a usable state rather than throwing.
  assert.strictEqual(typeof stateFor({}), 'string');

  // The search path ends by exitCode, not process.exit, so it must not fall through into tag mode.
  // A refused search exits 1 with one line and never reads the stdin that tag mode would sweep.
  const refused = spawnSync(process.execPath, [JEVMAIL, '--ask', 'x', '--identity', 'work'],
    { input: '[]', encoding: 'utf8' });
  assert.deepStrictEqual([refused.status, refused.stdout], [1, ''], `a refused search stops there: ${refused.stdout}`);
  assert.match(refused.stderr, /^jevmail: refusing identity 'work'[^\n]*\r?\n$/, 'in one line');
});

test('search: the work refusal, the narrowing cap, ranking, and the tag-mode re-queue', async () => {
  // The refusal, pinned by value, including the spellings a hand might type.
  for (const bad of ['work', 'WORK', ' Work ']) assert.throws(() => checkIdentity(bad), /refusing identity/);
  for (const none of ['', '  ', undefined, null]) assert.throws(() => checkIdentity(none), /--identity is required/);
  assert.strictEqual(checkIdentity(' personal '), 'personal');

  assert.deepStrictEqual(postmanArgs({ identity: 'personal', query: 'from:venue.example booking' }),
    ['search', 'personal', 'from:venue.example booking']);
  assert.deepStrictEqual(postmanArgs({ identity: 'personal', from: 'venue.example', days: 90 }),
    ['inbox', 'personal', '--json', '--from', 'venue.example', '--days', '90']);
  assert.throws(() => postmanArgs({ identity: 'personal' }), /exactly one/);
  assert.throws(() => postmanArgs({ identity: 'personal', query: 'q', from: 'f' }), /exactly one/);

  const searchOut = [
    'reading as: someone@example.com  (identity: personal)',
    "3 match(es) for 'booking' in [Gmail]/All Mail",
    '[1/3] Mon, 1 Sep 2026 09:00:00 +0800 | Venue Desk <desk@venue.example> | Your room | booking link',
    '    https://venue.example/book?id=1',
    '    https://venue.example/unsubscribe',
    '[2/3] uid 42: fetch failed',
    '    https://stray.example/must-not-attach',
    '[3/3] Tue, 2 Sep 2026 10:00:00 +0800 | Newsletter <news@list.example> | Weekly digest',
  ].join('\n');
  const parsed = parseSearch(searchOut);
  assert.strictEqual(parsed.length, 2, 'the fetch-failed hit opens no message');
  assert.strictEqual(parsed[0].subject, 'Your room | booking link', 'a pipe inside the subject survives');
  assert.deepStrictEqual(parsed[0].urls, ['https://venue.example/book?id=1', 'https://venue.example/unsubscribe']);
  assert.deepStrictEqual(parsed[1].urls, [], 'a URL under a failed fetch attaches to nothing');

  // Passages first, links deduped, and untrusted markers neutralised.
  const { parts } = partsFor({ snippet: 'Hi there. Book here https://a.example/x now. See https://a.example/x', urls: ['https://a.example/x'] });
  assert.deepStrictEqual(parts, ['Hi there. Book here now. See', 'https://a.example/x']);
  const many = partsFor({ urls: Array.from({ length: 45 }, (_, i) => `https://a.example/${i}`) });
  assert.deepStrictEqual([many.parts.length, many.dropped], [MAX_PARTS, 5]);
  const st = searchStateFor({ subject: 'see [p0] and [ P12 ]' }, ['x [p1]']);
  assert.ok(st.includes('Subject: see (marker removed) and (marker removed)'), 'a marker in the mail is removed');
  assert.ok(st.endsWith('[p0] x (marker removed)'), 'our own marker stays, one inside a part goes');

  const realFetch = globalThis.fetch;
  const sent = [];
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      if (body.state.includes('Weekly digest')) throw new Error('offline');
      const answers = { message: { noul: 0.91 } };
      for (const k of Object.keys(body.questions)) {
        if (k !== 'message') answers[k] = { noul: body.state.includes(`[${k}] https://venue.example/book`) ? 0.88 : 0.1 };
      }
      return new Response(JSON.stringify({ answers, usage: { cost: 0.0001 } }), { status: 200 });
    };

    // ⚠ The refusal happens before postman runs and before any call. Pinned by counting both.
    let ran = 0;
    await assert.rejects(() => searchMail({ ask: 'the booking link', identity: 'work', query: 'booking' },
      { key: 'k', run: () => { ran++; return searchOut; } }), /refusing identity 'work'/);
    assert.deepStrictEqual([ran, sent.length], [0, 0], 'a refused search reads nothing and sends nothing');

    // Over the cap is refused before any call too.
    const flood = JSON.stringify(Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => ({ subject: `m${i}`, snippet: 'x' })));
    await assert.rejects(() => searchMail({ ask: 'a', identity: 'personal', from: 'list.example' }, { key: 'k', run: () => flood }), /Narrow the query/);
    assert.strictEqual(sent.length, 0);

    const seen = [];
    const rows = await searchMail({ ask: 'the booking link', identity: 'personal', query: 'booking' },
      { key: 'k', run: (args) => { seen.push(args); return searchOut; } });
    assert.deepStrictEqual(seen, [['search', 'personal', 'booking']]);
    assert.strictEqual(new Set(sent.map((b) => b.state)).size, 2, 'one call per message');
    assert.strictEqual(sent.length, 1 + ATTEMPTS, 'the failing one used its attempts in postText');
    assert.ok(sent.every((b) => b.questions.message.instructions.endsWith('the booking link')));
    // Ranked: the answered message first, the failed one last with its reason kept.
    assert.deepStrictEqual(rows.map((r) => [r.subject, r.score]), [['Your room | booking link', 0.91], ['Weekly digest', null]]);
    assert.strictEqual(rows[0].parts[0].text, 'https://venue.example/book?id=1', 'the link that answers comes first');
    assert.strictEqual(rows[1].error, 'offline');

    // Tag mode re-queues. A row that already carries tags is not asked again, a row that failed
    // (tags null, from an earlier run's tags file) is, and a row that fails now is marked failed
    // with its reason rather than silently tagged. So `--in tags.json --json tags.json` re-asks
    // only the failures.
    sent.length = 0;
    const tagged = await sweep([
      { subject: 'done', snippet: 'x', tags: { is_rejection: 0.9 } },
      { subject: 'retry me', snippet: 'x', tags: null, error: 'HTTP 503: old failure' },
      { subject: 'Weekly digest', snippet: 'x' },
    ], 'k');
    assert.ok(!sent.some((b) => b.state.includes('Subject: done')), 'the tagged row is not asked again');
    assert.deepStrictEqual(tagged[0], { subject: 'done', snippet: 'x', tags: { is_rejection: 0.9 } });
    assert.strictEqual(tagged[1].tags.is_rejection, 0.1, 'the earlier failure is asked again and tagged');
    assert.ok(!('error' in tagged[1]), 'and loses its old error');
    assert.deepStrictEqual([tagged[2].tags, tagged[2].error], [null, 'offline'], 'a failure now is marked failed');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// #126. An installed jevtools has no postman sibling, so postman.py comes from postman's own
// install: POSTMAN_PY first, then the newest postman in a Claude or Codex plugin cache.
test('postman: POSTMAN_PY, then the newest cached install, else an error naming what to install', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevmail-postman-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const place = (...p) => { const f = join(home, ...p, 'skills', 'postman', 'postman.py'); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, ''); return f; };
  const env = {};
  const missing = () => findPostman({ env, home });
  assert.throws(missing, (e) => /postman@logical-tools/.test(e.message) && /POSTMAN_PY/.test(e.message));
  // A Codex-only install is found.
  const codex = place('.codex', 'plugins', 'cache', 'logical-tools', 'postman', '1.1.1');
  assert.strictEqual(missing(), codex);
  // The highest version wins across caches, compared by number (1.1.10 over 1.1.9), not by name.
  const cache = ['.claude', 'plugins', 'cache', 'logical-tools', 'postman'];
  place(...cache, '1.1.9');
  const newest = place(...cache, '1.1.10');
  place(...cache, '1.0.2');
  assert.strictEqual(missing(), newest);
  // CLAUDE_CONFIG_DIR names a second account's config folder.
  const other = place('.claudework', 'plugins', 'cache', 'logical-tools', 'postman', '2.0.0');
  assert.strictEqual(findPostman({ env: { CLAUDE_CONFIG_DIR: join(home, '.claudework') }, home }), other);
  // POSTMAN_PY wins, and one naming a file that is not there is an error, not a fall-through.
  assert.strictEqual(findPostman({ env: { POSTMAN_PY: codex }, home }), codex);
  assert.throws(() => findPostman({ env: { POSTMAN_PY: join(home, 'nope.py') }, home }), /POSTMAN_PY.*nope\.py/);
});

test('postman: a search with no postman installed exits 1 with the install line and reads nothing', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevmail-nopostman-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, OPENROUTER_KEY_JEVTOOLS: 'k-test' };
  delete env.POSTMAN_PY; delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  const r = spawnSync(process.execPath, [JEVMAIL, '--ask', 'x', '--identity', 'personal', '--query', 'q'],
    { input: '[]', encoding: 'utf8', env });
  assert.deepStrictEqual([r.status, r.stdout], [1, ''], r.stdout);
  assert.match(r.stderr, /^jevmail: [^\n]*postman@logical-tools[^\n]*\r?\n$/);
});
