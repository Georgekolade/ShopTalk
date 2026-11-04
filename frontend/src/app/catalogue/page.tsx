/* Catalogue: list, create, edit, deactivate, CSV import with preview. */

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, biz } from "../../lib/api";
import { ApiError, CatalogueItem } from "../../lib/types";
import { useBusinessContext, useSession } from "../../components/nav";
import { Select2, enumOptions } from "../../components/select2";
import { amount, humanNumber } from "../../lib/format";
import { DataTable } from "../../components/data-table";
import { canDo } from "../../lib/permissions";
import { toastError, toastSuccess } from "../../lib/toast";
import { PackagePlus, X } from "lucide-react";
import {
  ErrorNote,
  Loading,
  MobilePager,
  PageHeader,
  inputClass,
  paginate,
  primaryButtonClass,
  secondaryButtonClass,
  useMobilePager,
} from "../../components/ui";

interface ImportRow {
  row: number;
  name: string;
  selling_price: string;
}

interface ImportResult {
  preview: boolean;
  valid_count?: number;
  invalid_count?: number;
  created?: number;
  rejected?: number;
  rows?: ImportRow[];
  errors: { row: number; field: string; message: string }[];
}

const EMPTY_FORM = {
  name: "",
  aliases: "",
  kind: "product",
  selling_price: "",
  cost_price: "",
  stock_tracked: true,
  active: true,
  opening_quantity: "",
};

