import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoud } from "../scripts/router.mjs";

// A missing key used to inject a context-only notice, so routing was down on a whole device for a
// day with nobody seeing it. A failure that will not fix itself now also reaches the user as a
// Claude Code systemMessage. Transient ones stay quiet: the outage breaker already handles them.
const router = fileURLToPath(new URL("../scripts/router.mjs", import.meta.url));

test("isLoud is the set of failures a retry or a wait cannot fix", () => {
  for (const why of ["no key", "http 401", "http 402", "http 403"]) assert.equal(isLoud(why), true, why);
  for (const why of ["timeout", "http 429", "http 500", "http 503", "no answers", "thrown", undefined]) {
    assert.equal(isLoud(why), false, String(why));
  }
});

test("with no key the prompt hook warns the user, not only the model", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "runbooks-loud-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "runbooks");
  mkdirSync(dir);
  writeFileSync(join(dir, "deploy.md"), "# Deploy\n**Type:** procedure\n**Purpose:** Ship the Acme scraper to production.\n");
  const env = { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, RUNBOOKS_DIR: dir, CLAUDE_CONFIG_DIR: "" };
  delete env.OPENROUTER_API_KEY;
  delete env.OPENROUTER_KEY_RUNBOOKS;
  const r = spawnSync(process.execPath, [router], { cwd: root, env, encoding: "utf8",
    input: JSON.stringify({ cwd: root, prompt: "deploy the acme scraper to production", session_id: "loud-test" }) });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.systemMessage, /Runbook routing is down \(no key\)/);
  assert.match(out.systemMessage, /OPENROUTER_KEY_RUNBOOKS/);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /Runbook routing is unavailable \(no key, 0 attempts\)/);
});
