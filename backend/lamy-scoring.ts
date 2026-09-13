/**
 * Lamy's fit scoring — ONE implementation, imported by both the agent's MCP
 * (the agent) and the management web page (backend/server.ts), so chat
 * and page can never disagree about a score. Fit is a FUNCTION of the bank,
 * never a stored column: add or confirm a fact and every role re-scores on
 * the next read. Keep it that way.
 *
 * Known looseness (accepted for the prototype, noted in LAMY-HANDOFF.md):
 * a must_have counts as covered when ANY >2-char word of it appears in a
 * bank entry. Upgrade path: embeddings shortlist + LLM-as-judge — still
 * derived at read time.
 */

export type BankRow = {
  id: number;
  claim: string;
  metric: string | null;
  tags: string[];
  state: "confirmed" | "inferred" | "stale";
  source: string;
};

export type RoleRow = {
  id: number;
  title: string;
  company: string;
  archetype: string;
  must_haves: string[];
  jd: string | null;
};

export function scoreRole(role: RoleRow, bank: BankRow[]) {
  const hay = (r: BankRow) =>
    `${r.claim} ${r.metric ?? ""} ${r.tags.join(" ")}`.toLowerCase();

  const covered: { need: string; by: number; state: string }[] = [];
  const gaps: string[] = [];
  const weakOnly: { need: string; by: number }[] = [];

  for (const need of role.must_haves) {
    const words = need.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const hit = bank.find((r) => words.some((w) => hay(r).includes(w)));
    if (!hit) {
      gaps.push(need);
    } else if (hit.state === "confirmed") {
      covered.push({ need, by: hit.id, state: hit.state });
    } else {
      // Backed only by something the human has not confirmed. It counts for
      // nothing until they do — that is what stops a guess reaching an employer.
      weakOnly.push({ need, by: hit.id });
    }
  }

  const total = role.must_haves.length || 1;
  const score = Math.round((covered.length / total) * 100);
  return { score, covered, weak_only: weakOnly, gaps, bar: 60, passes_bar: score >= 60 };
}
