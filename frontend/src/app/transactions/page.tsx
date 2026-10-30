/* Transactions: manual sale / stock receipt / expense forms plus history. */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  PackagePlus,
  Plus,
  Printer,
  ReceiptText,
  ShoppingCart,
  Trash2,
  Wallet,
} from "lucide-react";
import { api, apiBlob, biz, downloadBlob } from "../../lib/api";
import {
  CatalogueItem,
  Expense,
  Purchase,
  Sale,
} from "../../lib/types";
import { useBusinessContext, useSession } from "../../components/nav";
import { canDo } from "../../lib/permissions";
import { Select2 } from "../../components/select2";
import { DataTable } from "../../components/data-table";
import { amount } from "../../lib/format";
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
} from "../../components/ui";

interface DraftLine {
  product_id: string;
  quantity: string;
  unit_cost: string;
}

const EMPTY_LINE: DraftLine = { product_id: "", quantity: "1", unit_cost: "" };

const EXPENSE_PRESETS = ["Stock", "Transport", "Rent", "Salaries", "Utilities", "Other"];

function sumTotals(rows: { total?: string; amount?: string }[], key: "total" | "amount"): number {
  return rows.reduce((acc, row) => acc + (Number(row[key] ?? 0) || 0), 0);
}

function formatCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export default function TransactionsPage() {
  const { ready, businessId } = useSession();
  const { context } = useBusinessContext();
  const canSale = canDo(context, "sales.write");
  const canStock = canDo(context, "stock.write");
  const canExpense = canDo(context, "expenses.write");
  const [items, setItems] = useState<CatalogueItem[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [saleLines, setSaleLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }]);
  const [prepared, setPrepared] = useState<Sale | null>(null);
  const [saleBusy, setSaleBusy] = useState(false);

  const [receiptLines, setReceiptLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }]);
  const [receiptResult, setReceiptResult] = useState<Purchase | null>(null);
  const [receiptBusy, setReceiptBusy] = useState(false);

  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("");
  const [expenseNote, setExpenseNote] = useState("");
  const [expenseBusy, setExpenseBusy] = useState(false);

  const [downloading, setDownloading] = useState<string | null>(null);
  const { page: salePage, prev: salePrev, next: saleNext, reset: resetSalePage } = useMobilePager(5);
  const { page: expensePage, prev: expensePrev, next: expenseNext, reset: resetExpensePage } = useMobilePager(5);

  const load = useCallback(async () => {
    if (businessId === null) return;
    setLoading(true);
    setError(null);
    try {
      const [catalogue, saleList, expenseList] = await Promise.all([
        api<CatalogueItem[]>(biz("/catalogue", businessId)),
        api<Sale[]>(biz("/sales", businessId)),
        api<Expense[]>(biz("/expenses", businessId)),
      ]);
      setItems(catalogue.filter((item) => item.active));
      setSales(saleList);
      setExpenses(expenseList);
      resetSalePage();
      resetExpensePage();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [businessId, resetSalePage, resetExpensePage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    if (ready) load();
  }, [ready, load]);

  const salesTotal = useMemo(() => sumTotals(sales, "total"), [sales]);
  const expensesTotal = useMemo(() => sumTotals(expenses, "amount"), [expenses]);
  const { rows: mobileSales, pageCount: salePages, current: saleCurrent } = paginate(sales, salePage, 5);
  const { rows: mobileExpenses, pageCount: expensePages, current: expenseCurrent } = paginate(expenses, expensePage, 5);

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
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setSaleBusy(false);
    }
  }

  async function receiveStock() {
    if (businessId === null) return;
    setReceiptBusy(true);
    setError(null);
    setReceiptResult(null);
    try {
      const purchase = await api<Purchase>(biz("/stock-receipts", businessId), {
        method: "POST",
        body: {
          items: linePayload(receiptLines, true),
          idempotency_key: crypto.randomUUID(),
        },
      });
      setReceiptResult(purchase);
      setReceiptLines([{ ...EMPTY_LINE }]);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setReceiptBusy(false);
    }
  }

  async function saveExpense(event: React.FormEvent) {
    event.preventDefault();
    if (businessId === null) return;
    setExpenseBusy(true);
    setError(null);
    try {
      await api(biz("/expenses", businessId), {
        method: "POST",
        body: {
          amount: expenseAmount,
          category: expenseCategory,
          description: expenseNote,
        },
      });
      setExpenseAmount("");
      setExpenseCategory("");
      setExpenseNote("");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setExpenseBusy(false);
    }
  }

  function docFileName(sale: Sale, kind: "receipt" | "invoice"): string {
    const business = (context?.business?.name ?? "ShopTalk").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "ShopTalk";
    const number = kind === "receipt"
      ? sale.receipt_number ?? `R-${String(sale.id).padStart(6, "0")}`
      : `INV-${String(sale.id).padStart(6, "0")}`;
    const label = kind === "receipt" ? "Receipt" : "Invoice";
    return `${business}-${label}-${number}.pdf`;
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
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-green-800 transition-colors hover:bg-green-50"
        >
          <Plus aria-hidden className="h-4 w-4" /> Add row
        </button>
      </div>
    );
  }

  if (!ready || businessId === null) return <Loading label="Loading transactions…" />;

  const showActions = canSale || canStock || canExpense;

  return (
    <div>
      <PageHeader
        title="Transactions"
        blurb="Record sales, stock receipts, and expenses directly. Same backend as the assistant."
        right={
          !loading ? (
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-800 px-3 py-1.5 font-semibold text-white">
                {formatCount(sales.length, "sale", "sales")} · {amount(salesTotal)}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 font-semibold text-white">
                {formatCount(expenses.length, "expense", "expenses")} · {amount(expensesTotal)}
              </span>
            </div>
          ) : undefined
        }
      />
      <ErrorNote error={error} />
      {loading ? (
        <Loading label="Loading history…" />
      ) : (
        <div className="space-y-4">
          {!showActions ? (
            <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
              <h2 className="font-semibold text-zinc-900">Read only</h2>
              <p className="mt-1 text-sm text-zinc-600">Your role can view history, reports and the catalogue. It cannot record sales, stock or expenses.</p>
            </section>
          ) : null}

          <div className={`grid grid-cols-1 gap-4 ${canSale && canStock ? "lg:grid-cols-2" : "max-w-3xl"}`}>
            {canSale ? (
              <section aria-labelledby="new-sale-heading" className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
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
            ) : null}

            {canStock ? (
              <section aria-labelledby="receive-stock-heading" className="flex flex-col rounded-2xl border border-amber-900/20 bg-amber-50/50 p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-700 text-white">
                    <PackagePlus className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">Restock · one step</p>
                    <h2 id="receive-stock-heading" className="font-semibold text-zinc-900">Receive stock</h2>
                    <p className="mt-0.5 text-xs text-zinc-600">Owners, managers and inventory roles. Stock rises the moment you record.</p>
                  </div>
                </div>
                <div className="mt-4 flex-1">
                  {lineEditor(receiptLines, setReceiptLines, true, "Pick item…")}
                </div>
                {receiptResult ? (
                  <p className="mt-3 rounded-xl border border-green-800/25 bg-green-50 px-3 py-2.5 text-sm text-green-900">
                    Receipt recorded: {formatCount(receiptResult.items.length, "line", "lines")}, total{" "}
                    {amount(receiptResult.total)}.
                    {(receiptResult.warnings ?? []).map((w) => ` Warning: ${w}`).join("")}
                  </p>
                ) : (
                  <p className="mt-3 rounded-xl bg-amber-100/70 px-3 py-2.5 text-xs text-amber-950">
                    Tip: leave unit cost empty to keep the current cost price.
                  </p>
                )}
                <div className="mt-3">
                  <button
                    type="button"
                    disabled={receiptBusy}
                    onClick={receiveStock}
                    className={`${primaryButtonClass} w-full sm:w-auto`}
                  >
                    {receiptBusy ? "Recording…" : "Record receipt"}
                  </button>
                </div>
              </section>
            ) : null}
          </div>

          {canExpense ? (
            <section aria-labelledby="record-expense-heading" className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-white">
                    <Wallet className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Spend · one step</p>
                    <h2 id="record-expense-heading" className="font-semibold text-zinc-900">Record expense</h2>
                    <p className="mt-0.5 text-xs text-zinc-600">Owners, managers and finance roles. Pick a category or type your own.</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick categories">
                  {EXPENSE_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setExpenseCategory(preset)}
                      className={`min-h-11 rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                        expenseCategory === preset
                          ? "bg-zinc-900 text-white"
                          : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>
              <form onSubmit={saveExpense} className="mt-4 grid gap-3 md:grid-cols-[160px_200px_1fr_auto]">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-zinc-700">Amount</span>
                  <input
                    className={`${inputClass} tabular-nums`}
                    value={expenseAmount}
                    onChange={(e) => setExpenseAmount(e.target.value)}
                    required
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-zinc-700">Category</span>
                  <input
                    className={inputClass}
                    value={expenseCategory}
                    onChange={(e) => setExpenseCategory(e.target.value)}
                    required
                    placeholder="e.g. Transport"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-zinc-700">Note <span className="font-normal text-zinc-500">(optional)</span></span>
                  <input
                    className={inputClass}
                    value={expenseNote}
                    onChange={(e) => setExpenseNote(e.target.value)}
                    placeholder="What was this for?"
                  />
                </label>
                <div className="flex items-end">
                  <button
                    type="submit"
                    disabled={expenseBusy}
                    className={`${primaryButtonClass} w-full sm:w-auto`}
                  >
                    {expenseBusy ? "Saving…" : "Save expense"}
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          <div className={`grid grid-cols-1 gap-4 ${canExpense ? "xl:grid-cols-5" : ""}`}>
            <section aria-labelledby="sales-history-heading" className={`rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 ${canExpense ? "xl:col-span-3" : ""}`}>
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
                          <StateBadge state={sale.status} />
                        </div>
                        <div className="mt-1.5 flex items-baseline justify-between gap-2 tabular-nums">
                          <p className="text-sm font-semibold text-zinc-900">{amount(sale.total)}</p>
                          <p className="shrink-0 text-xs text-zinc-500">
                            {sale.items.length} item{sale.items.length === 1 ? "" : "s"}{sale.sold_at ? ` · ${sale.sold_at.slice(0, 10)}` : ""}
                          </p>
                        </div>
                        {sale.status === "committed" && businessId !== null ? (
                          <div className="mt-2.5 flex gap-2">
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

            {canExpense ? (
            <section aria-labelledby="expenses-history-heading" className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 xl:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-900/10 text-zinc-900">
                    <Wallet className="h-4.5 w-4.5" />
                  </span>
                  <div>
                    <h2 id="expenses-history-heading" className="font-semibold text-zinc-900">Recent expenses</h2>
                    <p className="text-xs text-zinc-500">{formatCount(expenses.length, "expense", "expenses")} · {amount(expensesTotal)} total</p>
                  </div>
                </div>
              </div>
              <div className="mt-3">
                {expenses.length === 0 ? (
                  <p className="rounded-xl bg-zinc-100 px-4 py-6 text-center text-sm text-zinc-600">No expenses yet. Every recorded expense lands here.</p>
                ) : (
                  <>
                  <ul className="space-y-2 sm:hidden">
                    {mobileExpenses.map((expense) => (
                      <li key={expense.id} className="rounded-xl bg-zinc-50 px-3.5 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex min-w-0 items-center rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-800">
                            <span className="truncate">{expense.category}</span>
                          </span>
                          <p className="shrink-0 text-sm font-semibold tabular-nums text-zinc-900">{amount(expense.amount)}</p>
                        </div>
                        <p className="mt-1 truncate text-xs text-zinc-500">
                          {expense.date}{expense.description ? ` · ${expense.description}` : ""}
                        </p>
                      </li>
                    ))}
                  </ul>
                  <MobilePager
                    page={expenseCurrent}
                    pageCount={expensePages}
                    totalLabel={formatCount(expenses.length, "expense", "expenses")}
                    onPrev={expensePrev}
                    onNext={() => expenseNext(expensePages)}
                  />
                  <div className="hidden sm:block">
                  <DataTable title="Expenses" tableKey={expenses.map((e) => e.id).join("|")} exportable={canExpense}>
                    <thead>
                      <tr><th className="all">Category</th><th className="all">Amount</th><th className="all">Date</th><th className="none">Note</th></tr>
                    </thead>
                    <tbody>
                      {expenses.map((expense) => (
                        <tr key={expense.id}>
                          <td>
                            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-800">
                              {expense.category}
                            </span>
                          </td>
                          <td className="font-medium tabular-nums">{amount(expense.amount)}</td>
                          <td className="whitespace-nowrap">{expense.date}</td>
                          <td>{expense.description || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                  </div>
                  </>
                )}
              </div>
            </section>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

