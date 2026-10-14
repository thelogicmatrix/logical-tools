---
name: jevchecker
description: Sweeps a large body of text for a nuanced criterion and returns only the parts worth reading, so a Claude context sees the shortlist instead of the whole body. Use when the corpus is too big or too costly to read in full and the criterion is one a regex cannot express, such as grounding hundreds of generated bullets against the sources they came from. The shipped resume sweep is a calibration case, since one resume is small enough to read. Never use on other people's personal details, because the whole body is posted to OpenRouter. Do not use when the body is small enough to just read, when the question compares one part against another, or when a verdict is wanted rather than a shortlist.
---

# jevchecker

A sweep, not a judge. It splits a body into chunks, asks Jev the sweep's questions about each one,
and returns a ranked list of candidates for a person to read. Jev is a cheap judgement model served
through OpenRouter (`docs/runbooks/system-one-models.md`). It answers typed questions about a text
and generates none. A noul is its yes/no question type and returns a probability from 0 to 1.

**What reaches a Claude context is the shortlist, not the body.** Every candidate prints its first
140 characters to stdout, so on a clean sweep nothing does and on a bad one most of the swept text
can, 140 characters at a time. A resume bullet runs 185 to 390 characters, so that is a third to
three quarters of each one. Torn and unanswered rows print their path only. With `--json` the full
text of every candidate, torn, unanswered and clean chunk is written to the file, untruncated.

> **Never point this at other people's personal details.** The whole body is posted to OpenRouter, a third party, and
> there is no path-based refusal stopping you: this warning and the one in the description are the
> control. Out of a Claude context is not off the machine, and per the paragraph above the terminal
> and any `--json` file are not out of a Claude context either. Resumes, notes and public documents
> are fine. Other people's names, contact details, accounts and identifiers are not, in any file,
> ever.

```
node "${CLAUDE_PLUGIN_ROOT}/skills/jevchecker/jevchecker.mjs" <body> --sweep <sweep.json> [--source <file>] [--json <out>] [--text]
    [--concurrency N] [--resume]
node "${CLAUDE_PLUGIN_ROOT}/skills/jevchecker/jevchecker.mjs" --selftest
```

Node 18 or newer, for global `fetch`. The self-check's CLI cases use `node --import` with a
`data:` URL, which needs Node 20.6 or newer. No dependencies beyond that and no lockfile.

`CLAUDE_PLUGIN_ROOT` is the jevtools plugin root, which Claude Code sets. In Codex, or wherever it
is absent, run the `jevchecker.mjs` beside this loaded skill.
The working directory itself does not matter: the imports resolve relative to the file, so a full
path to `jevchecker.mjs` runs from anywhere. What matters is where the skill sits in the tree, which
the paragraph below states.

A sweep with a model check needs `OPENROUTER_KEY_JEVTOOLS` (or the fallback `OPENROUTER_API_KEY`) in
the environment or in `~/.jev.env`. With neither it prints one line and exits 1 before spending anything. A regex-only
sweep makes no call and needs no key.

It imports `../../scripts/lib.mjs` inside the jevtools plugin. Copy the skill to a
repo without that file and every run dies with a module-resolution error before the first call.

Sweep definitions live in `sweeps/`. `resume-grounding.json` reads a Reactive Resume JSON bullet by
bullet against a source resume, and flags em dashes and named entities in code rather than asking.

**A hit is a signal and not a verdict.** It means worth looking at, never wrong. Nothing it returns
is a finding until someone has read the chunk and agreed. It exits 0 whenever the sweep ran,
whatever it found, so it cannot be wired into a gate. A caller who wants a gate reads the JSON and
decides, having seen the values. The JSON carries `asked` and the `unanswered` rows, so coverage is
readable there too.

