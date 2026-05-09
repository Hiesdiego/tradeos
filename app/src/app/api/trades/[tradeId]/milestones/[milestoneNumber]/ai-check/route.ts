import { NextResponse } from "next/server";
import { withAuth, type AuthedRequest } from "@/lib/auth/withAuth";
import { prisma } from "@/lib/db/prisma";
import { buildCorridorGuidance } from "@/lib/corridorIntelligence";

type Context = { params: { tradeId: string; milestoneNumber: string } };

const IMAGE_MIME_PREFIX = "image/";
const LOGO_HINTS = ["logo", "brandmark", "icon", "avatar", "watermark", "banner"];
const AI_CHECKS_PER_DAY_LIMIT = 2;

function extractFirstJsonObject(input: string): string | null {
  const start = input.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

function stripCodeFences(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```[a-zA-Z]*\s*/u, "")
      .replace(/\s*```$/u, "")
      .trim();
  }
  return trimmed;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hasLogoHintInUrl(url: string): boolean {
  const s = url.toLowerCase();
  return LOGO_HINTS.some((k) => s.includes(k));
}

export const POST = withAuth(async (req: AuthedRequest, ctx: Context) => {
  const { tradeId, milestoneNumber } = ctx.params;
  const milestoneNo = Number(milestoneNumber);
  if (!Number.isInteger(milestoneNo) || milestoneNo <= 0) {
    return NextResponse.json({ error: "Invalid milestone number" }, { status: 400 });
  }

  const trade = await prisma.trade.findUnique({
    where: { id: tradeId },
    include: {
      buyer: true,
      supplier: true,
      milestones: {
        where: { milestone_number: milestoneNo },
        include: { proofs: { orderBy: { created_at: "desc" } } },
      },
    },
  });
  if (!trade) return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  if (trade.buyer_id !== req.user.id && trade.supplier_id !== req.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const milestone = trade.milestones[0];
  if (!milestone) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
  if (milestone.proofs.length === 0) {
    return NextResponse.json({ error: "No proof submitted for milestone" }, { status: 400 });
  }

  const imageProofs = milestone.proofs.filter((p) => (p.file_mime ?? "").startsWith(IMAGE_MIME_PREFIX));
  if (imageProofs.length === 0) {
    return NextResponse.json(
      { error: "AI check is available only for image proofs (png/jpeg/jpg/webp)." },
      { status: 400 }
    );
  }

  const now = new Date();
  const dayStartUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );
  const nextDayStartUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  );

  const checksToday = await prisma.milestoneAiCheck.count({
    where: {
      checker_user_id: req.user.id,
      created_at: {
        gte: dayStartUtc,
        lt: nextDayStartUtc,
      },
    },
  });

  if (checksToday >= AI_CHECKS_PER_DAY_LIMIT) {
    return NextResponse.json(
      {
        error: "Daily Tradeos Agent Check limit reached (2/day).",
        limit: AI_CHECKS_PER_DAY_LIMIT,
        checks_today: checksToday,
        resets_at: nextDayStartUtc.toISOString(),
      },
      { status: 429 }
    );
  }

  const apiKey = process.env.AGENT_API_KEY ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AGENT_API_KEY/GROQ_API_KEY is not configured" }, { status: 500 });
  }
  const model = process.env.AGENT_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";

  const guidance = buildCorridorGuidance({
    corridor: trade.corridor,
    commodityType: trade.goods_category,
  });
  const stageRule =
    guidance.required_document_pack_rules[
      Math.min(Math.max(milestoneNo - 1, 0), guidance.required_document_pack_rules.length - 1)
    ];

  const textPrompt = [
    "You are a trade compliance and logistics document-check agent for escrow milestones.",
    "Assess the submitted image proofs for plausibility and document completeness, not legal finality.",
    "Return strict JSON only with keys: verdict, confidence, summary, stage_fit_score, critical_mismatch, document_assessments, missing_documents, risk_flags, recommended_next_actions.",
    "verdict must be one of: pass, caution, fail.",
    "Do not return markdown or prose outside JSON.",
    "document_assessments must include one entry per image with image_index starting at 1.",
    "",
    `Trade corridor: ${trade.corridor}`,
    `Commodity: ${trade.goods_category ?? "Generic Goods"}`,
    `Milestone ${milestoneNo}: ${milestone.description}`,
    `Expected stage label: ${stageRule?.label ?? "N/A"}`,
    `Recommended docs for this stage: ${(stageRule?.recommended_documents ?? []).join(", ")}`,
    `Incoterm: ${trade.incoterm ?? "N/A"}`,
    "",
    "Legal/logistical context:",
    "- Check if documents look internally coherent for shipment progression.",
    "- Flag if key identifiers are missing/inconsistent (consignee, shipment reference, dates, quantities).",
    "- Highlight if the image appears unrelated, unreadable, altered, or incomplete.",
    "- Be conservative and explain uncertainty.",
  ].join("\n");

  const messageContent: Array<Record<string, unknown>> = [
    { type: "text", text: textPrompt },
    ...imageProofs.map((p) => ({
      type: "image_url",
      image_url: { url: p.file_url },
    })),
  ];

  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: messageContent }],
    }),
  });

  const groqPayload = await groqRes.json();
  if (!groqRes.ok) {
    return NextResponse.json(
      { error: groqPayload?.error?.message ?? "Groq request failed" },
      { status: 502 }
    );
  }

  const candidateText = stripCodeFences(
    String(groqPayload?.choices?.[0]?.message?.content ?? "")
  );

  let parsed: {
    verdict?: string;
    confidence?: number;
    summary?: string;
    stage_fit_score?: number;
    critical_mismatch?: boolean;
    document_assessments?: Array<{
      image_index: number;
      likely_document_type: string;
      relevance_to_stage: number;
      appears_logo_or_non_document: boolean;
      rationale: string;
    }>;
    missing_documents?: string[];
    risk_flags?: string[];
    recommended_next_actions?: string[];
  } = {};
  try {
    parsed = JSON.parse(candidateText);
  } catch {
    const extracted = extractFirstJsonObject(candidateText);
    if (extracted) {
      try {
        parsed = JSON.parse(extracted);
      } catch {
        parsed = {
          verdict: "caution",
          confidence: 0.35,
          summary: candidateText.slice(0, 800),
          missing_documents: [],
          risk_flags: ["Model returned non-JSON response."],
          recommended_next_actions: ["Request clearer document photos and run review again tomorrow."],
        };
      }
    } else {
      parsed = {
        verdict: "caution",
        confidence: 0.35,
        summary: candidateText.slice(0, 800),
        missing_documents: [],
        risk_flags: ["Model returned non-JSON response."],
        recommended_next_actions: ["Request clearer document photos and run review again tomorrow."],
      };
    }
  }

  const stageLower = `${stageRule?.label ?? ""} ${milestone.description}`.toLowerCase();
  const expectsDeliveryAcceptance =
    stageLower.includes("delivery") ||
    stageLower.includes("receipt") ||
    stageLower.includes("acceptance") ||
    stageLower.includes("goods received");
  const expectsCustomsClearance =
    stageLower.includes("customs") ||
    stageLower.includes("clearance") ||
    stageLower.includes("import declaration");

  const modelConfidence = typeof parsed.confidence === "number" ? clamp01(parsed.confidence) : 0.35;
  const stageFitScore = typeof parsed.stage_fit_score === "number" ? clamp01(parsed.stage_fit_score) : 0.5;
  const modelLogoFlag =
    (parsed.document_assessments ?? []).some((a) => a.appears_logo_or_non_document) ||
    (parsed.risk_flags ?? []).some((f) => /logo|non-document|unrelated/i.test(f));
  const urlLogoFlag = imageProofs.some((p) => hasLogoHintInUrl(p.file_url));
  const logoDetected = modelLogoFlag || urlLogoFlag;

  let calibratedConfidence = modelConfidence * stageFitScore;
  const riskFlags = [...(parsed.risk_flags ?? [])];
  const missingDocs = [...(parsed.missing_documents ?? [])];
  const recommendations = [...(parsed.recommended_next_actions ?? [])];
  let calibratedVerdict = (parsed.verdict ?? "caution").toLowerCase();

  if (logoDetected) {
    calibratedConfidence = Math.min(calibratedConfidence, 0.02);
    riskFlags.push("Submitted image appears to be a logo/non-evidentiary document.");
    recommendations.push("Upload a real trade document image for this milestone stage.");
    calibratedVerdict = "fail";
  }

  const criticalMismatch =
    Boolean(parsed.critical_mismatch) ||
    (expectsDeliveryAcceptance &&
      missingDocs.some((m) => /proof of delivery|goods received|acceptance|signed/i.test(m))) ||
    (expectsCustomsClearance &&
      missingDocs.some((m) => /customs|clearance|declaration|duty/i.test(m)));

  if (criticalMismatch) {
    calibratedConfidence = Math.min(calibratedConfidence, 0.2);
    if (!riskFlags.some((f) => /stage mismatch|critical mismatch/i.test(f))) {
      riskFlags.push("Critical stage-document mismatch detected.");
    }
    if (calibratedVerdict === "pass") calibratedVerdict = "caution";
  }

  calibratedConfidence = clamp01(calibratedConfidence);
  if (!["pass", "caution", "fail"].includes(calibratedVerdict)) {
    calibratedVerdict = "caution";
  }

  const saved = await prisma.milestoneAiCheck.create({
    data: {
      milestone_id: milestone.id,
      checker_user_id: req.user.id,
      model,
      verdict: calibratedVerdict,
      confidence: calibratedConfidence,
      summary: parsed.summary ?? "No summary returned",
      findings_json: {
        stage_fit_score: stageFitScore,
        critical_mismatch: criticalMismatch,
        document_assessments: parsed.document_assessments ?? [],
        missing_documents: missingDocs,
        risk_flags: riskFlags,
        recommended_next_actions: recommendations,
      },
      raw_response: groqPayload,
    },
  });

  return NextResponse.json({
    id: saved.id,
    created_at: saved.created_at,
    verdict: saved.verdict,
    confidence: saved.confidence,
    summary: saved.summary,
    findings: saved.findings_json,
  });
});
