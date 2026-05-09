export const DEFAULT_PANEL_SIZE = 3;
export const DEFAULT_EVIDENCE_WINDOW_HOURS = 24;
export const DEFAULT_DECISION_WINDOW_HOURS = 48;
export const DEFAULT_ARBITRATION_FEE_BPS = 100; // 1%
export const MAX_ARBITRATION_FEE_BPS = 500; // 5%
export const DEFAULT_OVERRIDE_WINDOW_DAYS = 5;

export type ResolutionVote = "buyer" | "supplier" | "split";

export function computeArbitrationFeeUsdc(totalAmountUsdc: number): number {
  const feeBpsRaw = Number(process.env.ARBITRATION_FEE_BPS ?? DEFAULT_ARBITRATION_FEE_BPS);
  const feeBps = Number.isFinite(feeBpsRaw)
    ? Math.max(0, Math.min(MAX_ARBITRATION_FEE_BPS, Math.round(feeBpsRaw)))
    : DEFAULT_ARBITRATION_FEE_BPS;
  return Number(((totalAmountUsdc * feeBps) / 10_000).toFixed(6));
}

export function computeSlaDeadlines(from: Date): {
  evidenceDeadline: Date;
  decisionDeadline: Date;
} {
  const evidenceHoursRaw = Number(process.env.ARBITRATION_EVIDENCE_HOURS ?? DEFAULT_EVIDENCE_WINDOW_HOURS);
  const decisionHoursRaw = Number(process.env.ARBITRATION_DECISION_HOURS ?? DEFAULT_DECISION_WINDOW_HOURS);
  const evidenceHours = Number.isFinite(evidenceHoursRaw) ? Math.max(1, Math.round(evidenceHoursRaw)) : DEFAULT_EVIDENCE_WINDOW_HOURS;
  const decisionHours = Number.isFinite(decisionHoursRaw) ? Math.max(1, Math.round(decisionHoursRaw)) : DEFAULT_DECISION_WINDOW_HOURS;

  const evidenceDeadline = new Date(from.getTime() + evidenceHours * 60 * 60 * 1000);
  const decisionDeadline = new Date(evidenceDeadline.getTime() + decisionHours * 60 * 60 * 1000);
  return { evidenceDeadline, decisionDeadline };
}

export function resolveVoteMajority(votes: ResolutionVote[]): ResolutionVote | null {
  if (votes.length === 0) return null;
  const counts = votes.reduce<Record<ResolutionVote, number>>(
    (acc, vote) => {
      acc[vote] += 1;
      return acc;
    },
    { buyer: 0, supplier: 0, split: 0 }
  );

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]) as Array<[ResolutionVote, number]>;
  if (entries[0][1] === 0) return null;
  if (entries.length > 1 && entries[0][1] === entries[1][1]) return null;
  return entries[0][0];
}

export function getAdminOverrideDeadline(from: Date): Date {
  const daysRaw = Number(process.env.ARBITRATION_ADMIN_OVERRIDE_DAYS ?? DEFAULT_OVERRIDE_WINDOW_DAYS);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.round(daysRaw)) : DEFAULT_OVERRIDE_WINDOW_DAYS;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
