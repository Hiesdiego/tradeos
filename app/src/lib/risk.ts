export type RiskTier = "low" | "medium" | "high";

export type CounterpartyRiskSignals = {
  counterparty: {
    userId: string;
    reliabilityScore: number;
    reliabilityTier: RiskTier;
    totalTrades: number;
    completionRate: number;
    disputeIncidence: number;
    medianProofToReleaseHours: number | null;
  };
  route: {
    corridor: string;
    sampleTrades: number;
    disputeIncidence: number;
    medianProofToReleaseHours: number | null;
    routeRiskScore: number;
    routeRiskTier: RiskTier;
  };
};

export type FraudRiskProfile = {
  score: number;
  tier: RiskTier;
  metrics: {
    totalTrades: number;
    disputedTrades: number;
    disputeRate: number;
    proofRejections: number;
    releasedMilestones: number;
    rejectionRate: number;
    refundedTrades: number;
    completionRate: number;
  };
};

type RiskTrade = {
  status: string;
  milestones?: Array<{ status: string; proof_rejection_reason: string | null }>;
  disputes?: Array<unknown>;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
  }
  return Number(sorted[mid].toFixed(2));
}

export function computeFraudRiskProfile(input: {
  trades: RiskTrade[];
  userId: string;
}): FraudRiskProfile {
  const trades = input.trades;
  const totalTrades = trades.length;
  if (totalTrades === 0) {
    return {
      score: 10,
      tier: "low",
      metrics: {
        totalTrades: 0,
        disputedTrades: 0,
        disputeRate: 0,
        proofRejections: 0,
        releasedMilestones: 0,
        rejectionRate: 0,
        refundedTrades: 0,
        completionRate: 0,
      },
    };
  }

  const disputedTrades = trades.filter((t) => (t.disputes?.length ?? 0) > 0).length;
  const proofRejections = trades.reduce(
    (sum, t) =>
      sum +
      (t.milestones?.filter((m) => Boolean(m.proof_rejection_reason)).length ?? 0),
    0
  );
  const releasedMilestones = trades.reduce(
    (sum, t) => sum + (t.milestones?.filter((m) => m.status === "released").length ?? 0),
    0
  );
  const refundedTrades = trades.filter((t) => t.status === "refunded").length;
  const completedTrades = trades.filter((t) => t.status === "completed").length;

  const disputeRate = disputedTrades / totalTrades;
  const rejectionRate = releasedMilestones > 0 ? proofRejections / releasedMilestones : 0;
  const completionRate = completedTrades / totalTrades;

  const rawScore =
    100 *
    (disputeRate * 0.45 +
      rejectionRate * 0.3 +
      (refundedTrades / totalTrades) * 0.15 +
      (1 - completionRate) * 0.1);

  const score = Math.round(clamp(rawScore, 0, 100));
  const tier: RiskTier = score >= 70 ? "high" : score >= 40 ? "medium" : "low";

  return {
    score,
    tier,
    metrics: {
      totalTrades,
      disputedTrades,
      disputeRate,
      proofRejections,
      releasedMilestones,
      rejectionRate,
      refundedTrades,
      completionRate,
    },
  };
}

export function computeCounterpartyRiskSignals(input: {
  counterpartyUserId: string;
  corridor: string;
  counterpartyTrades: Array<{
    status: string;
    disputes?: Array<unknown>;
    milestones?: Array<{
      proof_uploaded_at: string | Date | null;
      released_at: string | Date | null;
    }>;
  }>;
  corridorTrades: Array<{
    disputes?: Array<unknown>;
    milestones?: Array<{
      proof_uploaded_at: string | Date | null;
      released_at: string | Date | null;
    }>;
  }>;
}): CounterpartyRiskSignals {
  const counterpartyTrades = input.counterpartyTrades;
  const corridorTrades = input.corridorTrades;

  const cpTotal = counterpartyTrades.length;
  const cpCompleted = counterpartyTrades.filter((t) => t.status === "completed").length;
  const cpDisputed = counterpartyTrades.filter((t) => (t.disputes?.length ?? 0) > 0).length;
  const cpCompletionRate = cpTotal > 0 ? cpCompleted / cpTotal : 0;
  const cpDisputeIncidence = cpTotal > 0 ? cpDisputed / cpTotal : 0;

  const cpProofToReleaseHours = counterpartyTrades.flatMap((t) =>
    (t.milestones ?? [])
      .map((m) => {
        if (!m.proof_uploaded_at || !m.released_at) return null;
        const proofMs = new Date(m.proof_uploaded_at).getTime();
        const releaseMs = new Date(m.released_at).getTime();
        if (!Number.isFinite(proofMs) || !Number.isFinite(releaseMs) || releaseMs < proofMs) return null;
        return (releaseMs - proofMs) / (1000 * 60 * 60);
      })
      .filter((v): v is number => typeof v === "number")
  );
  const cpMedianHours = median(cpProofToReleaseHours);

  const reliabilityRaw =
    100 *
    (cpCompletionRate * 0.5 +
      (1 - cpDisputeIncidence) * 0.35 +
      (cpMedianHours == null ? 0.15 : clamp((72 - cpMedianHours) / 72, 0, 1) * 0.15));
  const reliabilityScore = Math.round(clamp(reliabilityRaw, 0, 100));
  const reliabilityTier: RiskTier =
    reliabilityScore >= 70 ? "low" : reliabilityScore >= 40 ? "medium" : "high";

  const routeTotal = corridorTrades.length;
  const routeDisputed = corridorTrades.filter((t) => (t.disputes?.length ?? 0) > 0).length;
  const routeDisputeIncidence = routeTotal > 0 ? routeDisputed / routeTotal : 0;
  const routeProofToReleaseHours = corridorTrades.flatMap((t) =>
    (t.milestones ?? [])
      .map((m) => {
        if (!m.proof_uploaded_at || !m.released_at) return null;
        const proofMs = new Date(m.proof_uploaded_at).getTime();
        const releaseMs = new Date(m.released_at).getTime();
        if (!Number.isFinite(proofMs) || !Number.isFinite(releaseMs) || releaseMs < proofMs) return null;
        return (releaseMs - proofMs) / (1000 * 60 * 60);
      })
      .filter((v): v is number => typeof v === "number")
  );
  const routeMedianHours = median(routeProofToReleaseHours);
  const routeRiskRaw =
    100 *
    (routeDisputeIncidence * 0.65 +
      (routeMedianHours == null ? 0.35 : clamp(routeMedianHours / 72, 0, 1) * 0.35));
  const routeRiskScore = Math.round(clamp(routeRiskRaw, 0, 100));
  const routeRiskTier: RiskTier =
    routeRiskScore >= 70 ? "high" : routeRiskScore >= 40 ? "medium" : "low";

  return {
    counterparty: {
      userId: input.counterpartyUserId,
      reliabilityScore,
      reliabilityTier,
      totalTrades: cpTotal,
      completionRate: Number(cpCompletionRate.toFixed(4)),
      disputeIncidence: Number(cpDisputeIncidence.toFixed(4)),
      medianProofToReleaseHours: cpMedianHours,
    },
    route: {
      corridor: input.corridor,
      sampleTrades: routeTotal,
      disputeIncidence: Number(routeDisputeIncidence.toFixed(4)),
      medianProofToReleaseHours: routeMedianHours,
      routeRiskScore,
      routeRiskTier,
    },
  };
}
