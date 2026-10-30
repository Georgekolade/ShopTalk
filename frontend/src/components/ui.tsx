/* Shared presentational pieces. */

"use client";

import { useCallback, useState } from "react";
import { ApiError } from "../lib/types";

const STATE_STYLES: Record<string, string> = {
  draft: "bg-zinc-200/70 text-zinc-700",
  awaiting_confirmation: "bg-amber-200/70 text-amber-950",
  prepared: "bg-amber-200/70 text-amber-950",
  confirmed: "bg-sky-200/70 text-sky-950",
  completed: "bg-green-800 text-white",
  committed: "bg-green-800 text-white",
  received: "bg-green-800 text-white",
  failed: "bg-red-700 text-white",
  cancelled: "bg-red-700 text-white",
};

const STATE_DOTS: Record<string, string> = {
  draft: "bg-zinc-500",
  awaiting_confirmation: "bg-amber-600",
  prepared: "bg-amber-600",
  confirmed: "bg-sky-600",
  completed: "bg-green-200",
  committed: "bg-green-200",
  received: "bg-green-200",
  failed: "bg-red-200",
  cancelled: "bg-red-200",
};

export function StateBadge({ state }: { state: string }) {
  const label = state
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const style = STATE_STYLES[state] ?? STATE_STYLES.draft;
  const dot = STATE_DOTS[state] ?? STATE_DOTS.draft;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${style}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const nextStep = error instanceof ApiError ? error.nextStep : null;
  return (
    <div
      role="alert"
      className="animate-enter mt-3 flex gap-3 rounded-xl border border-red-800/20 bg-red-50 px-4 py-3 text-sm text-red-950"
    >
      <span aria-hidden className="font-bold">
        !
      </span>
      <span>
        <span className="font-semibold">{message}</span>
        {nextStep ? <span className="mt-0.5 block text-red-900">{nextStep}</span> : null}
      </span>
    </div>
  );
}

export function PageHeader({
  title,
  blurb,
  right,
}: {
  title: string;
  blurb?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          {title}
        </h1>
        {blurb ? <p className="mt-1 max-w-xl text-sm text-zinc-600">{blurb}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 ${className ?? ""}`}
    >
      {children}
    </section>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="space-y-3 py-6" aria-label={label} role="status">
      <div className="skeleton h-8 w-48 rounded-lg" />
      <div className="skeleton h-24 rounded-2xl" />
      <div className="skeleton h-24 rounded-2xl" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function staggerStyle(index: number): React.CSSProperties {
  return { animationDelay: `${Math.min(index, 8) * 40}ms` };
}

export const inputClass =
  "min-h-11 w-full rounded-[0.65rem] border border-zinc-900/15 bg-white px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-500 transition-colors hover:border-zinc-900/30 focus:border-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-800/15";

export const primaryButtonClass =
  "pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[0.65rem] bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonClass =
  "pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[0.65rem] border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 transition-colors hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";

export const tableHeadClass = "px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500";

export const tableCellClass = "px-4 py-2.5 text-sm";

/* Mobile list pagination: the stacked card lists on phones get the same
   paging the desktop tables get from DataTables. */
export function useMobilePager(pageSize: number) {
  const [page, setPage] = useState(0);
  const reset = useCallback(() => setPage(0), []);
  const prev = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);
  const next = useCallback(
    (pageCount: number) => setPage((p) => Math.min(Math.max(1, pageCount) - 1, p + 1)),
    [],
  );
  return { page, pageSize, reset, prev, next };
}

export function paginate<T>(items: T[], page: number, pageSize: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  return { rows: items.slice(current * pageSize, current * pageSize + pageSize), pageCount, current };
}

export function MobilePager({
  page,
  pageCount,
  totalLabel,
  onPrev,
  onNext,
}: {
  page: number;
  pageCount: number;
  totalLabel: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-2 sm:hidden">
      <button
        type="button"
        onClick={onPrev}
        disabled={page === 0}
        className={`${secondaryButtonClass} px-4`}
      >
        Previous
      </button>
      <p role="status" className="text-center text-xs tabular-nums text-zinc-500">
        Page {page + 1} of {pageCount} · {totalLabel}
      </p>
      <button
        type="button"
        onClick={onNext}
        disabled={page >= pageCount - 1}
        className={`${secondaryButtonClass} px-4`}
      >
        Next
      </button>
    </div>
  );
}
