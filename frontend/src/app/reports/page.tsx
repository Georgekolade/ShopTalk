/* Reports & analytics: KPIs, trends, profitability, top products, deep dives. */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from "chart.js";
import dynamic from "next/dynamic";

// Charts load on demand so phones skip the bundle until needed.
const Bar = dynamic(() => import("react-chartjs-2").then((m) => m.Bar), {
  ssr: false,
  loading: () => <div className="skeleton h-64 rounded-xl" aria-hidden />,
});
const Doughnut = dynamic(() => import("react-chartjs-2").then((m) => m.Doughnut), {
  ssr: false,
  loading: () => <div className="skeleton mx-auto mt-2 h-48 max-w-55 rounded-xl" aria-hidden />,
});
const Line = dynamic(() => import("react-chartjs-2").then((m) => m.Line), {
  ssr: false,
  loading: () => <div className="skeleton h-64 rounded-xl" aria-hidden />,
});
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CalendarRange,
  Coins,
  LineChart as LineChartIcon,
  PiggyBank,
  RefreshCw,
  Scale,
  Trophy,
} from "lucide-react";
import { api, biz } from "../../lib/api";
import { canDo } from "../../lib/permissions";
import { AnalyticsResult, BusinessContext, ReportResult } from "../../lib/types";
import { brandFill, brandHex, deltaLabel, humanNumber, money } from "../../lib/format";
import { useBusinessContext, useSession } from "../../components/nav";
import { Select2 } from "../../components/select2";
import { DataTable } from "../../components/data-table";
import {
  Card,
  ErrorNote,
  Loading,
  MobilePager,
  PageHeader,
  inputClass,
  paginate,
  primaryButtonClass,
  useMobilePager,
} from "../../components/ui";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
);

const METRICS = [
  { value: "sales_total", label: "Sales Total" },
  { value: "expenses_total", label: "Expenses Total" },
  { value: "profit", label: "Profit (Revenue minus Cost of Goods)" },
  { value: "low_stock", label: "Low Stock" },
];

type Preset = "week" | "month" | "year" | "custom";
type Granularity = "auto" | "day" | "week" | "month";
type TrendView = "line" | "bars";

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

function presetRange(preset: Exclude<Preset, "custom">): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  if (preset === "week") from.setDate(to.getDate() - 6);
  if (preset === "month") from.setDate(to.getDate() - 29);
  if (preset === "year") from.setFullYear(to.getFullYear() - 1);
  return { from: iso(from), to: iso(to) };
}

