/* Expenses: manual expense form plus expense history. Sticky form
   card on the left, history table on the right. */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Wallet } from "lucide-react";
import { api, biz } from "../../../lib/api";
import { Expense } from "../../../lib/types";
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
  inputClass,
  paginate,
  primaryButtonClass,
  useMobilePager,
} from "../../../components/ui";

const EXPENSE_PRESETS = ["Stock", "Transport", "Rent", "Salaries", "Utilities", "Other"];

function sumTotals(rows: { total?: string; amount?: string }[], key: "total" | "amount"): number {
  return rows.reduce((acc, row) => acc + (Number(row[key] ?? 0) || 0), 0);
}

function formatCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export default function ExpensesPage() {
  const { ready, businessId } = useSession();
  const { context } = useBusinessContext();
  const canExpense = canDo(context, "expenses.write");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("");
  const [expenseNote, setExpenseNote] = useState("");
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const { page: expensePage, prev: expensePrev, next: expenseNext } = useMobilePager(5);

  const load = useCallback(async () => {
    if (businessId === null) return;
    setLoading(true);
    setError(null);
    try {
      const expenseList = await api<Expense[]>(biz("/expenses", businessId));
      setExpenses(expenseList);
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

  const expensesTotal = useMemo(() => sumTotals(expenses, "amount"), [expenses]);
  const { rows: mobileExpenses, pageCount: expensePages, current: expenseCurrent } = paginate(expenses, expensePage, 5);

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
          category: expenseCategory || undefined,
          description: expenseNote || undefined,
        },
      });
      setExpenseAmount("");
      setExpenseCategory("");
      setExpenseNote("");
      toastSuccess("Expense recorded.");
      await load();
    } catch (err) {
      setError(err);
      toastError(err instanceof Error ? err.message : "Could not record expense.");
    } finally {
      setExpenseBusy(false);
    }
  }

  if (!ready || businessId === null) return <Loading label="Loading expenses…" />;

  return (
    <div>
      <PageHeader
        title="Expenses"
        blurb="Record spending as it happens. Same backend as the assistant."
        right={
          !loading ? (
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 font-semibold text-white">
                {formatCount(expenses.length, "expense", "expenses")} · {amount(expensesTotal)}
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
          {canExpense ? (
            <section aria-labelledby="record-expense-heading" className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 lg:sticky lg:top-6 lg:col-span-4 self-start">
              <div className="flex items-start gap-3">
                <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-white">
                  <Wallet className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Spend · one step</p>
                  <h2 id="record-expense-heading" className="font-semibold text-zinc-900">Record expense</h2>
                  <p className="mt-0.5 text-xs text-zinc-600">Pick a category or type your own.</p>
                </div>
              </div>
              <form onSubmit={saveExpense} className="mt-4 space-y-3">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-zinc-700">Amount</span>
                  <input
                    className={inputClass}
                    value={expenseAmount}
                    onChange={(e) => setExpenseAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label="Expense amount"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-zinc-700">Category</span>
                  <Select2
                    value={expenseCategory}
                    onChange={setExpenseCategory}
                    ariaLabel="Expense category"
                    placeholder="Pick a category…"
                    options={EXPENSE_PRESETS.map((preset) => ({ value: preset, label: preset }))}
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-zinc-700">Note (optional)</span>
                  <input
                    className={inputClass}
                    value={expenseNote}
                    onChange={(e) => setExpenseNote(e.target.value)}
                    placeholder="What was this for?"
                    aria-label="Expense note"
                  />
                </label>
                <div>
                  <button type="submit" disabled={expenseBusy} className={`${primaryButtonClass} w-full`}>
                    {expenseBusy ? "Saving…" : "Save expense"}
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 lg:col-span-4">
              <h2 className="font-semibold text-zinc-900">Read only</h2>
              <p className="mt-1 text-sm text-zinc-600">Your role cannot record expenses.</p>
            </section>
          )}
          <section aria-labelledby="expenses-history-heading" className={`rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 ${canExpense ? "lg:col-span-8" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-900/10 text-zinc-900">
                  <Wallet className="h-4 w-4" />
                </span>
                <div>
                  <h2 id="expenses-history-heading" className="font-semibold text-zinc-900">Expense history</h2>
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
        </div>
      )}
    </div>
  );
}
