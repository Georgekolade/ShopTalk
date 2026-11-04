/* Sales: manual sale form plus sales history. Sticky form card on the
   left, history table on the right. */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  Plus,
  Printer,
  ReceiptText,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { api, apiBlob, biz, downloadBlob } from "../../../lib/api";
import {
  CatalogueItem,
  Sale,
} from "../../../lib/types";
import { useBusinessContext, useSession } from "../../../components/nav";
import { canDo } from "../../../lib/permissions";
import { Select2 } from "../../../components/select2";
import { DataTable } from "../../../components/data-table";
import { amount } from "../../../lib/format";
import { toastError, toastSuccess } from "../../../lib/toast";
import {
  ErrorNote,
  Loading,
  MobilePager,
  PageHeader,
  StateBadge,
  inputClass,
  paginate,
  primaryButtonClass,
  secondaryButtonClass,
  useMobilePager,
} from "../../../components/ui";

interface DraftLine {
  product_id: string;
  quantity: string;
  unit_cost: string;
}

const EMPTY_LINE: DraftLine = { product_id: "", quantity: "1", unit_cost: "" };

function sumTotals(rows: { total?: string; amount?: string }[], key: "total" | "amount"): number {
  return rows.reduce((acc, row) => acc + (Number(row[key] ?? 0) || 0), 0);
}

function formatCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function docFileName(sale: Sale, kind: "receipt" | "invoice") {
  const business = "ShopTalk";
  const label = kind === "receipt" ? "Receipt" : "Invoice";
  const number = sale.receipt_number ?? `#${sale.id}`;
  return `${business}-${label}-${number}.pdf`;
}

