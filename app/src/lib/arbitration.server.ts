import { prisma } from "@/lib/db/prisma";
import { DEFAULT_PANEL_SIZE } from "@/lib/arbitration.shared";

export * from "@/lib/arbitration.shared";

export const DEFAULT_ARB_ROTATION_COOLDOWN = 3;

type SelectPanelOptions = {
  tradeAmountUsdc: number;
  panelSize?: number;
  excludedUserIds?: string[];
  excludeRecentAssignmentsForNDisputes?: number;
};

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
  const cooledDownArbiterIds = new Set(recent.map((r) => r.arbiter_profile_id));

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
