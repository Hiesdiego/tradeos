import { prisma } from "@/lib/db/prisma";

export const DEFAULT_PANEL_SIZE = 3;
export const DEFAULT_EVIDENCE_WINDOW_HOURS = 24;
export const DEFAULT_DECISION_WINDOW_HOURS = 48;
export const DEFAULT_ARBITRATION_FEE_BPS = 100; // 1%
export const MAX_ARBITRATION_FEE_BPS = 500; // 5%
export const DEFAULT_OVERRIDE_WINDOW_DAYS = 5;
export const DEFAULT_ARB_ROTATION_COOLDOWN = 3;

export type ResolutionVote = "buyer" | "supplier" | "split";

type SelectPanelOptions = {
  tradeAmountUsdc: number;
  panelSize?: number;
  excludedUserIds?: string[];
  excludeRecentAssignmentsForNDisputes?: number;
};

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

export async function selectArbiterPanel({
  tradeAmountUsdc,
  panelSize = DEFAULT_PANEL_SIZE,
  excludedUserIds = [],
  excludeRecentAssignmentsForNDisputes = DEFAULT_ARB_ROTATION_COOLDOWN,
}: SelectPanelOptions) {
  const recent = await prisma.disputeArbiterAssignment.findMany({
    orderBy: { assigned_at: "desc" },
    take: Math.max(panelSize * excludeRecentAssignmentsForNDisputes, panelSize),
    include: { arbiter: true },
  });
  const cooledDownArbiterIds = new Set(
    recent.map((r) => r.arbiter_profile_id)
  );

  const profiles = await prisma.arbiterProfile.findMany({
    where: {
      active: true,
      user_id: { notIn: excludedUserIds },
      min_case_amount_usdc: { lte: tradeAmountUsdc },
      OR: [{ max_case_amount_usdc: null }, { max_case_amount_usdc: { gte: tradeAmountUsdc } }],
    },
    include: { user: true },
    orderBy: [{ reputation_score: "desc" }, { stake_usdc: "desc" }, { accepted_cases: "asc" }],
    take: Math.max(panelSize * 6, panelSize),
  });

  const primary = profiles.filter((p) => !cooledDownArbiterIds.has(p.id));
  const fallback = profiles.filter((p) => cooledDownArbiterIds.has(p.id));
  return [...primary, ...fallback].slice(0, panelSize);
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
