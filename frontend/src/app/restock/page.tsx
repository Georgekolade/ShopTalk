/* Restock: table of stock-tracked products with per-row quick restock.
   Catalogue rows jump here with the item preselected. */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, biz } from "../../lib/api";
import { CatalogueItem } from "../../lib/types";
import { useBusinessContext, useSession } from "../../components/nav";
import { canDo } from "../../lib/permissions";
import { amount, humanNumber } from "../../lib/format";
import { toastError, toastSuccess } from "../../lib/toast";
import {
  ErrorNote,
  Loading,
  MobilePager,
  PageHeader,
  inputClass,
  paginate,
  primaryButtonClass,
  useMobilePager,
} from "../../components/ui";
import { DataTable } from "../../components/data-table";

const PRESELECT_KEY = "shoptalk.restockProduct";

export default function RestockPage() {
  const { ready, businessId } = useSession();
  const { context } = useBusinessContext();
  const canRestock = canDo(context, "stock.write");
  const [items, setItems] = useState<CatalogueItem[]>([]);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const cardRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const { page, prev, next } = useMobilePager(10);
  const { rows, pageCount, current } = paginate(items, page, 10);

  const load = useCallback(async () => {
    if (businessId === null) return;
    setLoading(true);
    setError(null);
    try {
      const catalogue = await api<CatalogueItem[]>(biz("/catalogue", businessId));
      const stockable = catalogue.filter((item) => item.active && item.stock_tracked);
      setItems(stockable);
      try {
        const pre = window.sessionStorage.getItem(PRESELECT_KEY);
        window.sessionStorage.removeItem(PRESELECT_KEY);
        if (pre && stockable.some((item) => String(item.id) === pre)) {
          setQuantities({ [pre]: "1" });
          setHighlighted(pre);
        }
      } catch {
        // Storage blocked: pick the item by hand.
      }
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

  useEffect(() => {
    if (highlighted) {
      rowRefs.current[highlighted]?.scrollIntoView({ block: "center" });
      cardRefs.current[highlighted]?.scrollIntoView({ block: "center" });
    }
  }, [highlighted, loading]);

  async function restock(item: CatalogueItem) {
    if (businessId === null || busy) return;
    const quantity = (quantities[String(item.id)] ?? "").trim();
    if (!quantity || Number(quantity) <= 0) {
      toastError(`Enter a quantity for ${item.name}.`);
      return;
    }
    setBusy(true);
    setSubmittingId(String(item.id));
    setError(null);
    try {
      await api(biz("/stock-receipts", businessId), {
        method: "POST",
        body: {
          items: [{ product_id: item.id, quantity }],
          idempotency_key: crypto.randomUUID(),
        },
      });
      const added = Number(quantity);
      setItems((old) =>
        old.map((row) =>
          row.id === item.id
            ? { ...row, quantity_on_hand: String(Number(row.quantity_on_hand ?? 0) + added) }
            : row,
        ),
      );
      setQuantities((old) => ({ ...old, [String(item.id)]: "" }));
      toastSuccess(`Receipt recorded: ${humanNumber(quantity)} × ${item.name}.`);
    } catch (err) {
      setError(err);
      toastError(err instanceof Error ? err.message : "Could not record receipt.");
    } finally {
      setBusy(false);
      setSubmittingId(null);
    }
  }

  if (!ready || businessId === null) return <Loading label="Loading restock…" />;

  return (
    <div>
      <PageHeader
        title="Restock"
        blurb="Pick an item, enter a quantity, record. Stock rises the moment you record."
        right={
          <Link href="/catalogue" className="text-sm font-semibold text-zinc-700 underline-offset-4 hover:underline">
            Back to catalogue
          </Link>
        }
      />
      <ErrorNote error={error} />
      {!canRestock ? (
        <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
          <h2 className="font-semibold text-zinc-900">Read only</h2>
          <p className="mt-1 text-sm text-zinc-600">Your role cannot record stock. Owners, managers and inventory roles can.</p>
        </section>
      ) : loading ? (
        <Loading label="Loading items…" />
      ) : items.length === 0 ? (
        <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
          <h2 className="font-semibold text-zinc-900">No stock-tracked items yet</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Add one in the <Link href="/catalogue" className="font-semibold underline underline-offset-4">catalogue</Link> first.
          </p>
        </section>
      ) : (
        <>
          <ul className="space-y-2 sm:hidden">
            {rows.map((item) => (
              <li
                key={item.id}
                ref={(el) => {
                  cardRefs.current[String(item.id)] = el;
                }}
                className={`rounded-2xl border bg-white p-4 ${highlighted === String(item.id) ? "border-green-800/40 shadow-[0_0_0_1px_rgba(22,101,52,0.25)]" : "border-zinc-200"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-zinc-900">{item.name}</p>
                    <p className="mt-0.5 text-xs tabular-nums text-zinc-600">
                      {humanNumber(item.quantity_on_hand)} in stock · {amount(item.selling_price)}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    className={`${inputClass} min-h-11 w-16 px-2 py-2 text-center tabular-nums`}
                    value={quantities[String(item.id)] ?? ""}
                    onChange={(e) => setQuantities((old) => ({ ...old, [String(item.id)]: e.target.value }))}
                    inputMode="decimal"
                    placeholder="Qty"
                    aria-label={`Quantity for ${item.name}`}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => restock(item)}
                    className={`${primaryButtonClass} flex-1 truncate`}
                  >
                    {submittingId === String(item.id) ? "Recording…" : "Restock"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <MobilePager page={current} pageCount={pageCount} totalLabel={`${items.length} items`} onPrev={prev} onNext={() => next(pageCount)} />
          <div className="hidden rounded-2xl border border-zinc-200 bg-white px-4 pb-4 sm:block">
            <DataTable
              title="Restock"
              tableKey={items.map((item) => `${item.id}-${item.quantity_on_hand}`).join("|")}
            >
              <thead>
                <tr>
                  <th className="all">Item</th>
                  <th className="min-tablet w-24 tabular-nums">In stock</th>
                  <th className="min-tablet w-28 tabular-nums">Price</th>
                  <th className="all w-20">Quantity</th>
                  <th className="all w-32"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr
                    key={item.id}
                    ref={(el) => {
                      rowRefs.current[String(item.id)] = el;
                    }}
                    className={`border-b border-zinc-100 last:border-0 ${highlighted === String(item.id) ? "bg-green-50/60" : ""}`}
                  >
                    <td className="px-4 py-3 font-medium text-zinc-900">{item.name}</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-700">{humanNumber(item.quantity_on_hand)}</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-700">{amount(item.selling_price)}</td>
                    <td className="px-4 py-3">
                      <input
                        className={`${inputClass} min-h-11 w-14 px-1 py-2 text-center tabular-nums`}
                        value={quantities[String(item.id)] ?? ""}
                        onChange={(e) => setQuantities((old) => ({ ...old, [String(item.id)]: e.target.value }))}
                        inputMode="decimal"
                        placeholder="0"
                        aria-label={`Quantity for ${item.name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => restock(item)}
                        className={primaryButtonClass}
                      >
                        {submittingId === String(item.id) ? "Recording…" : "Restock"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        </>
      )}
    </div>
  );
}