function autoGranularity(preset: Preset): "day" | "week" | "month" {
  if (preset === "year") return "month";
  if (preset === "week") return "day";
  return "week";
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? null : 100;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function formatPeriod(period: string, granularity: string): string {
  if (granularity === "month") return period.slice(0, 7);
  if (granularity === "week") return `w/c ${period.slice(5)}`;
  return period.slice(5);
}

function DeltaPill({ value, suffix }: { value: number | null | undefined; suffix?: string }) {
  if (value === null || value === undefined)
    return <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">new{suffix ? ` ${suffix}` : ""}</span>;
  const up = value >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
        up ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
      }`}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {deltaLabel(value)}{suffix ? ` ${suffix}` : ""}
    </span>
  );
}

function Sparkline({ points, stroke }: { points: number[]; stroke: string }) {
  const width = 120;
  const height = 36;
  const max = Math.max(...points, 0);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const coords = points.map((v, i) => `${(i * step).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-9 w-28" role="img" aria-label="Trend sparkline">
      <polyline points={coords.join(" ")} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const CHART_LEGEND = { position: "bottom" as const, labels: { usePointStyle: true, boxWidth: 6, padding: 16, font: { size: 12 } } };
const CHART_AXES = {
  x: { grid: { display: false }, border: { display: false }, ticks: { color: "#71717a", font: { size: 11 }, maxTicksLimit: 8 } },
  y: { beginAtZero: true, grid: { color: "#f4f4f5" }, border: { display: false }, ticks: { color: "#71717a", font: { size: 11 }, maxTicksLimit: 5 } },
};

export default function ReportsPage() {
  const { ready, businessId } = useSession();
  const { context } = useBusinessContext();
  const [currency, setCurrency] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [metric, setMetric] = useState("sales_total");
  const [preset, setPreset] = useState<Preset>("month");
  const [granularity, setGranularity] = useState<Granularity>("auto");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [trendView, setTrendView] = useState<TrendView>("line");
  const [result, setResult] = useState<ReportResult | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { page: lowPage, prev: lowPrev, next: lowNext, reset: resetLowPage } = useMobilePager(8);

  const applyPreset = useCallback((p: Preset) => {
    setPreset(p);
    if (p !== "custom") {
      const range = presetRange(p);
      setFrom(range.from);
      setTo(range.to);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- defer clock read past prerender
    applyPreset("month");
  }, [applyPreset]);

  const effectiveGranularity = granularity === "auto" ? autoGranularity(preset) : granularity;

  const run = useCallback(async () => {
    if (businessId === null || !from || !to) return;
    setLoading(true);
    setError(null);
    try {
      const [ctx, report, data] = await Promise.all([
        api<BusinessContext>(biz("/context", businessId)),
        api<ReportResult>(biz(`/reports?metric=${metric}&from=${from}&to=${to}`, businessId)),
        api<AnalyticsResult>(
          biz(`/reports/analytics?from=${from}&to=${to}&granularity=${effectiveGranularity}`, businessId),
        ),
      ]);
      setCurrency(ctx.business.currency);
      setBusinessName(ctx.business.name);
      setResult(report);
      setAnalytics(data);
      resetLowPage();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [businessId, metric, from, to, effectiveGranularity, resetLowPage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    if (ready && from && to) run();
  }, [ready, run, from, to]);

  const totals = useMemo(() => {
    const sales = Number(analytics?.totals.sales ?? 0);
    const expenses = Number(analytics?.totals.expenses ?? 0);
    const revenue = Number(analytics?.totals.revenue ?? 0);
    const cogs = Number(analytics?.totals.cogs ?? 0);
    const profit = Number(analytics?.totals.profit ?? 0);
    const prevSales = Number(analytics?.previous.sales ?? 0);
    const prevExpenses = Number(analytics?.previous.expenses ?? 0);
    return {
      sales, expenses, revenue, cogs, profit,
      net: sales - expenses,
      netDelta: pctChange(sales - expenses, prevSales - prevExpenses),
      margin: revenue > 0 ? (profit / revenue) * 100 : 0,
      cogsShare: revenue > 0 ? (cogs / revenue) * 100 : 0,
    };
  }, [analytics]);

  const brand = brandHex(context?.business?.brand_color, "#18181b");
  const brandWash = brandFill(context?.business?.brand_color, "12", "rgba(24,24,27,0.07)");
  const series = analytics?.series ?? [];
  const labels = series.map((s) => formatPeriod(s.period, analytics?.granularity ?? effectiveGranularity));
  const salesPoints = series.map((s) => Number(s.sales));
  const expensePoints = series.map((s) => Number(s.expenses));
  const profitPoints = series.map((s) => Number(s.profit));
  const topProducts = analytics?.top_products ?? [];
  const topRevenue = Math.max(1, ...topProducts.map((r) => Number(r.revenue)));
  const { rows: mobileLowStock, pageCount: lowPages, current: lowCurrent } = paginate(result?.rows ?? [], lowPage, 8);

  if (!ready || businessId === null) return <Loading label="Loading reports…" />;
  if (context && !canDo(context, "reports.view")) {
    return (
      <div>
        <PageHeader title="Reports & analytics" blurb="Sales records live on Transactions; this page is not part of your role." />
        <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
          <h2 className="font-semibold text-zinc-900">Not part of your role</h2>
          <p className="mt-1 text-sm text-zinc-600">Your sales records are on the Transactions page. Ask the owner if you need wider reports.</p>
        </section>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Reports & analytics"
        blurb={`${businessName ? `${businessName} · ` : ""}Every figure is calculated by the backend from saved records, compared with the previous equal period.`}
        right={
          <button
            type="button"
            onClick={run}
            disabled={loading}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-4 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50"
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" /> Refresh
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(
          [
            { p: "week" as Preset, label: "Week (WoW)" },
            { p: "month" as Preset, label: "Month (MoM)" },
            { p: "year" as Preset, label: "Year (YoY)" },
            { p: "custom" as Preset, label: "Custom" },
          ]
        ).map(({ p, label }) => (
          <button
            key={p}
            type="button"
            onClick={() => applyPreset(p)}
            aria-pressed={preset === p}
            className={`pressable rounded-full px-3.5 py-1.5 text-sm font-semibold ${preset === p ? "bg-green-900 text-white" : "border border-zinc-900/15 bg-white text-zinc-700"}`}
          >
            {label}
          </button>
        ))}
        <span className="ml-1 inline-flex min-w-0 items-center gap-1.5 break-words text-sm text-zinc-600">
          <CalendarRange aria-hidden className="h-4 w-4" />
          {analytics ? `${analytics.from} → ${analytics.to} vs ${analytics.previous.from} → ${analytics.previous.to}` : "Pick a period"}
        </span>
      </div>

      <form
        className="grid gap-3 rounded-2xl border border-zinc-900/10 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.05)] sm:grid-cols-2 sm:p-5 lg:grid-cols-[1fr_1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-zinc-700">From</span>
          <input type="date" className={inputClass} value={from} onChange={(e) => { setPreset("custom"); setFrom(e.target.value); }} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-zinc-700">To</span>
          <input type="date" className={inputClass} value={to} onChange={(e) => { setPreset("custom"); setTo(e.target.value); }} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-zinc-700">Detail</span>
          <Select2
            value={granularity}
            onChange={setGranularity}
            ariaLabel="Granularity"
            options={[
              { value: "auto", label: `Auto (${effectiveGranularity})` },
              { value: "day", label: "Daily" },
              { value: "week", label: "Weekly" },
              { value: "month", label: "Monthly" },
            ]}
          />
        </label>
        <div className="flex items-end">
          <button type="submit" disabled={loading} className={`${primaryButtonClass} w-full sm:w-auto`}>
            {loading ? "Running…" : "Run report"}
          </button>
        </div>
      </form>

      <div className="mt-4"><ErrorNote error={error} /></div>

      {loading && !analytics ? (
        <Loading label="Crunching numbers…" />
      ) : analytics ? (
        <div className="animate-enter mt-4 space-y-4">
          <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                label: "Total sales", value: money(analytics.totals.sales, currency),
                delta: analytics.comparison.sales.delta_pct, points: salesPoints, stroke: "#18181b",
                hint: "Committed sales in period.",
              },
              {
                label: "Total expenses", value: money(analytics.totals.expenses, currency),
                delta: analytics.comparison.expenses.delta_pct, points: expensePoints, stroke: "#b45309",
                hint: "Recorded spend in period.",
              },
              {
                label: "Net cash flow", value: money(String(totals.net), currency),
                delta: totals.netDelta, points: salesPoints.map((s, i) => s - expensePoints[i]), stroke: "#0f766e",
                hint: "Sales minus expenses.",
              },
              {
                label: "Gross profit", value: money(analytics.totals.profit, currency),
                delta: analytics.comparison.profit.delta_pct, points: profitPoints, stroke: "#15803d",
                hint: `Revenue minus cost of goods · ${totals.margin.toFixed(1)}% margin.`,
              },
            ].map((kpi) => (
              <Card key={kpi.label}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-zinc-600">{kpi.label}</p>
                  <DeltaPill value={kpi.delta} suffix="vs prior" />
                </div>
                <p className="mt-1.5 text-[26px] font-semibold leading-none tracking-tight tabular-nums text-zinc-900">
                  {kpi.value}
                </p>
                <div className="mt-2 flex items-end justify-between gap-2">
                  <p className="text-xs text-zinc-500">{kpi.hint}</p>
                  <Sparkline points={kpi.points} stroke={kpi.stroke} />
                </div>
              </Card>
            ))}
          </section>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-900">
                    {trendView === "line" ? <LineChartIcon aria-hidden className="h-4 w-4 text-zinc-500" /> : <BarChart3 aria-hidden className="h-4 w-4 text-zinc-500" />}
                    Money movement
                  </h2>
                  <p className="mt-0.5 text-sm text-zinc-600">
                    Sales, expenses and per-period balance across {series.length} {effectiveGranularity === "day" ? "days" : effectiveGranularity === "week" ? "weeks" : "months"}.
                  </p>
                </div>
                <div className="flex rounded-full border border-zinc-200 bg-white p-0.5" role="group" aria-label="Chart style">
                  {(["line", "bars"] as TrendView[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setTrendView(v)}
                      aria-pressed={trendView === v}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium capitalize ${trendView === v ? "bg-zinc-100 font-semibold text-zinc-900" : "text-zinc-600 hover:text-zinc-900"}`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-4 h-64">
                {trendView === "line" ? (
                  <Line
                    data={{
                      labels,
                      datasets: [
                        { label: "Sales", data: salesPoints, borderColor: brand, backgroundColor: brandWash, fill: true, tension: 0.35, pointRadius: 2, pointBackgroundColor: brand, borderWidth: 2 },
                        { label: "Expenses", data: expensePoints, borderColor: "#d97706", backgroundColor: "transparent", fill: false, tension: 0.35, pointRadius: 2, pointBackgroundColor: "#d97706", borderWidth: 2, borderDash: [5, 4] },
                        { label: "Period balance", data: profitPoints, borderColor: "#15803d", backgroundColor: "transparent", fill: false, tension: 0.35, pointRadius: 0, borderWidth: 2 },
                      ],
                    }}
                    options={{ responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend: CHART_LEGEND }, layout: { padding: { bottom: 4 } }, scales: CHART_AXES }}
                  />
                ) : (
                  <Bar
                    data={{
                      labels,
                      datasets: [
                        { label: "Sales", data: salesPoints, backgroundColor: brand, borderRadius: 3 },
                        { label: "Expenses", data: expensePoints, backgroundColor: "#f59e0b", borderRadius: 3 },
                      ],
                    }}
                    options={{ responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend: CHART_LEGEND }, layout: { padding: { bottom: 4 } }, scales: CHART_AXES }}
                  />
                )}
              </div>
            </Card>

            <Card>
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-900">
                <Scale aria-hidden className="h-4 w-4 text-zinc-500" /> Where each sale goes
              </h2>
              <p className="mt-0.5 text-sm text-zinc-600">Revenue split into cost of goods and gross profit.</p>
              {totals.revenue > 0 ? (
                <>
                  <div className="mx-auto mt-2 h-48 max-w-55">
                    <Doughnut
                      data={{
                        labels: ["Gross profit", "Cost of goods"],
                        datasets: [{ data: [totals.profit, totals.cogs], backgroundColor: ["#15803d", "#d4d4d8"], borderWidth: 2, borderColor: "#ffffff" }],
                      }}
                      options={{ responsive: true, maintainAspectRatio: false, cutout: "68%", plugins: { legend: CHART_LEGEND }, layout: { padding: { bottom: 4 } } }}
                    />
                  </div>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="flex items-center gap-1.5 text-zinc-600"><span aria-hidden className="h-2 w-2 rounded-full bg-emerald-600" /> Profit · {totals.margin.toFixed(1)}%</dt>
                      <dd className="font-semibold tabular-nums text-zinc-900">{money(analytics.totals.profit, currency)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="flex items-center gap-1.5 text-zinc-600"><span aria-hidden className="h-2 w-2 rounded-full bg-zinc-300" /> Cost of goods · {totals.cogsShare.toFixed(1)}%</dt>
                      <dd className="font-semibold tabular-nums text-zinc-900">{money(analytics.totals.cogs, currency)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3 border-t border-zinc-100 pt-2">
                      <dt className="text-zinc-600">Revenue</dt>
                      <dd className="font-semibold tabular-nums text-zinc-900">{money(analytics.totals.revenue, currency)}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="mt-4 rounded-xl bg-zinc-100 px-4 py-6 text-center text-sm text-zinc-600">No revenue in this period yet.</p>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-900">
                <Trophy aria-hidden className="h-4 w-4 text-zinc-500" /> Top products
              </h2>
              <p className="mt-0.5 text-sm text-zinc-600">Best sellers by revenue in this period.</p>
              {topProducts.length === 0 ? (
                <p className="mt-3 rounded-xl bg-zinc-100 px-4 py-6 text-center text-sm text-zinc-600">No sales in this period.</p>
              ) : (
                <ul className="mt-4 space-y-3.5">
                  {topProducts.map((row, i) => {
                    const revenue = Number(row.revenue);
                    const pct = topRevenue > 0 ? (revenue / topRevenue) * 100 : 0;
                    return (
                      <li key={row.product}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <p className="min-w-0 truncate font-medium text-zinc-900">
                            <span className="mr-2 tabular-nums text-zinc-400">{i + 1}</span>{row.product}
                          </p>
                          <p className="shrink-0 font-semibold tabular-nums text-zinc-900">{money(row.revenue, currency)}</p>
                        </div>
                        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-100" role="img" aria-label={`${row.product}: ${pct.toFixed(0)} percent of top product`}>
                          <div className="h-full rounded-full bg-green-800" style={{ width: `${Math.max(3, pct)}%` }} />
                        </div>
                        <p className="mt-1 text-xs tabular-nums text-zinc-500">{humanNumber(row.quantity)} units · {pct.toFixed(0)}% of best seller</p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card>
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-900">
                <PiggyBank aria-hidden className="h-4 w-4 text-zinc-500" /> Period comparison
              </h2>
              <p className="mt-0.5 text-sm text-zinc-600">
                {analytics.from} → {analytics.to} against {analytics.previous.from} → {analytics.previous.to}.
              </p>
              <ul className="mt-3 space-y-2 sm:hidden">
                {(
                  [
                    { key: "sales", label: "Sales" },
                    { key: "expenses", label: "Expenses" },
                    { key: "profit", label: "Gross profit" },
                  ] as const
                ).map(({ key, label }) => (
                  <li key={key} className="rounded-xl bg-zinc-50 px-3.5 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-zinc-900">{label}</p>
                      <DeltaPill value={analytics.comparison[key].delta_pct} />
                    </div>
                    <div className="mt-1.5 flex items-baseline justify-between gap-2 tabular-nums">
                      <p className="text-sm font-semibold text-zinc-900">{money(analytics.comparison[key].current, currency)}</p>
                      <p className="text-xs text-zinc-500">was {money(analytics.comparison[key].previous, currency)}</p>
                    </div>
                  </li>
                ))}
                <li className="rounded-xl bg-zinc-50 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-zinc-900">Net cash flow</p>
                    <DeltaPill value={totals.netDelta} />
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-2 tabular-nums">
                    <p className="text-sm font-semibold text-zinc-900">{money(String(totals.net), currency)}</p>
                    <p className="text-xs text-zinc-500">
                      was {money(String(Number(analytics.previous.sales) - Number(analytics.previous.expenses)), currency)}
                    </p>
                  </div>
                </li>
              </ul>
              <div className="hidden overflow-x-auto sm:block">
              <table className="mt-3 w-full min-w-[26rem] text-sm">
                <thead>
                  <tr className="border-y border-zinc-100 text-left text-xs font-medium text-zinc-500">
                    <th className="py-2.5 pr-2 font-medium">Metric</th>
                    <th className="px-2 py-2.5 text-right font-medium">Current</th>
                    <th className="px-2 py-2.5 text-right font-medium">Previous</th>
                    <th className="py-2.5 pl-2 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {(
                    [
                      { key: "sales", label: "Sales", icon: Coins },
                      { key: "expenses", label: "Expenses", icon: CalendarRange },
                      { key: "profit", label: "Gross profit", icon: PiggyBank },
                    ] as const
                  ).map(({ key, label }) => (
                    <tr key={key}>
                      <td className="py-2.5 pr-2 font-medium text-zinc-900">{label}</td>
                      <td className="px-2 py-2.5 text-right font-semibold tabular-nums">{money(analytics.comparison[key].current, currency)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-zinc-600">{money(analytics.comparison[key].previous, currency)}</td>
                      <td className="py-2.5 pl-2 text-right"><DeltaPill value={analytics.comparison[key].delta_pct} /></td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-2.5 pr-2 font-medium text-zinc-900">Net cash flow</td>
                    <td className="px-2 py-2.5 text-right font-semibold tabular-nums">{money(String(totals.net), currency)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-zinc-600">
                      {money(String(Number(analytics.previous.sales) - Number(analytics.previous.expenses)), currency)}
                    </td>
                    <td className="py-2.5 pl-2 text-right"><DeltaPill value={totals.netDelta} /></td>
                  </tr>
                </tbody>
              </table>
              </div>
              {(analytics.caveats ?? []).map((c, i) => (
                <p key={i} className="mt-2 text-xs text-amber-900">Note: {c}</p>
              ))}
            </Card>
          </div>

          <Card>
            <h2 className="text-[15px] font-semibold text-zinc-900">Deep dive</h2>
            <p className="mt-0.5 text-sm text-zinc-600">One trusted metric for the exact dates above.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="block max-w-md text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Metric</span>
                <Select2 value={metric} onChange={setMetric} ariaLabel="Metric" options={METRICS} />
              </label>
              <p className="text-sm text-zinc-600">{result ? `${result.from} to ${result.to}` : ""}</p>
            </div>
            {result ? (
              result.metric === "low_stock" ? (
                (result.rows ?? []).length === 0 ? (
                  <p className="mt-3 font-semibold text-zinc-900">No items below the threshold.</p>
                ) : (
                  <>
                  {mobileLowStock.length === 0 ? null : (
                    <>
                    <ul className="mt-3 space-y-2 sm:hidden">
                      {mobileLowStock.map((row) => (
                        <li key={row.product} className="flex items-center justify-between gap-2 rounded-xl bg-zinc-50 px-3.5 py-2.5">
                          <p className="min-w-0 truncate text-sm font-medium text-zinc-900">{row.product}</p>
                          <p className="shrink-0 text-xs tabular-nums text-zinc-600">
                            {row.quantity} left · min {row.threshold}
                          </p>
                        </li>
                      ))}
                    </ul>
                    <MobilePager
                      page={lowCurrent}
                      pageCount={lowPages}
                      totalLabel={`${(result.rows ?? []).length} items`}
                      onPrev={lowPrev}
                      onNext={() => lowNext(lowPages)}
                    />
                    </>
                  )}
                  <div className="mt-3 hidden sm:block">
                    <DataTable title="Low stock" tableKey={(result.rows ?? []).map((r) => r.product).join("|")}>
                      <thead>
                        <tr><th>Product</th><th>Quantity</th><th>Threshold</th></tr>
                      </thead>
                      <tbody>
                        {(result.rows ?? []).map((row) => (
                          <tr key={row.product}>
                            <td className="font-medium text-zinc-900">{row.product}</td>
                            <td className="tabular-nums">{row.quantity}</td>
                            <td className="tabular-nums">{row.threshold}</td>
                          </tr>
                        ))}
                      </tbody>
                    </DataTable>
                  </div>
                  </>
                )
              ) : (
                <>
                  <p className="mt-3 text-3xl font-semibold tabular-nums tracking-tight text-zinc-900">
                    {money(result.value ?? "0", currency)}
                  </p>
                  {result.metric === "profit" ? (
                    <p className="mt-1 text-sm text-zinc-600">
                      Revenue {money(result.revenue ?? "0", currency)} · Cost of goods {money(result.cogs ?? "0", currency)}
                    </p>
                  ) : null}
                </>
              )
            ) : null}
            {(result?.caveats ?? []).map((caveat, i) => (
              <p key={i} className="mt-2 text-sm text-amber-900">Note: {caveat}</p>
            ))}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