Two outcomes mean the sweep did not run, and both exit 1 under a banner rather than showing
"0 candidates". NOTHING SWEPT is a chunk spec that matched no text. NOTHING ANSWERED is every model
question failing (a bad key, an outage). A partial failure exits 0 and lists the failed rows under
UNANSWERED, each with its reason. A network error, 408, 429 or 5xx is retried up to three attempts with backoff, and a rerun costs
fractions of a cent.

Each call's answers go to a journal on disk the moment the call lands, and the path prints to
stderr when the run begins. It holds the answers and nothing else, no body text. Its name is a hash of
the chunks, the checks and the source, so after a Ctrl-C or a run with UNANSWERED rows, the same
command with `--resume` asks only the rows still unanswered and reuses every answer already paid
for. A changed body, sweep or source is a different journal, and a fresh run without `--resume`
starts its journal empty. A run that ends with every row answered deletes it. The journals live in
`jevchecker/` under the system temp directory, or in `JEVCHECKER_JOURNAL_DIR` when that is set.
`--concurrency N` sets the calls in flight, 6 by default.

## Writing a check

- **Write every noul so that true means fine.** The candidate end is the low one: a noul at or
  below the line surfaces. "This bullet is supported by the source" is right. "This bullet
  exaggerates" inverts it and files every real problem as clean, and nothing in the output says so.
- **Define the poles with `criteria`** when a noul fires too often or too rarely:
  `{ "true": "...", "false": "..." }`, keys spelled exactly that way. The runbook measured it as the
  biggest single lever on noul accuracy.
- **A score needs `criteria`**, an ordered array of 2 to 10 level descriptions, low to high. The
  answer is a position on that index, 0 to length minus 1, so `expected_levels` must sit inside it.
- **A regex check takes no flags.** Write case-insensitivity into the pattern (`[Ss]ynergy`). A `g`
  flag would make the test stateful and skip matches, so the key is refused rather than ignored.
- **Every key is allow-listed.** A key the sweep format does not know, `surfaceBelow` or
  `includeSource` for instance, is refused before any call rather than silently ignored.

## What it cannot do

- **No cross-chunk questions.** Each question asks about one chunk, so "is this contradicted
  elsewhere" or "does this duplicate section 4" cannot be asked. Chunks do share a call's state with
  their siblings, up to 200 questions' worth, so the model can see the others. The item being judged
  is itself in the state it is judged against, rather than in the question as the runbook
  recommends. A claim repeated in two tailored bullets may therefore be judged supported by the
  other bullet rather than by the source. On the one resume measured this changed nothing (below).
- **It cannot enumerate.** Jev answers only the questions a sweep supplies and generates no text, so
  a failure mode nobody wrote a check for stays invisible.
- **Page fit is out of scope.** It depends on rendering, which neither a regex nor Jev can see.

## What the runs measured

All runs used model `jev-latest` as served on the date given. The version behind that alias was not
recorded, so a model update can move these numbers and the 0.25 line with them. Rerun the
acceptance case after one.

**Acceptance run, 2026-09-23.** `resume-grounding` on `generalist.json`, a tailored resume the user
had reviewed and trusted, against `basis-1page.json`, the source it was copied from. 7 bullets swept
and 2 empty descriptions dropped, 1 call, $0.000199. **1 candidate, and it was real**: bullet
`experience.items[1].description[0]` (noul 0.23) adds "took the team to 100% compliance", which
appears nowhere in the source or in `full-resume.json`. The other 6 came back clean, between 0.95
and 0.97, 0 torn and 0 unanswered. The clean values are in the `--json` output's `clean` rows.

All 7 bullets were then read by hand against the source, so on this resume the answer is known. 6
are character-for-character identical to a source bullet and 1 is the paraphrase that was flagged.
Candidate precision 1 of 1, and recall 1 of 1. That is one resume with one paraphrased bullet, so it
shows the check can catch an added claim. It says little about a heavily reworded resume, and 0
false positives in 6 identical bullets bounds the false-positive rate only to about 39 percent (the
exact one-sided 95 percent binomial bound, `1 - 0.05^(1/6)`).