export default function SalesPage() {
  const { ready, businessId } = useSession();
  const { context } = useBusinessContext();
  const canSale = canDo(context, "sales.write");
  const [items, setItems] = useState<CatalogueItem[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [saleLines, setSaleLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }]);
  const [prepared, setPrepared] = useState<Sale | null>(null);
  const [saleBusy, setSaleBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const { page: salePage, prev: salePrev, next: saleNext } = useMobilePager(5);

  const load = useCallback(async () => {
    if (businessId === null) return;
    setLoading(true);
    setError(null);
    try {
      const [catalogue, saleList] = await Promise.all([
        api<CatalogueItem[]>(biz("/catalogue", businessId)),
        api<Sale[]>(biz("/sales", businessId)),
      ]);
      setItems(catalogue.filter((item) => item.active));
      setSales(saleList);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    if (ready) load();
  }, [ready, load]);

  const salesTotal = useMemo(() => sumTotals(sales, "total"), [sales]);
  const { rows: mobileSales, pageCount: salePages, current: saleCurrent } = paginate(sales, salePage, 5);

  function linePayload(lines: DraftLine[], withCost: boolean) {
    return lines
      .filter((line) => line.product_id && Number(line.quantity) > 0)
      .map((line) => ({
        product_id: Number(line.product_id),
        quantity: line.quantity,
        ...(withCost && line.unit_cost ? { unit_cost: line.unit_cost } : {}),
      }));
  }

  async function prepareSale() {
    if (businessId === null) return;
    setSaleBusy(true);
    setError(null);
    setPrepared(null);
    try {
      const sale = await api<Sale>(biz("/sales/prepare", businessId), {
        method: "POST",
        body: {
          items: linePayload(saleLines, false),
          idempotency_key: crypto.randomUUID(),
        },
      });
      setPrepared(sale);
    } catch (err) {
      setError(err);
    } finally {
      setSaleBusy(false);
    }
  }

  async function commitSale() {
    if (businessId === null || !prepared) return;
    setSaleBusy(true);
    setError(null);
    try {
      await api(biz(`/sales/${prepared.id}/commit`, businessId), { method: "POST" });
      setPrepared(null);
      setSaleLines([{ ...EMPTY_LINE }]);
      toastSuccess("Sale committed. Stock updated.");
      await load();
    } catch (err) {
      setError(err);
      toastError(err instanceof Error ? err.message : "Could not commit sale.");
    } finally {
      setSaleBusy(false);
    }
  }

  async function downloadDocument(sale: Sale, kind: "receipt" | "invoice") {
    if (businessId === null || downloading) return;
    const key = `${kind}-${sale.id}`;
    setDownloading(key);
    setError(null);
    try {
      const blob = await apiBlob(biz(`/sales/${sale.id}/${kind}.pdf`, businessId));
      downloadBlob(blob, docFileName(sale, kind));
    } catch (err) {
      setError(err);
    } finally {
      setDownloading(null);
    }
  }

  // Receipts open the browser print pane (POS thermal printers take it
  // straight from there). The frame stays in layout at zero size because
  // Chrome will not print a display:none frame.
  async function printReceipt(sale: Sale) {
    if (businessId === null || downloading) return;
    const key = `receipt-${sale.id}`;
    setDownloading(key);
    setError(null);
    try {
      const blob = await apiBlob(biz(`/sales/${sale.id}/receipt.pdf`, businessId));
      const objectUrl = URL.createObjectURL(blob);
      const frame = document.createElement("iframe");
      frame.style.position = "fixed";
      frame.style.right = "0";
      frame.style.bottom = "0";
      frame.style.width = "0";
      frame.style.height = "0";
      frame.style.border = "0";
      frame.src = objectUrl;
      frame.onload = () => {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        window.setTimeout(() => {
          frame.remove();
          URL.revokeObjectURL(objectUrl);
        }, 60_000);
      };
      document.body.appendChild(frame);
    } catch (err) {
      setError(err);
    } finally {
      setDownloading(null);
    }
  }

  function updateLine(
    lines: DraftLine[],
    setLines: (lines: DraftLine[]) => void,
    index: number,
    patch: Partial<DraftLine>,
  ) {
    const next = [...lines];
    next[index] = { ...next[index], ...patch };
    setLines(next);
  }

  function removeLine(
    lines: DraftLine[],
    setLines: (lines: DraftLine[]) => void,
    index: number,
  ) {
    if (lines.length === 1) {
      setLines([{ ...EMPTY_LINE }]);
      return;
    }
    setLines(lines.filter((_, i) => i !== index));
  }

  function lineEditor(
    lines: DraftLine[],
    setLines: (lines: DraftLine[]) => void,
    withCost: boolean,
    emptyHint: string,
    onEdit?: () => void,
  ) {
    const pickedByRow = lines.map((_, index) =>
      new Set(
        lines
          .filter((_, i) => i !== index)
          .map((other) => other.product_id)
          .filter((id) => id !== ""),
      ),
    );
    return (
      <div className="space-y-2">
        <div
          className={`hidden gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 sm:grid ${withCost ? "sm:grid-cols-[1fr_84px_110px_36px]" : "sm:grid-cols-[1fr_84px_36px]"}`}
          aria-hidden
        >
          <span>Item</span>
          <span>Qty</span>
          {withCost ? <span>Unit cost</span> : null}
          <span />
        </div>
        {lines.map((line, index) => (
          <div
            key={index}
            className={`grid items-center gap-2 ${withCost ? "grid-cols-[minmax(0,1fr)_60px_76px_44px] sm:grid-cols-[minmax(0,1fr)_84px_110px_44px]" : "grid-cols-[minmax(0,1fr)_72px_44px] sm:grid-cols-[minmax(0,1fr)_84px_44px]"}`}
          >
            <div className="min-w-0">
              <Select2
                value={line.product_id}
                onChange={(v) => {
                  updateLine(lines, setLines, index, { product_id: v });
                  onEdit?.();
                }}
                ariaLabel={`Row ${index + 1} item`}
                placeholder={emptyHint}
                options={items
                  .filter((item) => line.product_id === String(item.id) || !pickedByRow[index].has(String(item.id)))
                  .map((item) => ({
                    value: String(item.id),
                    label: `${item.name} · ${amount(item.selling_price)}`,
                  }))}
              />
            </div>
            <input
              className={`${inputClass} min-h-11 px-2 py-2 text-center tabular-nums`}
              value={line.quantity}
              onChange={(e) => {
                updateLine(lines, setLines, index, { quantity: e.target.value });
                onEdit?.();
              }}
              inputMode="decimal"
              aria-label={`Row ${index + 1} quantity`}
            />
            {withCost ? (
              <input
                className={`${inputClass} min-h-11 px-2 py-2 tabular-nums`}
                value={line.unit_cost}
                onChange={(e) => updateLine(lines, setLines, index, { unit_cost: e.target.value })}
                inputMode="decimal"
                placeholder="0.00"
                aria-label={`Row ${index + 1} unit cost`}
              />
            ) : null}
            <button
              type="button"
              onClick={() => removeLine(lines, setLines, index)}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-700"
              aria-label={`Remove row ${index + 1}`}
              title="Remove row"
            >
              <Trash2 aria-hidden className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setLines([...lines, { ...EMPTY_LINE }])}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-1 text-sm font-semibold text-green-800 transition-colors hover:bg-green-50"
        >
          <Plus aria-hidden className="h-4 w-4" /> Add row
        </button>
      </div>
    );
  }

  if (!ready || businessId === null) return <Loading label="Loading sales…" />;

  return (
    <div>
      <PageHeader
        title="Sales"
        blurb="Record a sale in three steps. Same backend as the assistant."
        right={
          !loading ? (
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-800 px-3 py-1.5 font-semibold text-white">
                {formatCount(sales.length, "sale", "sales")} · {amount(salesTotal)}
              </span>
            </div>
          ) : undefined
        }
      />
      <ErrorNote error={error} />
      {loading ? (
        <Loading label="Loading…" />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
          {canSale ? (
            <section aria-labelledby="new-sale-heading" className="flex flex-col self-start rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 lg:sticky lg:top-6 lg:col-span-4">
              <div className="flex items-start gap-3">
                <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-800 text-white">
                  <ShoppingCart className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-green-800">Sell · 3 steps</p>
                  <h2 id="new-sale-heading" className="font-semibold text-zinc-900">New sale</h2>
                  <p className="mt-0.5 text-xs text-zinc-600">Add items, preview the total, then commit. Committing prints a receipt.</p>
                </div>
              </div>
              <div className="mt-4 flex-1">
                {lineEditor(saleLines, setSaleLines, false, "Pick item…", () => setPrepared(null))}
              </div>
              {prepared ? (
                <div className="mt-3 rounded-xl border border-green-800/25 bg-green-50 p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-zinc-900">
                    Total {amount(prepared.total)} <StateBadge state={prepared.status} />
                  </p>
                  <ul className="mt-1.5 space-y-1 text-zinc-700">
                    {prepared.items.map((line, i) => (
                      <li key={i} className="flex justify-between gap-2 tabular-nums">
                        <span>{line.product} × {line.quantity}</span>
                        <span className="font-medium">{amount(line.line_total)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mt-3 rounded-xl bg-zinc-100 px-3 py-2.5 text-xs text-zinc-600">
                  Step 1 of 3: add at least one item with a quantity, then preview the total.
                </p>
              )}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  disabled={saleBusy}
                  onClick={prepareSale}
                  className={`${secondaryButtonClass} w-full sm:w-auto`}
                >
                  {saleBusy && !prepared ? "Previewing…" : "Preview totals"}
                </button>
                <button
                  type="button"
                  disabled={saleBusy || !prepared}
                  onClick={commitSale}
                  className={`${primaryButtonClass} w-full sm:w-auto`}
                >
                  {saleBusy && prepared ? "Committing…" : "Commit sale"}
                </button>
              </div>
            </section>
          ) : (
            <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 lg:col-span-4">
              <h2 className="font-semibold text-zinc-900">Read only</h2>
              <p className="mt-1 text-sm text-zinc-600">Your role cannot record sales. Owners, managers and sales roles can.</p>
            </section>
          )}
          <section aria-labelledby="sales-history-heading" className={`rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 ${canSale ? "lg:col-span-8" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-800/10 text-green-900">
                  <ReceiptText className="h-4.5 w-4.5" />
                </span>
                <div>
                  <h2 id="sales-history-heading" className="font-semibold text-zinc-900">Sales history</h2>
                  <p className="text-xs text-zinc-500">{formatCount(sales.length, "sale", "sales")} · {amount(salesTotal)} total</p>
                </div>
              </div>
            </div>
            <div className="mt-3">
              {sales.length === 0 ? (
                <p className="rounded-xl bg-zinc-100 px-4 py-6 text-center text-sm text-zinc-600">No sales yet. Commit your first sale above and it lands here with a receipt.</p>
              ) : (
                <>
                <ul className="space-y-2 sm:hidden">
                  {mobileSales.map((sale) => (
                    <li key={sale.id} className="rounded-xl bg-zinc-50 px-3.5 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate text-sm font-semibold text-zinc-900">
                          #{sale.id} · {sale.customer_name ?? "Walk-in"}
                        </p>
                        <p className="shrink-0 text-sm font-semibold tabular-nums text-zinc-900">{amount(sale.total)}</p>
                      </div>
                      <p className="mt-1 text-xs tabular-nums text-zinc-500">
                        {sale.items.length} {sale.items.length === 1 ? "line" : "lines"}
                        {sale.sold_at ? ` · ${sale.sold_at.slice(0, 10)}` : ""}
                      </p>
                      <div className="mt-1"><StateBadge state={sale.status} /></div>
                      {sale.status === "committed" ? (
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            disabled={downloading !== null}
                            onClick={() => printReceipt(sale)}
                            title="POS receipt for thermal printers (80mm)"
                            className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-green-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                          >
                            <Printer aria-hidden className="h-4 w-4" />
                            {downloading === `receipt-${sale.id}` ? "…" : "Print"}
                          </button>
                          <button
                            type="button"
                            disabled={downloading !== null}
                            onClick={() => downloadDocument(sale, "invoice")}
                            className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 disabled:opacity-50"
                          >
                            <Download aria-hidden className="h-4 w-4" />
                            {downloading === `invoice-${sale.id}` ? "…" : "Invoice"}
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <MobilePager
                  page={saleCurrent}
                  pageCount={salePages}
                  totalLabel={formatCount(sales.length, "sale", "sales")}
                  onPrev={salePrev}
                  onNext={() => saleNext(salePages)}
                />
                <div className="hidden sm:block">
                <DataTable title="Sales history" tableKey={sales.map((s) => s.id).join("|")} exportable={canSale}>
                  <thead>
                    <tr><th className="all">Sale</th><th className="none">Items</th><th className="all">Total</th><th className="min-tablet">Receipt</th><th className="min-mobile">Status</th><th className="all">Documents</th></tr>
                  </thead>
                  <tbody>
                    {sales.map((sale) => (
                      <tr key={sale.id}>
                        <td>
                          <span className="font-semibold">#{sale.id}</span>
                          <span className="block text-xs text-zinc-500">
                            {sale.customer_name ?? "Walk-in"}
                            {sale.sold_at ? ` · ${sale.sold_at.slice(0, 10)}` : ""}
                          </span>
                          <span className="mt-1 block sm:hidden"><StateBadge state={sale.status} /></span>
                        </td>
                        <td className="tabular-nums">{sale.items.length}</td>
                        <td className="whitespace-nowrap font-medium tabular-nums">{amount(sale.total)}</td>
                        <td>{sale.receipt_number ?? "-"}</td>
                        <td><StateBadge state={sale.status} /></td>
                        <td>
                          {sale.status === "committed" && businessId !== null ? (
                            <span className="flex flex-wrap gap-x-3 gap-y-1">
                              <button
                                type="button"
                                disabled={downloading !== null}
                                onClick={() => printReceipt(sale)}
                                className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-green-800 hover:underline disabled:opacity-50"
                                title="POS receipt for thermal printers (80mm)"
                              >
                                <Printer aria-hidden className="h-3.5 w-3.5" />
                                {downloading === `receipt-${sale.id}` ? "…" : "Print"}
                              </button>
                              <button
                                type="button"
                                disabled={downloading !== null}
                                onClick={() => downloadDocument(sale, "invoice")}
                                className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-zinc-900 hover:underline disabled:opacity-50"
                                title="Branded invoice PDF"
                              >
                                <Download aria-hidden className="h-3.5 w-3.5" />
                                {downloading === `invoice-${sale.id}` ? "…" : "Invoice"}
                              </button>
                            </span>
                          ) : (
                            <span className="text-xs text-zinc-400">Commit to unlock</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
                </div>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