export default function CataloguePage() {
  const router = useRouter();
  const { ready, businessId } = useSession();
  const { context } = useBusinessContext();
  const canWrite = canDo(context, "catalogue.write");
  const canRestock = canDo(context, "stock.write");
  const [modalOpen, setModalOpen] = useState(false);
  const [items, setItems] = useState<CatalogueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const { page: itemPage, prev: itemPrev, next: itemNext, reset: resetItemPage } = useMobilePager(8);

  const load = useCallback(async () => {
    if (businessId === null) return;
    setLoading(true);
    setError(null);
    try {
      setItems(await api<CatalogueItem[]>(biz("/catalogue", businessId)));
      resetItemPage();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [businessId, resetItemPage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    if (ready) load();
  }, [ready, load]);

  function openAdd() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  function startEdit(item: CatalogueItem) {
    setEditingId(item.id);
    setModalOpen(true);
    setForm({
      name: item.name,
      aliases: item.aliases.join(", "),
      kind: item.kind,
      selling_price: item.selling_price,
      cost_price: item.cost_price ?? "",
      stock_tracked: item.stock_tracked,
      active: item.active,
      opening_quantity: "",
    });
  }

  function restock(item: CatalogueItem) {
    try {
      window.sessionStorage.setItem("shoptalk.restockProduct", String(item.id));
    } catch {
      // Storage blocked: pick the item by hand on the restock page.
    }
    router.push("/restock");
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (businessId === null) return;
    setSaving(true);
    setError(null);
    const body = {
      name: form.name,
      aliases: form.aliases.split(",").map((a) => a.trim()).filter(Boolean),
      kind: form.kind,
      selling_price: form.selling_price,
      cost_price: form.cost_price || null,
      stock_tracked: form.stock_tracked,
      active: form.active,
    };
    try {
      if (editingId === null) {
        const created = await api<CatalogueItem>(biz("/catalogue", businessId), { method: "POST", body });
        const opening = Number(form.opening_quantity);
        if (form.stock_tracked && opening > 0 && canRestock) {
          try {
            await api(biz("/stock-receipts", businessId), {
              method: "POST",
              body: {
                items: [{ product_id: created.id, quantity: form.opening_quantity }],
                idempotency_key: crypto.randomUUID(),
              },
            });
            toastSuccess("Item added with opening stock.");
          } catch (receiptError) {
            toastError("Item added, but the opening stock was not recorded.");
            setError(receiptError);
          }
        } else {
          toastSuccess("Item added.");
        }
      } else {
        await api(biz(`/catalogue/${editingId}`, businessId), {
          method: "PATCH",
          body,
        });
        toastSuccess("Item saved.");
      }
      closeModal();
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(
          new Error("Only owners, managers and inventory roles can change the catalogue."),
        );
      } else setError(err);
      toastError(err instanceof Error ? err.message : "Could not save item.");
    } finally {
      setSaving(false);
    }
  }

  async function runImport(file: File | undefined, preview: boolean) {
    if (!file || businessId === null) return;
    setImporting(true);
    setError(null);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const result = await api<ImportResult>(
        biz(`/catalogue/import?preview=${preview ? "true" : "false"}`, businessId),
        { method: "POST", form: formData },
      );
      setImportResult(result);
      if (!preview) {
        toastSuccess("Catalogue import finished.");
        await load();
      }
    } catch (err) {
      setError(err);
      toastError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  const { rows: mobileItems, pageCount: itemPages, current: itemCurrent } = paginate(items, itemPage, 8);

  if (!ready || businessId === null) return <Loading label="Loading catalogue…" />;

  return (
    <div>
      <PageHeader
        title="Catalogue"
        blurb="Products and services with prices, costs, and stock."
        right={
          canWrite ? (
            <button type="button" onClick={openAdd} className={primaryButtonClass}>
              Add item
            </button>
          ) : (
            <span className="rounded-full bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-600">Read only</span>
          )
        }
      />
      <ErrorNote error={error} />
      {loading ? (
        <Loading label="Loading items…" />
      ) : (
        <div className="rounded-2xl border border-zinc-200 bg-white px-4 pb-4">
          {items.length === 0 ? null : (
            <>
            <ul className="divide-y divide-zinc-100 sm:hidden">
              {mobileItems.map((item) => (
                <li key={item.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-900">{item.name}</p>
                    <p className="mt-0.5 truncate text-xs tabular-nums text-zinc-500">
                      {amount(item.selling_price)} · {item.stock_tracked ? `${humanNumber(item.quantity_on_hand)} in stock` : "Stock not tracked"} · {item.active ? "Active" : "Off"}
                    </p>
                  </div>
                  {canWrite ? (
                    <button
                      type="button"
                      onClick={() => startEdit(item)}
                      className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-semibold text-zinc-900 hover:bg-zinc-100"
                    >
                      Edit
                    </button>
                  ) : null}
                  {canRestock && item.stock_tracked ? (
                    <button
                      type="button"
                      onClick={() => restock(item)}
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-900 hover:bg-zinc-100"
                      aria-label={`Restock ${item.name}`}
                      title="Restock"
                    >
                      <PackagePlus aria-hidden className="h-5 w-5" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <MobilePager
              page={itemCurrent}
              pageCount={itemPages}
              totalLabel={`${items.length} items`}
              onPrev={itemPrev}
              onNext={() => itemNext(itemPages)}
            />
            </>
          )}
          <div className="hidden sm:block">
          <DataTable title="Catalogue" tableKey={`${canWrite ? "w" : "r"}|${items.map((i) => `${i.id}-${i.selling_price}-${i.quantity_on_hand}-${i.active}`).join("|")}`} exportable={canWrite}>
            <thead>
              <tr>
                <th className="all">Name</th>
                <th className="all">Price</th>
                <th className="min-tablet">Cost</th>
                <th className="min-tablet">Stock</th>
                <th className="none">Active</th>
                <th className="all">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="font-medium text-zinc-900">
                    <span className="block">{item.name}</span>
                    <span className="mt-0.5 block text-xs font-normal text-zinc-500 sm:hidden">
                      {item.stock_tracked ? `${humanNumber(item.quantity_on_hand)} in stock` : "Stock not tracked"} · {item.active ? "Active" : "Off"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap tabular-nums">{amount(item.selling_price)}</td>
                  <td className="tabular-nums">{item.cost_price ? amount(item.cost_price) : "-"}</td>
                  <td className="tabular-nums">{item.stock_tracked ? humanNumber(item.quantity_on_hand) : "Not tracked"}</td>
                  <td>{item.active ? "yes" : "no"}</td>
                  <td>
                    {canWrite ? (
                      <button type="button" onClick={() => startEdit(item)} className="inline-flex min-h-11 items-center font-semibold text-zinc-900 hover:underline">
                        Edit
                      </button>
                    ) : null}
                    {canRestock && item.stock_tracked ? (
                      <button type="button" onClick={() => restock(item)} className="ml-3 inline-flex min-h-11 items-center font-semibold text-zinc-900 hover:underline">
                        Restock
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          </div>
        </div>
      )}

      {modalOpen && canWrite ? (
        <div
          className="fixed inset-0 z-[90] flex items-end justify-center bg-zinc-950/45 p-0 sm:items-center sm:p-6"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="catalogue-modal-title" className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 id="catalogue-modal-title" className="text-lg font-semibold text-zinc-900">
                  {editingId === null ? "Add item" : "Edit item"}
                </h2>
                <p className="mt-0.5 text-sm text-zinc-600">
                  {editingId === null ? "Add a product or service to the catalogue." : `Editing ${form.name || "item"}. Changes save to this business only.`}
                </p>
              </div>
              <button type="button" onClick={closeModal} aria-label="Close" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-700 hover:bg-zinc-200">
                <X aria-hidden className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={save}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-zinc-700">Name</span>
            <input
              className={inputClass}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-zinc-700">Kind</span>
            <Select2 value={form.kind} onChange={(v) => setForm({ ...form, kind: v })} ariaLabel="Kind" options={enumOptions(["product", "service"])} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-zinc-700">
              Aliases (comma separated)
            </span>
            <input
              className={inputClass}
              value={form.aliases}
              onChange={(e) => setForm({ ...form, aliases: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-zinc-700">Selling price</span>
            <input
              className={inputClass}
              value={form.selling_price}
              onChange={(e) => setForm({ ...form, selling_price: e.target.value })}
              required
              inputMode="decimal"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-zinc-700">Cost (optional)</span>
            <input
              className={inputClass}
              value={form.cost_price}
              onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
              inputMode="decimal"
            />
          </label>
          {editingId === null && form.stock_tracked && canRestock ? (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-zinc-700">Opening quantity</span>
              <input
                className={inputClass}
                value={form.opening_quantity}
                onChange={(e) => setForm({ ...form, opening_quantity: e.target.value })}
                inputMode="decimal"
                placeholder="0"
                aria-label="Opening quantity"
              />
            </label>
          ) : null}
          <div className="flex items-end gap-4 pb-2 text-sm">
            <label className="flex items-center gap-2 text-zinc-700">
              <input
                type="checkbox"
                checked={form.stock_tracked}
                onChange={(e) => setForm({ ...form, stock_tracked: e.target.checked })}
              />
              Track stock
            </label>
            <label className="flex items-center gap-2 text-zinc-700">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              Active
            </label>
          </div>
        </div>
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" onClick={closeModal} className={secondaryButtonClass}>
                  Cancel
                </button>
                <button type="submit" disabled={saving} className={primaryButtonClass}>
                  {saving ? "Saving..." : editingId === null ? "Add item" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {canWrite ? (
      <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
        <h2 className="font-semibold text-zinc-900">Import catalogue</h2>
        <p className="mt-1 text-sm leading-relaxed text-zinc-600">
          CSV, TSV, XLSX, XLSM or legacy XLS. First row must be headers: name, kind,
          selling_price, cost_price, stock_tracked, active, opening_stock, aliases
          (pipe separated). Preview first, then import.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <input
            id="csv-file"
            type="file"
            accept=".csv,.tsv,.xlsx,.xlsm,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="w-full text-sm sm:w-auto"
          />
          <button
            type="button"
            disabled={importing}
            onClick={() =>
              runImport(
                (document.getElementById("csv-file") as HTMLInputElement)?.files?.[0],
                true,
              )
            }
            className={`${secondaryButtonClass} w-full sm:w-auto`}
          >
            Preview
          </button>
          <button
            type="button"
            disabled={importing}
            onClick={() =>
              runImport(
                (document.getElementById("csv-file") as HTMLInputElement)?.files?.[0],
                false,
              )
            }
            className={`${primaryButtonClass} w-full sm:w-auto`}
          >
            {importing ? "Working…" : "Import"}
          </button>
        </div>
        {importResult ? (
          <div className="mt-3 text-sm">
            {importResult.preview ? (
              <p className="text-zinc-700">
                {importResult.valid_count} valid, {importResult.invalid_count} invalid.
                Nothing written yet.
              </p>
            ) : (
              <p className="text-zinc-700">
                Created {importResult.created}, rejected {importResult.rejected}.
              </p>
            )}
            {importResult.rows && importResult.rows.length > 0 ? (
              <ul className="mt-2 space-y-1 text-zinc-600">
                {importResult.rows.slice(0, 8).map((row) => (
                  <li key={row.row} className="font-mono text-xs">
                    Row {row.row}: {row.name} - {amount(row.selling_price)}
                  </li>
                ))}
              </ul>
            ) : null}
            {importResult.errors.length > 0 ? (
              <ul className="mt-2 space-y-1 text-red-800">
                {importResult.errors.slice(0, 8).map((err, i) => (
                  <li key={i} className="text-xs">
                    row {err.row} ({err.field}): {err.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}

