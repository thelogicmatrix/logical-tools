import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claimPrompt } from '../scripts/router.mjs';
import { readSent } from '../scripts/session.mjs';

const ROUTER = fileURLToPath(new URL('../scripts/router.mjs', import.meta.url));
const PROMPT = 'Write a PowerShell command to inspect this project.';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-agent-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const docs = path.join(base, 'docs', 'runbooks');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'powershell.md'), '**Type:** standard\n**Purpose:** Writing PowerShell commands.\n');
  const stub = path.join(base, 'fetch.mjs');
  fs.writeFileSync(stub, `globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.state !== 'A task is about to be started. The task: ${PROMPT}') throw new Error('wrong task routed');
    return { ok: true, json: async () => ({ answers: { rb_powershell_md: { noul: 0.95 } } }) };
  };`);
  const env = { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base,
    RUNBOOKS_DIR: docs, OPENROUTER_KEY_RUNBOOKS: 'fixture', OPENROUTER_API_KEY: '', JEV_SPEND_DISABLED: '1' };
  const run = (input, flags = ['--agent'], fetchStub = stub) => spawnSync(process.execPath,
    ['--import', pathToFileURL(fetchStub).href, ROUTER, ...flags], { cwd: base, env, input: JSON.stringify(input), encoding: 'utf8' });
  return { base, env, run, state: path.join(base, 'claude-router') };
}

test('Claude dispatch routes its brief despite parent dedupe and preserves every tool argument', (t) => {
  const f = fixture(t);
  claimPrompt('parent', PROMPT, { dir: f.state });
  const tool_input = { prompt: PROMPT, description: 'Inspect shell', subagent_type: 'Explore', model: 'sonnet', run_in_background: true };
  const input = { session_id: 'parent', tool_name: 'Agent', tool_use_id: 'child-1', tool_input };
  const r = f.run(input);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, undefined, 'routing does not change Claude permission decisions');
  assert.deepEqual({ ...out.updatedInput, prompt: PROMPT }, tool_input);
  assert.ok(out.updatedInput.prompt.startsWith(`${PROMPT}\n\n`));
  assert.match(out.updatedInput.prompt, /Runbooks matched to this task[\s\S]*powershell/);
  assert.deepEqual(readSent('parent\0', f.state), [], 'a child injection is not claimed in the parent ledger');
  assert.equal(f.run(input).stdout, '', 'duplicate hook registration for this dispatch makes no second call');
  assert.match(f.run({ ...input, tool_use_id: 'child-2', tool_name: 'Task' }).stdout, /powershell/,
    'a second child with an identical brief gets its own runbooks');
});

test('Codex dispatch rewrites message with its required allow envelope', (t) => {
  const f = fixture(t);
  const tool_input = { message: PROMPT, model: 'gpt-6-sol', reasoning_effort: 'high', fork_turns: 'none' };
  const r = f.run({ session_id: 'parent', tool_name: 'spawn_agent', tool_use_id: 'codex-1', tool_input }, ['--agent', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'allow');
  assert.deepEqual({ ...out.updatedInput, message: PROMPT }, tool_input);
  assert.match(out.updatedInput.message, /powershell/);
});

test('parent prompt still emits the original Claude and Codex context shapes', (t) => {
  const f = fixture(t);
  const r = f.run({ session_id: 'parent-plain', prompt: PROMPT }, []);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith('Runbooks matched to this task'));
  assert.deepEqual(readSent('parent-plain\0', f.state), ['powershell.md']);
  const codex = f.run({ session_id: 'parent-json', prompt: PROMPT }, ['--json']);
  assert.equal(codex.status, 0, codex.stderr);
  const out = JSON.parse(codex.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'UserPromptSubmit');
  assert.ok(out.additionalContext.startsWith('Runbooks matched to this task'));
});

test('router-down dispatch still exits zero and delivers the fallback notice to the child', (t) => {
  const f = fixture(t);
  const down = path.join(f.base, 'down.mjs');
  fs.writeFileSync(down, "globalThis.fetch = async () => ({ ok: false, status: 503 });");
  const tool_input = { prompt: PROMPT, subagent_type: 'Explore' };
  const r = f.run({ session_id: 'down', tool_name: 'Agent', tool_use_id: 'down-1', tool_input }, ['--agent'], down);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, undefined);
  assert.match(out.updatedInput.prompt, /routing is unavailable \(http 503, 3 attempts\)/);
  assert.equal(out.updatedInput.subagent_type, 'Explore');
  assert.match(r.stderr, /fallback \(http 503, 3 attempts\)/);
});

test('dispatch without an id does not suppress another child, and non-dispatch inputs do nothing', (t) => {
  const f = fixture(t);
  const input = { session_id: 'parent', tool_name: 'Agent', tool_input: { prompt: PROMPT } };
  for (let n = 0; n < 2; n++) assert.match(f.run(input).stdout, /powershell/);
  for (const input of [null, {}, { tool_name: 'Bash', tool_input: { prompt: PROMPT } },
    { tool_name: 'Agent', tool_input: { resume: 'existing-child' } }]) {
    const r = f.run(input);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  }
});
