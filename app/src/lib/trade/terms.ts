export type TradeTermsMilestoneInput = {
  milestone_number: number;
  description: string;
  release_percentage: number;
};

export type TradeTermsInput = {
  trade_number?: string | null;
  buyer_wallet_address?: string | null;
  supplier_wallet_address?: string | null;
  goods_description?: string | null;
  goods_category?: string | null;
  quantity?: string | null;
  total_amount_usdc?: number | string | null;
  corridor?: string | null;
  pickup_location?: string | null;
  dropoff_location?: string | null;
  buyer_contact_name?: string | null;
  buyer_contact_phone?: string | null;
  supplier_contact_name?: string | null;
  supplier_contact_phone?: string | null;
  expected_ship_date?: string | Date | null;
  expected_delivery_date?: string | Date | null;
  shipping_reference?: string | null;
  incoterm?: string | null;
  notes?: string | null;
  milestones?: TradeTermsMilestoneInput[] | null;
};

function norm(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function normDate(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function buildCanonicalTradeTerms(input: TradeTermsInput) {
  return {
    v: 1,
    trade_number: norm(input.trade_number),
    buyer_wallet_address: norm(input.buyer_wallet_address),
    supplier_wallet_address: norm(input.supplier_wallet_address),
    goods_description: norm(input.goods_description),
    goods_category: norm(input.goods_category),
    quantity: norm(input.quantity),
    total_amount_usdc: input.total_amount_usdc == null ? null : String(input.total_amount_usdc),
    corridor: norm(input.corridor),
    pickup_location: norm(input.pickup_location),
    dropoff_location: norm(input.dropoff_location),
    buyer_contact_name: norm(input.buyer_contact_name),
    buyer_contact_phone: norm(input.buyer_contact_phone),
    supplier_contact_name: norm(input.supplier_contact_name),
    supplier_contact_phone: norm(input.supplier_contact_phone),
    expected_ship_date: normDate(input.expected_ship_date),
    expected_delivery_date: normDate(input.expected_delivery_date),
    shipping_reference: norm(input.shipping_reference),
    incoterm: norm(input.incoterm),
    notes: norm(input.notes),
    milestones: (input.milestones ?? [])
      .map((m) => ({
        milestone_number: Number(m.milestone_number),
        description: norm(m.description),
        release_percentage: Number(m.release_percentage),
      }))
      .sort((a, b) => a.milestone_number - b.milestone_number),
  };
}

export function canonicalTradeTermsString(input: TradeTermsInput): string {
  return stableStringify(buildCanonicalTradeTerms(input));
}
