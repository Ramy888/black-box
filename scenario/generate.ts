// Deterministic incident scenario: the same seed always produces the same rows.
// The planted cause: policy v2 (14 days) replaced v1 (30 days) on 18 Oct, so the
// 40 requests delivered 15-30 days before the incident are out of policy.

export const INCIDENT_AT = new Date("2026-10-21T10:00:00Z");
export const POLICY_CHANGE_AT = new Date("2026-10-18T00:00:00Z");
export const BANDS = { inPolicy: 80, stalePolicy: 40, tooOld: 12 } as const;

const DAY = 86_400_000;
const CITIES = ["Cairo", "Giza", "Alexandria", "Mansoura", "Tanta", "Aswan"];
const FIRST = ["Mona", "Omar", "Laila", "Karim", "Nour", "Youssef", "Salma", "Hassan", "Farida", "Tarek"];
const LAST = ["Adel", "Fathy", "Samir", "Nabil", "Hosny", "Ezzat", "Gamal", "Lotfy"];
const REASONS = ["Item arrived damaged", "Wrong size", "Changed my mind", "Late delivery", "Not as described"];

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Scenario {
  customers: { id: string; name: string; city: string }[];
  orders: { id: string; customer_id: string; amount_egp: number; status: string; delivered_at: Date }[];
  payments: { id: string; order_id: string; provider_ref: string; captured_at: Date }[];
  policyVersions: { version: number; max_return_days: number; valid_from: Date; valid_to: Date | null; note: string }[];
  refundRequests: { id: string; order_id: string; customer_id: string; reason: string; requested_at: Date }[];
  opsTickets: { ticket_id: string; opened_at: Date; team: string; subject: string; body: string }[];
}

export function generateScenario(seed = 417): Scenario {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const pad = (n: number) => String(n).padStart(4, "0");

  // Delivery age in days (relative to the incident) per band.
  const ages: number[] = [];
  for (let i = 0; i < BANDS.inPolicy; i++) ages.push(1 + Math.floor(rnd() * 13)); // 1..13
  for (let i = 0; i < BANDS.stalePolicy; i++) ages.push(15 + Math.floor(rnd() * 15)); // 15..29
  for (let i = 0; i < BANDS.tooOld; i++) ages.push(32 + Math.floor(rnd() * 20)); // 32..51

  const s: Scenario = { customers: [], orders: [], payments: [], policyVersions: [], refundRequests: [], opsTickets: [] };
  ages.forEach((age, i) => {
    const n = i + 1;
    const customer = { id: `C-${pad(n)}`, name: `${pick(FIRST)} ${pick(LAST)}`, city: pick(CITIES) };
    const delivered = new Date(INCIDENT_AT.getTime() - age * DAY - Math.floor(rnd() * 8) * 3_600_000);
    const order = { id: `O-${pad(n)}`, customer_id: customer.id, amount_egp: Math.round(150 + rnd() * 2850), status: "delivered", delivered_at: delivered };
    s.customers.push(customer);
    s.orders.push(order);
    s.payments.push({ id: `P-${pad(n)}`, order_id: order.id, provider_ref: `PAYM-${(100000 + n * 7919).toString(36).toUpperCase()}`, captured_at: new Date(delivered.getTime() - 2 * DAY) });
    s.refundRequests.push({
      id: `RR-${pad(n)}`, order_id: order.id, customer_id: customer.id, reason: pick(REASONS),
      requested_at: new Date(INCIDENT_AT.getTime() - Math.floor(rnd() * 6) * 3_600_000),
    });
  });

  s.policyVersions.push(
    { version: 1, max_return_days: 30, valid_from: new Date("2026-01-01T00:00:00Z"), valid_to: POLICY_CHANGE_AT, note: "Refunds within 30 days of delivery" },
    { version: 2, max_return_days: 14, valid_from: POLICY_CHANGE_AT, valid_to: null, note: "Refunds within 14 days of delivery (finance change FIN-212)" },
  );

  // Ops tickets after the incident: one real signal and one false lead.
  s.opsTickets.push(
    { ticket_id: "OPS-881", opened_at: new Date(INCIDENT_AT.getTime() + 5 * 3_600_000), team: "Finance", subject: "Refund payouts spiked today", body: "Daily refund total is about 3x normal. Many payouts look older than our return window." },
    { ticket_id: "OPS-882", opened_at: new Date(INCIDENT_AT.getTime() + 6 * 3_600_000), team: "Support", subject: "Payments provider returning duplicate IDs?", body: "A customer said they were refunded twice. Could the payments provider be returning duplicate payment IDs?" },
    { ticket_id: "OPS-883", opened_at: new Date(INCIDENT_AT.getTime() + 7 * 3_600_000), team: "Finance", subject: "Return window change FIN-212 live since 18 Oct", body: "Reminder: the return window is 14 days since 18 Oct. Please confirm all systems use it." },
  );
  return s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const t = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
