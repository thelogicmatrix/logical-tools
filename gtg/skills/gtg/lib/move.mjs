// gtg refresh / gtg migrate <device>: after the handoff, open a T3 Code thread whose first message
// is `gtg <slug>`, so the work carries on in a fresh session, here or on another device.
//
// The thread is opened by the hub's launcher, <root>/.gtg/t3-launch.mjs (default export
// fn(ctx) returning the done line), because reaching a T3 server (pairing, tokens, an ssh hop to
// a desktop) is the hub's business. A hub without one gets a GTG-LAUNCH line instead: the T3 MCP
// calls the agent makes to open the thread itself.
//
// Devices live in <root>/.gtg/t3-servers.json, `{ "<device>": { "home": "<workspace root>" } }`.
// Other keys in an entry are the launcher's. refresh needs no entry.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const serversFile = (root) => join(root, '.gtg', 't3-servers.json');
export const launcherFile = (root) => join(root, '.gtg', 't3-launch.mjs');

// Whether a thread can open at all. A hub launcher reaches T3 from anywhere. Without one, the
// agent opens it with T3's MCP tools, which only a session inside T3 has. T3's desktop app sets
// T3CODE_CLI_PATH for everything it starts, and T3_ACP_MCP_NODE marks its ACP agents. A headless
// `t3 serve` sets neither, so GTG_T3=1 says "this is T3" by hand.
export const canOpenThread = (root, env = process.env) =>
  existsSync(launcherFile(root)) || Boolean(env.T3CODE_CLI_PATH || env.T3_ACP_MCP_NODE || env.GTG_T3);

export const NEEDS_T3 = 'it opens the new session as a T3 Code thread (https://t3.codes), and this session is not running in T3 Code. ' +
  'Nothing was written. Depart with plain gtg instead, then start a new session and say "gtg <slug>". ' +
  'Inside a headless t3 serve, set GTG_T3=1.';

export function loadServers(root) {
  const f = serversFile(root);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
}

// The native fallback. A refresh launches through this thread's own T3 server (mcp__t3-code__),
// inheriting its project, model and modes. A migrate goes through the target's outside-agent
// registration (mcp__t3-<device>__), which needs an explicit projectId, found by workspace root:
// over that MCP, repositoryIdentity is null until T3's lazy enrichment runs. An outside caller
// gets no default model either ("the project has no default model"), so the line asks for the
// departing session's own.
export function launchLine({ target, slug, name, done, refresh, home }) {
  const title = name || slug;
  const tools = refresh ? 'mcp__t3-code__' : `mcp__t3-${target}__`;
  const reply = `Reply with "${done} ${title} to ${target}: [${title}](t3-thread://v1/<threadId>), opened with "gtg ${slug}". Carry on there." ` +
    'using the returned threadId as is, and stop.';
  const missing = `If ${tools}t3_thread_launch is not among your tools, say the handoff is saved and ${target} needs a T3 thread opened with "gtg ${slug}".`;
  if (refresh) {
    const args = { title, message: `gtg ${slug}`, workspaceStrategy: { type: 'root' } };
    return `GTG-LAUNCH: call ${tools}t3_thread_launch with ${JSON.stringify(args)}. ${reply} ${missing}`;
  }
  const args = { projectId: '<the home project id>', title, message: `gtg ${slug}`, runtimeMode: 'full-access',
    modelSelection: { instanceId: '<your provider instance: claudeAgent or codex>', model: '<your own model id>' } };
  return `GTG-LAUNCH: call ${tools}t3_project_list and keep the id of the project whose workspaceRoot is ${home} (either slash direction). ` +
    `If that call fails, ${target} is off or asleep: say the handoff is saved, and stop. ` +
    `Otherwise call ${tools}t3_thread_launch with ${JSON.stringify(args)} (modelSelection: the provider instance and model you are running on). ` +
    `${reply} ${missing}`;
}

// Opens the thread and returns the line to print. Throws when the launcher fails.
export async function openThread({ root, target, slug, name, refresh }) {
  const verb = refresh ? 'refresh' : `migrate ${target}`;
  const done = refresh ? 'REFRESHED' : 'MIGRATED';
  const file = launcherFile(root);
  if (!existsSync(file)) {
    return launchLine({ target, slug, name, done, refresh, home: loadServers(root)[target]?.home });
  }
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== 'function') throw new Error('.gtg/t3-launch.mjs has no default export function');
  const line = String(await mod.default({ root, target, slug, name: name || slug, verb, done }) ?? '').trim();
  if (!line.startsWith(done)) throw new Error(`.gtg/t3-launch.mjs returned no ${done} line${line ? `: ${line}` : ''}`);
  return line;
}
