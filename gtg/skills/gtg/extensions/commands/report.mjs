// gtg report - write the full history object as JSON, print the path. Zero model
// tokens, read-only. /reporter builds the HTML from the JSON (see SKILL.md).
import { writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { buildReport } from '../lib/history.mjs';

export default ({ root, args }) => {
  const jIdx = args.indexOf('--json');
  const out = jIdx >= 0 && args[jIdx + 1]
    ? (isAbsolute(args[jIdx + 1]) ? args[jIdx + 1] : join(root, args[jIdx + 1]))
    : join(root, 'docs/handoffs/_report.json');
  const report = buildReport(root);
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(out);
  const t = report.throughput;
  console.log(`gtg report: ${report.counts.active} active · ${t.shipped} shipped · ` +
    `${report.effort.available ? report.effort.sessionsTimed + ' sessions timed' : 'effort unavailable'} · ${report.historyAvailable ? 'history ok' : 'no git history'}`);
};
