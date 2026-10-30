/* Rich display blocks for assistant replies: KPI summaries, trend charts,
   and data tables. Pure UI: the backend decides what is chartable and
   ships the numbers inside the message visual payload. */

"use client";

import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { TableVisual, TrendVisual, VisualPayload } from "../lib/types";
import { amount, deltaLabel, money } from "../lib/format";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
);

// Charts load on demand so the chat bundle stays light until needed.
const Line = dynamic(() => import("react-chartjs-2").then((m) => m.Line), {
  ssr: false,
  loading: () => <div className="skeleton h-52 rounded-xl" aria-hidden />,
});

function num(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function Delta({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return null;
  const up = value > 0;
  const down = value < 0;
  return (
    <span
      className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
        up ? "bg-green-100 text-green-900" : down ? "bg-red-100 text-red-800" : "bg-zinc-100 text-zinc-600"
      }`}
    >
      {deltaLabel(value)}
    </span>
  );
}

function Caveats({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-2 space-y-1">
      {items.map((c, i) => (
        <p key={i} className="text-[11px] leading-relaxed text-zinc-500">
          Note: {c}
        </p>
      ))}
    </div>
  );
}

function TrendBlock({ visual, currency }: { visual: TrendVisual; currency: string }) {
  const labels = useMemo(() => visual.series.map((s) => s.period), [visual]);
  const data = useMemo(
    () => ({
      labels,
      datasets: [
        {
          label: "Sales",
          data: visual.series.map((s) => num(s.sales)),
          borderColor: "#14532d",
          backgroundColor: "rgba(20, 83, 45, 0.12)",
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: "#14532d",
        },
        {
          label: "Expenses",
          data: visual.series.map((s) => num(s.expenses)),
          borderColor: "#a1a1aa",
          backgroundColor: "transparent",
          borderDash: [5, 4],
          tension: 0.35,
          pointRadius: 2,
          pointBackgroundColor: "#a1a1aa",
        },
      ],
    }),
    [visual, labels],
  );

  const deltas = visual.comparison ?? {};
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/60">
      <div className="grid grid-cols-2 gap-px bg-zinc-200/70">
        <div className="bg-white px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Sales</p>
          <p className="mt-0.5 text-sm font-bold tabular-nums text-zinc-900">
            {currency ? money(visual.totals?.sales, currency) : amount(visual.totals?.sales)}
            <Delta value={deltas.sales?.delta_pct} />
          </p>
        </div>
        <div className="bg-white px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Expenses</p>
          <p className="mt-0.5 text-sm font-bold tabular-nums text-zinc-900">
            {currency ? money(visual.totals?.expenses, currency) : amount(visual.totals?.expenses)}
            <Delta value={deltas.expenses?.delta_pct} />
          </p>
        </div>
      </div>
      <div className="bg-white px-2 pb-1 pt-2">
        <div className="h-52" role="img" aria-label={`Sales trend from ${visual.from} to ${visual.to}`}>
          <Line
            data={data}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
                tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${amount(c.parsed.y)}` } },
              },
              scales: {
                x: { ticks: { font: { size: 10 }, maxTicksLimit: 6 }, grid: { display: false } },
                y: { ticks: { font: { size: 10 }, maxTicksLimit: 5 }, grid: { color: "#f4f4f5" } },
              },
            }}
          />
        </div>
        <p className="px-2 pb-1 pt-1 text-[11px] text-zinc-500">
          {visual.from} → {visual.to} · per {visual.granularity}
        </p>
      </div>
      {visual.top_products.length > 0 ? (
        <div className="border-t border-zinc-200 bg-white px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Top products</p>
          <ul className="mt-1 space-y-1">
            {visual.top_products.map((row, i) => (
              <li key={i} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-zinc-700">{row.product}</span>
                <span className="shrink-0 font-semibold tabular-nums text-zinc-900">
                  {currency ? money(row.revenue, currency) : amount(row.revenue)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {visual.caveats.length > 0 ? (
        <div className="border-t border-zinc-100 bg-white px-3 py-2">
          <Caveats items={visual.caveats} />
        </div>
      ) : null}
    </div>
  );
}

function TableBlock({ visual }: { visual: TableVisual }) {
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200">
      <p className="border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-bold text-zinc-900">{visual.title}</p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-white">
              {visual.columns.map((col, i) => (
                <th
                  key={i}
                  scope="col"
                  className={`border-b border-zinc-200 px-3 py-2 font-semibold text-zinc-500 ${
                    i === 0 ? "text-left" : "text-right"
                  }`}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visual.rows.map((row, r) => (
              <tr key={r} className="bg-white odd:bg-zinc-50/70">
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className={`border-b border-zinc-100 px-3 py-2 text-zinc-800 last:border-b-0 ${
                      c === 0 ? "text-left font-medium" : "text-right tabular-nums"
                    }`}
                  >
                    {cell ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visual.caveats.length > 0 ? (
        <div className="border-t border-zinc-100 bg-white px-3 py-2">
          <Caveats items={visual.caveats} />
        </div>
      ) : null}
    </div>
  );
}

export function VisualBlock({ visual, currency }: { visual: VisualPayload; currency: string }) {
  if (visual.kind === "trend") return <TrendBlock visual={visual} currency={currency} />;
  return <TableBlock visual={visual} />;
}
