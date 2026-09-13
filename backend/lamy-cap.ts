/**
 * Adaptive outreach cap — ONE implementation, imported by the agent's MCP
 * (the agent) and the extension-worker API (backend/server.ts), so chat
 * and the worker can never disagree about today's cap.
 *
 * Judgment tunes WHERE inside 0..HARD_CEILING a user sits today; nothing —
 * no signal, no user request, no agent — raises the ceiling itself. The cap
 * is enforced in the SQLite transaction that leases outreach work, so a
 * second worker cannot race past the limit.
 */

export const HARD_CEILING = 10;

export function computeCap(
  history: { at: string }[], // lamy_outreach rows, newest first
  restricted: boolean,
) {
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = history.filter((r) => r.at.slice(0, 10) === today).length;
  const cleanDays = new Set(
    history.map((r) => r.at.slice(0, 10)).filter((d) => d !== today),
  ).size;
  const lastAt = history[0]?.at;
  const dormantDays = lastAt
    ? Math.floor((Date.now() - Date.parse(lastAt)) / 86400000)
    : null;

  const reasons: string[] = [];
  let cap: number;
  if (restricted) {
    cap = 2;
    reasons.push(
      "a LinkedIn warning is on record for this account — staying very conservative until it is cleared by a human",
    );
  } else if (dormantDays !== null && dormantDays > 14) {
    cap = 3;
    reasons.push(
      `no outreach in ${dormantDays} days — re-warming from the conservative start`,
    );
  } else {
    cap = Math.min(HARD_CEILING, 3 + Math.floor(cleanDays / 2));
    reasons.push(
      cleanDays === 0
        ? "no track record yet — starting at 3/day"
        : `${cleanDays} clean days of history — earned cap ${cap}/day`,
    );
  }
  const remaining = Math.max(0, cap - usedToday);
  return {
    hard_ceiling: HARD_CEILING,
    today_cap: cap,
    used_today: usedToday,
    remaining,
    reasons,
  };
}
