/* ShopTalk API shapes. Mirrors backend serializers. */

export interface ApiErrorEnvelope {
  error: { code: string; message: string; field: string | null; next_step: string };
}

export class ApiError extends Error {
  code: string;
  field: string | null;
  nextStep: string;
  status: number;
  constructor(status: number, envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
    this.status = status;
    this.code = envelope.error.code;
    this.field = envelope.error.field;
    this.nextStep = envelope.error.next_step;
  }
}

export interface Business {
  id: number;
  name: string;
  business_type: string;
  currency: string;
  timezone: string;
  country: string;
  phone: string;
  email: string;
  address: string;
  logo_data: string;
  brand_color: string;
  enabled_modules: string[];
  settings: { knowledge?: Record<string, string> | string; [key: string]: unknown };
  role?: string;
}

export interface KnowledgeDocument {
  id: number;
  title: string;
  source_type: "paste" | "text" | "pdf" | string;
  original_filename: string;
  char_count: number;
  excerpt: string;
  content?: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: number;
  username: string;
  role: string;
  status: string;
  extra_permissions: string[];
  permissions: string[];
}

export interface SaleDocuments {
  sale_id: number;
  receipt_number: string | null;
  invoice_number: string;
  total?: string;
  lines?: { product: string; quantity: string; line_total: string }[];
  receipt_url: string;
  invoice_url: string;
}

export interface TrendPoint {
  period: string;
  sales: string | number;
  expenses: string | number;
  profit: string | number;
}

export interface TrendVisual {
  kind: "trend";
  from: string;
  to: string;
  granularity: string;
  totals: { sales?: string | number; expenses?: string | number; profit?: string | number };
  comparison: Record<string, { delta_pct?: number | null }>;
  series: TrendPoint[];
  top_products: { product: string; revenue: string | number }[];
  caveats: string[];
}

export interface TableVisual {
  kind: "table";
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  caveats: string[];
}

export type VisualPayload = TrendVisual | TableVisual;

export interface AnalyticsResult {
  from: string;
  to: string;
  granularity: string;
  series: { period: string; sales: string; expenses: string; profit: string }[];
  totals: { sales: string; expenses: string; profit: string; revenue: string; cogs: string };
  previous: { from: string; to: string; sales: string; expenses: string; profit: string };
  comparison: Record<string, { current: string; previous: string; delta_pct: number | null }>;
  top_products: { product: string; revenue: string; quantity: string }[];
  caveats: string[];
}

export interface DocumentPayload {
  receipt_number?: string;
  invoice_number?: string;
  issued_at: string;
  business: { name: string; currency: string; phone: string; email: string; address: string; brand_color: string };
  document: {
    receipt_number?: string;
    invoice_number?: string;
    business?: string;
    currency?: string;
    customer?: string;
    sold_at?: string;
    lines: { product: string; quantity: string; unit_price: string; line_total: string }[];
    subtotal: string;
    total: string;
  };
}

export interface BusinessContext {
  business: Business;
  role: string;
  permissions: string[];
  extra_permissions: string[];
  counts: { products: number; customers: number; suppliers: number };
  rules: {
    rule_type: string;
    structured_value: Record<string, unknown>;
    source: string;
    verified: boolean;
  }[];
}

export interface CatalogueItem {
  id: number;
  name: string;
  aliases: string[];
  kind: string;
  selling_price: string;
  cost_price: string | null;
  stock_tracked: boolean;
  active: boolean;
  quantity_on_hand: string | null;
}

export interface SaleLine {
  product: string;
  product_id: number;
  quantity: string;
  unit_price: string;
  line_total: string;
}

export interface Sale {
  id: number;
  customer: number | null;
  customer_name: string | null;
  status: string;
  subtotal: string;
  total: string;
  sold_at: string | null;
  items: SaleLine[];
  receipt_number: string | null;
}

export interface ReceiptLine {
  product: string;
  product_id: number;
  quantity: string;
  unit_cost: string;
  line_total: string;
}

export interface Purchase {
  id: number;
  supplier: number | null;
  supplier_name: string | null;
  status: string;
  total: string;
  items: ReceiptLine[];
  warnings?: string[];
}

export interface Expense {
  id: number;
  amount: string;
  category: string;
  description: string;
  date: string;
}

export interface ReportResult {
  metric: string;
  from: string;
  to: string;
  value?: string;
  revenue?: string;
  cogs?: string;
  rows?: { product: string; quantity: string; threshold: string }[];
  caveats: string[];
}

export interface ActivityEvent {
  id: number;
  actor_name: string | null;
  action_type: string;
  request_id: string;
  record_type: string;
  record_ref: string;
  status: string;
  summary: string;
  created_at: string;
}

export interface PendingActionPayload {
  id: number;
  action_type: string;
  state: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface AssistantReply {
  conversation_id: number;
  message_id: number;
  reply: string;
  state: string;
  action: PendingActionPayload | null;
  tool_calls: { tool: string; args: unknown; result: unknown }[];
  documents: SaleDocuments | null;
  visual: VisualPayload | null;
}

export interface ConfirmResult {
  id: number;
  action_type: string;
  state: string;
  reply: string;
  replayed: boolean;
  documents: SaleDocuments | null;
}
