// gtg stats - a few terminal lines from the history extractor. Read-only.
import { buildReport } from '../lib/history.mjs';

export default ({ root }) => {
  const r = buildReport(root);
  console.log(`${r.counts.active} active, ${r.counts.backlog} backlog`);
  // readEvents turns a failed, timed-out or oversized `git log` into historyAvailable: false.
  // Say so, the way report does, or the lines below read as the whole history (#100).
  if (!r.historyAvailable) console.log('history unavailable: the git log of docs/handoffs/ failed, so the lines below are partial');

  const h = r.habit, t = r.throughput;
  if (h.activeDays) {
    console.log(`🔥 ${h.currentStreak}-day streak · ${h.activeDays} active days` +
      (h.longestStreak > h.currentStreak ? ` (best ${h.longestStreak})` : ' - personal best'));
  }
  if (t.shipped) {
    const last = t.lastShip ? ` · last: ${t.lastShip.project} (${t.lastShip.daysAgo === 0 ? 'today' : t.lastShip.daysAgo + 'd ago'})` : '';
    console.log(`🚢 ${t.shipped} shipped · ${t.shipped7d} in 7d${last}`);
  }
  const deepest = r.perProject[0];
  if (deepest) {
    const peakHour = h.byHour.indexOf(Math.max(...h.byHour));
    console.log(`⏱  ${r.perProject.reduce((n, p) => n + p.sessions, 0)} sessions · deepest: ${deepest.project} (${deepest.sessions})` +
      (h.byHour.some((n) => n) ? ` · peak ${peakHour}:00` : ''));
  }
  const e = r.effort;
  if (!e.available) console.log('effort unavailable: the git duration history failed, so timed effort is unknown');
  if (e.sessionsTimed) {
    const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`);
    console.log(`⌛ ${Math.round(e.total / 60)}h timed across ${e.sessionsTimed} sessions` +
      ` · avg ${hm(e.avgSessionMin)} · longest ${hm(e.longestSessionMin)}`);
    const week = Object.entries(e.hoursByWeek).sort().pop(); // newest ISO week
    const heaviest = r.perProject.filter((p) => p.minutes).sort((a, b) => b.minutes - a.minutes)[0];
    if (week) {
      console.log(`📅 ${week[1]}h in ${week[0]}` +
        (heaviest ? ` · heaviest: ${heaviest.project} (${e.hoursBySlug[heaviest.slug]}h)` : ''));
    }
  }
  if (t.resumed) console.log(`🅿️  ${t.parked} parked · ${t.resumed} resumes`);
  if (r.fun.velocity) console.log(`\n${r.fun.velocity}${r.fun.bestWeek ? ` - best week ${r.fun.bestWeek.week} (${r.fun.bestWeek.ships} ships)` : ''}`);
};