**Packing, measured the same day.** The same sweep with every bullet in its own call gave the same
verdict on all 7. The flagged bullet scored 0.22 alone and 0.23 packed with its siblings. Solo cost
$0.001204 over 7 calls, six times the packed run. The CLI has no solo mode: the run called
`pack(chunks, checks, source, 1)` from `lib/engine.mjs`, a budget of 1 putting every chunk in its
own call, and asked each call with `askJev`. On this resume sharing a call did not change the
answers. A resume whose siblings repeat each other's claims is the case that could still differ.

**Ten more tailored resumes, 2026-09-23**, after the compliance claim was found to have been
copied into them. Against `basis-1page.json` the sweep flagged the same three project bullets (a
podcast, a visual identity, 3D assets) in most of them. Every one is in `full-resume.json`: those
resumes draw on the full resume, not the one-page basis. Against `full-resume.json` the two
re-checked came back with 0 candidates and 4 and 7 torn, the torn ones being heavier rewording.
**Sweep a tailored resume against the file it was actually tailored from**, which is usually
`full-resume.json`. The one-page basis flags real projects as unsupported.

**Smoke test, 2026-09-22.** `basis-1page.json` as both body and source, so every bullet is trivially
supported by itself: 7 bullets, 1 call, $0.000198, 0 candidates and 0 torn. A noise floor only.

The inputs are gitignored and editable, so no artifact of either run is committed. Hash before
re-deriving these numbers and treat a different hash as a different measurement:

| file | SHA-256 | bytes | last modified |
|---|---|---|---|
| `job-search/work/generalist.json` | `60ccd2678f175467e29164e7349e17ab55e64ec09a2b51dfbd2794464963da0c` | 12,723 | 2026-08-27 |
| `job-search/work/basis-1page.json` | `3fb24c644eeffb178b82436cf174c1c308a6ea6a82c7f38d8a406d509ff5b32d` | 12,706 | 2026-08-27 |

Recall on a real, heavily tailored body is still unmeasured and must not be read as good.
Confirming a clean sweep really was clean means reading the whole body, which is the cost this tool
exists to avoid.

## Sharp edges

- **The body is untrusted input.** A crafted line inside a swept chunk can influence the answers
  about every chunk in the same call, not only itself. Chunk markers (`[c3]`, `[ C3 ]`) and both
  headers (`Source of truth:`, `Items under review:`) are neutralised on the way into the state, in
  any case and with any ASCII spacing, from the chunk text and from the source alike. Unicode
  look-alikes are not caught: full-width brackets, a zero-width space inside the marker, a Cyrillic
  letter or a full-width colon all get through. The rest of the text still sits in the same prompt
  as the questions and nothing stops it reading as instruction.
- **`resume-grounding` checks less than it looks like it checks.** It sweeps
  `$.sections..items[*].description` and nothing else. Three consequences, in rising order of size.
  The top-level `summary` and `customSections` are not swept. Of the 13 items under `sections` in a
  typical Reactive Resume export only 7 carry a `description` at all, so the entries in `skills`,
  `profiles` and `languages` are never looked at. And within the items that are swept, only the prose
  field goes: `company`, `position`, `period`, `degree`, `school`, `keywords` and the rest are all
  outside the sweep, which is to say job titles, employers, dates, degrees and skill lists, the
  facts a tailoring pass is most likely to inflate.
- **A numeric entity is invisible to `no-entities`.** The shipped pattern is
  `&(?!amp;|lt;|gt;)[a-z]+;` and `[a-z]+` does not match digits, so `&#8212;` passes the entity check
  and, being an entity rather than a literal character, passes the em-dash check as well. Hex
  (`&#x2014;`) and capitalised (`&Eacute;`) entities pass it for the same reason. A known gap,
  pinned by a test so closing it is a decision rather than a surprise.
- **A call that gets no response ends after 60 seconds.** `askJev` in `jevtools/scripts/lib.mjs`
  aborts it, `postText` tries three times in all, and a third hang lands as an unanswered row reading "no response
  after 60 s". A gateway error names its HTTP status.
