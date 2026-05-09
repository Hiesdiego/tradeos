type StageKey = "pre_shipment" | "in_transit" | "arrival_customs" | "delivery_acceptance";

export type DocumentPackRule = {
  stage: StageKey;
  label: string;
  recommended_documents: string[];
  notes?: string;
};

export type MilestoneTemplate = {
  description: string;
  release_percentage: number;
  stage: StageKey;
};

export type CorridorTemplate = {
  corridor: string;
  commodity_type: string;
  milestones: MilestoneTemplate[];
  required_document_pack_rules: DocumentPackRule[];
};

const DEFAULT_TEMPLATE: CorridorTemplate = {
  corridor: "GENERIC",
  commodity_type: "Generic Goods",
  milestones: [
    {
      description: "Shipping booking and export docs prepared",
      release_percentage: 25,
      stage: "pre_shipment",
    },
    {
      description: "Shipment in transit with traceable proof",
      release_percentage: 35,
      stage: "in_transit",
    },
    {
      description: "Arrival and customs processing completed",
      release_percentage: 25,
      stage: "arrival_customs",
    },
    {
      description: "Buyer confirms receipt and quality acceptance",
      release_percentage: 15,
      stage: "delivery_acceptance",
    },
  ],
  required_document_pack_rules: [
    {
      stage: "pre_shipment",
      label: "Pre-Shipment Pack",
      recommended_documents: [
        "Commercial Invoice",
        "Packing List",
        "Purchase Order / Proforma Invoice",
      ],
      notes: "Recommended for faster arbitration and payout review.",
    },
    {
      stage: "in_transit",
      label: "In-Transit Pack",
      recommended_documents: [
        "Bill of Lading / Airway Bill",
        "Freight Booking Confirmation",
        "Carrier Tracking Evidence",
      ],
    },
    {
      stage: "arrival_customs",
      label: "Arrival & Customs Pack",
      recommended_documents: [
        "Import Declaration / Customs Entry",
        "Duty or Clearance Receipt",
        "Port/Airport Release Note",
      ],
    },
    {
      stage: "delivery_acceptance",
      label: "Delivery Acceptance Pack",
      recommended_documents: [
        "Proof of Delivery (signed)",
        "Goods Received Note / Warehouse Receipt",
        "Buyer Acceptance Confirmation",
      ],
    },
  ],
};

const TEMPLATES: CorridorTemplate[] = [
  {
    corridor: "NG-UAE",
    commodity_type: "Textiles & Fabrics",
    milestones: [
      { description: "Export-ready textile pack submitted", release_percentage: 25, stage: "pre_shipment" },
      { description: "Bill of lading and transit proof uploaded", release_percentage: 35, stage: "in_transit" },
      { description: "UAE customs clearance evidence uploaded", release_percentage: 25, stage: "arrival_customs" },
      { description: "Buyer confirms fabric receipt/condition", release_percentage: 15, stage: "delivery_acceptance" },
    ],
    required_document_pack_rules: [
      { stage: "pre_shipment", label: "Textile Export Pack", recommended_documents: ["Commercial Invoice", "Packing List", "Certificate of Origin"] },
      { stage: "in_transit", label: "Transit Proof Pack", recommended_documents: ["Bill of Lading / AWB", "Carrier Tracking Snapshot"] },
      { stage: "arrival_customs", label: "UAE Customs Pack", recommended_documents: ["Import Declaration", "Customs Assessment/Receipt"] },
      { stage: "delivery_acceptance", label: "Final Acceptance Pack", recommended_documents: ["Proof of Delivery", "Goods Received Note"] },
    ],
  },
  {
    corridor: "NG-UAE",
    commodity_type: "Fashion & Apparel",
    milestones: [
      { description: "Apparel production lot + export docs ready", release_percentage: 30, stage: "pre_shipment" },
      { description: "Shipment departure and transit proof", release_percentage: 30, stage: "in_transit" },
      { description: "Arrival/customs release completed", release_percentage: 25, stage: "arrival_customs" },
      { description: "Store/warehouse delivery accepted", release_percentage: 15, stage: "delivery_acceptance" },
    ],
    required_document_pack_rules: DEFAULT_TEMPLATE.required_document_pack_rules,
  },
];

function normalize(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

function reverseCorridor(corridor: string): string | null {
  const parts = corridor.split("-").map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  return `${parts[1]}-${parts[0]}`;
}

export function getCorridorTemplate(
  corridor: string | null | undefined,
  commodityType: string | null | undefined
): CorridorTemplate {
  const c = normalize(corridor);
  const g = normalize(commodityType);
  const exact = TEMPLATES.find(
    (t) => normalize(t.corridor) === c && normalize(t.commodity_type) === g
  );
  if (exact) return exact;
  const corridorOnly = TEMPLATES.find((t) => normalize(t.corridor) === c);
  if (corridorOnly) return corridorOnly;

  const reversed = corridor ? reverseCorridor(corridor) : null;
  const rc = normalize(reversed);
  if (rc) {
    const reverseExact = TEMPLATES.find(
      (t) => normalize(t.corridor) === rc && normalize(t.commodity_type) === g
    );
    if (reverseExact) return reverseExact;
    const reverseCorridorOnly = TEMPLATES.find((t) => normalize(t.corridor) === rc);
    if (reverseCorridorOnly) return reverseCorridorOnly;
  }
  return DEFAULT_TEMPLATE;
}

export function buildCorridorGuidance(input: {
  corridor: string | null | undefined;
  commodityType: string | null | undefined;
}) {
  const template = getCorridorTemplate(input.corridor, input.commodityType);
  const displayCorridor = (input.corridor ?? "").trim() || template.corridor;
  return {
    strict: false,
    guidance_only: true,
    corridor: displayCorridor,
    commodity_type: template.commodity_type,
    milestone_templates: template.milestones,
    required_document_pack_rules: template.required_document_pack_rules,
  };
}
