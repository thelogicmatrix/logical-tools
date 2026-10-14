# Forge store (optional)

gtg keeps its store in files by default: `docs/handoffs/active/<slug>.json`, `backlog/<slug>.json` and
`current/<slug>.md`, committed to git. A repo can instead point gtg at a dedicated Forgejo or Gitea
repository, so every session reads and writes one shared copy. With no forge configured nothing
changes.

## Config

`<root>/.gtg/forge.json`, per consuming repo:

```json
{ "api": "http://forge.example:3000/api/v1", "repo": "owner/gtg-store", "store": "files", "tokenFile": "${APPDATA}/forgejo-cli/forgejo-cli/data/keys.json" }
```

`"store": "files"` is required. The earlier milestone store (a project as a milestone, handoffs as
issue comments) was removed on 2026-09-29, and a config without the key is refused rather than
read as something else.

Token: `FORGEJO_TOKEN` wins, else `tokenFile` (`${VAR}` expands from the environment). The file may be
the bare token or forgejo-cli's `keys.json`, where the entry for the api's host is used. A config with
no token is an error, never a silent fall back to files.

## Records

Each project is one `docs/handoffs/records/<file-id>.json` file containing its slug,
`active` or `backlog` shelf, and current handoff body. A rename changes the slug inside
the same file. Forgejo's Contents API writes each change as a commit and requires the
previous SHA on updates. This prevents a stale client from silently replacing a newer
handoff or splitting it from its metadata. Reads take the git tree at `HEAD` and the record
blobs in one batch (`GET git/blobs?shas=`, one GET per blob on a server without it). The blob sha
is the one the next write sends. The Contents API directory listing is only the fallback, for a
truncated tree or a repo with no commit yet. The hub remains the caller's home repo,
so local progress records and portfolio hooks keep their existing paths. `complete` and `remove`
delete the record, with its previous handoffs retained in Git history.

## How it runs

Every record loads into memory when a command starts. The commands edit that snapshot exactly as
they edit the file store, through the same `entries()` and `saveEntries()`. When the command
finishes, one flush writes the difference: a new record is created, a changed one is updated with
its previous sha, and a missing one is deleted.

A write is never resent blind, because one whose answer was lost may have landed. When the answer
is lost (a timeout, a dropped connection, a 5xx) or the sha is refused (409, 422, or 400 on a DELETE), gtg reads the
record back. If it holds what gtg meant to write, the write landed. If it is unchanged, a lost
write is sent once more. If another session changed it, gtg re-applies its own edit on top once:
fields only this command changed take its values, the rest keep theirs, and the later `updated`
wins. A field both sides changed, or a second change during the re-apply, is an error naming the
record, and nothing of theirs is overwritten. A DELETE of a record already gone is success, and a
DELETE of one changed since the read is refused.

## Offline

The whole read stops at 10 s, retries included. Every blob read is cached by sha under the tmp
dir (`gtg-forge-cache/`), with the last tree read beside it. A blob never changes under its sha,
so a warm run fetches the tree and only the blobs it has not seen. When the hub does not answer
(connection refused, no answer within the cap, or a 5xx) and a cached copy exists, `list`, bare
`gtg`, `backlog` (the listing), `resume` and `learn` run on it, with a first line
`(stale, hub unreachable) cached store from <time>`. Every other command is refused, because a
write must start from the hub's copy. `handoff` and `backlog <idea>` fail at the write instead,
so the body is saved as below. A 4xx (a bad token, a missing repo) is a real answer and is never
served stale.

If the forge write fails during `handoff`, the body (read from stdin, so otherwise gone) is written to
`docs/handoffs/current/<slug>.md`, uncommitted, and the command exits 1.

Guarded handoffs (GTG >=4.8.1) pair `--expected-body-sha256 <64hex>` with
`--expected-shelf active|backlog`. The caller hashes the exact UTF-8 handoff from
`list --json`. GTG compares against its live loaded snapshot before any mutation,
then uses that same snapshot's blob SHA for the write. A pre-comparison refusal,
including a stale cache, exits 2 without a recovery body. Concurrent readback must
still match the captured body and shelf before re-applying other-field changes;
body/shelf changes and deletion remain conflicts. This does not reset the write
baseline or permit an unguarded retry. Consumers must check `gtg --version` first,
because older versions silently accept unknown handoff flags.

## Commands

| Behaviour | Commands |
|---|---|
| Read and write the forge instead of files | `list`, bare `gtg`, `backlog` (list and park), `handoff`, `resume`, `back`, `active`, `keep`, `complete`, `remove`/`rm`/`prune`, `supersede`, `rename`, `unparent`, the `REVIEW:` line, and the `learn` extension listing (they read through `ownEntries`) |
| Refused with a pointer to the store repo's history | `log`, `undo`, `stats`, `report`. They read git history of the file store, which the forge store does not write |
| Unchanged | `help`, `progress` (still files under `docs/handoffs/progress/`), `--wip`, the after-handoff and after-resume hooks (same ctx, `file` is null) |

`resume` still fast-forwards the hub from its git upstream on the forge store, as it does on the file
store. The records and handoffs come from the forge, but progress records and the portfolio rows the
after-resume hook reads are files in the hub's git.