- **`--source` and `state.include_source` go together.** A sweep that sets `include_source` refuses
  to run without a `--source` (an empty or whitespace-only file counts as none), and a `--source`
  given to a sweep that does not set it refuses too, since the file would never reach the model.
- A malformed sweep file costs nothing. An empty or missing `checks` list, an unknown key or check
  type, duplicate check ids, a `surface_below` that is not above 0 and at most 0.25, a `must` that is
  not `present` or `absent`, a pattern that will not compile, empty `instructions`, score `criteria`
  that are not 2 to 10 strings, an `expected_levels` band outside the criteria index, and noul
  `criteria` that are not exactly `true` and `false` are all rejected before any call goes out.
- Omit `then` when a chunk needs no second split. `"then": ""` throws instead of reading as none.
- **The candidate threshold is 0.25 and `surface_below` cannot move it upward.** A noul in the torn
  band (0.25 exclusive to 0.75 exclusive) is reported under torn and is never a candidate, so the
  noul values that surface run from 0 to 0.25 inclusive. A `surface_below` above 0.25 is therefore
  rejected by the pre-flight rather than silently ignored: inside the torn window it would be inert,
  and above the window it would come back to life and produce a candidate band with a hole in the
  middle, with 1 making every answer a candidate. An absent key is the 0.5 default, which is inert
  and behaves exactly as 0.25 does. To move the line, move the band in `lib/engine.mjs`, not the
  check.
- **A call is capped at 24,000 characters of state plus question text, and at 200 questions.** The
  source counts against the character budget on every call, because its header is rebuilt for each
  one. On the measured resume it was 12,713 characters of the 24,000, or 53 percent, for 7 bullets in
  one call. The source goes whole, contact fields included. When a source over half the budget ends
  up re-sent on more than one call, the run prints a warning saying so. The budget is characters,
  not Jev's 32K-token window, and 200 questions is the most one call has been measured carrying.
- **The body type is sniffed from its first non-space character.** A `{` or `[` means JSON, anything
  else means raw text. A markdown file opening on a link, `[see the spec](...)`, is therefore read as
  JSON and exits 1 with a parse error. `--text` skips the sniff. A parse failure is never
  silently downgraded to text, because sweeping a broken JSON document as a wall of prose would
  return candidates from a body nobody chunked correctly. A JSON body under a `lines` or
  `paragraphs` sweep, or a text body under `files` or `records`, refuses rather than being
  flattened into one chunk.
- **The encoding is read off the BOM.** Windows PowerShell writes UTF-16LE with `>` and, by
  default, with `Out-File`, and UTF-8 with a BOM when asked. UTF-8 with or without a BOM and
  UTF-16LE with its BOM are read. UTF-16BE refuses, and so does a file with a NUL character in it
  after decoding, which is binary or UTF-16 without a BOM.
- **Chunks dropped before the sweep are counted, not hidden.** An empty or null field, a null
  record, a blank or whitespace-only `<li>` or line, and a JSONPath landing on an object or array
  are all discarded on purpose, and the run prints how many. Most drops are legitimate, an empty
  description field being the common one. A large count means the chunk spec is landing in the
  wrong place, and the NOTHING SWEPT banner only fires when the count reaches everything. The one
  uncounted case is a `[*]` landing on something that is not an array, which selects nothing. Under
  `html-li`, text outside the `<li>` elements (a `<p>` lead line) is kept as one more chunk after the
  bullets, not dropped.
- **`--json` refuses a path that is also an input**, the body, the sweep file or the source,
  compared case-insensitively on Windows.
- **Ranking is only meaningful within one check type.** A noul ranks on a 0-to-1 scale and a score
  ranks on an unbounded distance outside its band, so the two are not comparable. Order inside a
  single check type is correct and deterministic. Order across types is not, so read the whole list.
