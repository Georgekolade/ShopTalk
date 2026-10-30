/* Dashboard: sales trend, money split, top products, recent activity. */

"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from "chart.js";
import { ArrowDownRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { api, biz } from "../../lib/api";
import { ActivityEvent, AnalyticsResult, BusinessContext } from "../../lib/types";
import { brandFill, brandHex, deltaLabel, humanNumber, money } from "../../lib/format";
import { useSession } from "../../components/nav";
import { Card, ErrorNote, Loading, StateBadge } from "../../components/ui";

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Tooltip, Legend, Filler);

// Chart code loads on demand so phones don't pay the bundle cost up front.
const Line = dynamic(() => import("react-chartjs-2").then((m) => m.Line), {
  ssr: false,
  loading: () => <div className="skeleton h-48 rounded-xl sm:h-56" aria-hidden />,
});

type Preset = "week" | "month" | "year";

function rangeFor(preset: Preset): { from: string; to: string; granularity: string; label: string } {
  const to = new Date();
  const from = new Date(to);
  if (preset === "week") from.setDate(to.getDate() - 6);
  if (preset === "month") from.setDate(to.getDate() - 29);
  if (preset === "year") from.setFullYear(to.getFullYear() - 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: iso(from),
    to: iso(to),
    granularity: preset === "year" ? "month" : preset === "month" ? "week" : "day",
    label: preset === "week" ? "last 7 days" : preset === "month" ? "last 30 days" : "last 12 months",
  };
}

function DeltaPill({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined)
    return <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">new</span>;
  const up = value >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
        up ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
      }`}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {deltaLabel(value)} vs prior period
    </span>
  );
}

function ShareBar({ label, pct, value }: { label: string; pct: number; value: string }) {
  return (
    <div className="border-b border-zinc-100 py-3 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm text-zinc-700">{label}</p>
        <p className="text-sm font-semibold tabular-nums text-zinc-900">{value}</p>
      </div>
      <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-zinc-100" aria-hidden>
        <div className="h-full rounded-full bg-zinc-700" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </div>
      <p className="mt-1 text-right text-xs tabular-nums text-zinc-500">{pct.toFixed(0)}% of sales</p>
    </div>
  );
}

export default function DashboardPage() {
  const { ready, businessId } = useSession();
  const [preset, setPreset] = useState<Preset>("month");
  const [context, setContext] = useState<BusinessContext | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsResult | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (businessId === null) return;
    const range = rangeFor(preset);
    setLoading(true);
    setError(null);
    try {
      const [ctx, data, events] = await Promise.all([
        api<BusinessContext>(biz("/context", businessId)),
        api<AnalyticsResult>(
          biz(`/reports/analytics?from=${range.from}&to=${range.to}&granularity=${range.granularity}`, businessId),
        ),
        api<ActivityEvent[]>(biz("/activity?limit=8", businessId)),
      ]);
      setContext(ctx);
      setAnalytics(data);
      setActivity(events);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [businessId, preset]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    if (ready) load();
  }, [ready, load]);

  if (!ready || businessId === null) return <Loading label="Loading dashboard…" />;
  const currency = context?.business.currency ?? "";
  const brand = brandHex(context?.business?.brand_color, "#3f3f46");
  const brandWash = brandFill(context?.business?.brand_color, "14", "rgba(63,63,70,0.08)");
  const comparison = analytics?.comparison;
  const sales = Number(analytics?.totals.sales ?? 0);
  const expenses = Number(analytics?.totals.expenses ?? 0);
  const profit = Number(analytics?.totals.profit ?? 0);
  const share = (v: number) => (sales > 0 ? (v / sales) * 100 : 0);
  const topRevenue = Math.max(1, ...(analytics?.top_products ?? []).map((r) => Number(r.revenue)));

  return (
    <div>
      <h1 className="sr-only">Dashboard</h1>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 basis-56 text-sm text-zinc-600">
          {context ? `${context.business.name} · ` : ""}Sales in the {rangeFor(preset).label}, compared with the previous equal period.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-zinc-200 bg-white p-0.5" role="group" aria-label="Period">
            {(["week", "month", "year"] as Preset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPreset(p)}
                aria-pressed={preset === p}
                className={`min-h-11 rounded-full px-4 py-1.5 text-sm font-medium capitalize focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 ${
                  preset === p ? "bg-zinc-900 font-semibold text-white" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={load}
            aria-label="Refresh dashboard figures"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-4 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-300 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      <ErrorNote error={error} />
      {loading ? (
        <Loading label="Loading figures…" />
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[28px] font-semibold leading-none tracking-tight tabular-nums text-zinc-900">
                    {money(analytics?.totals.sales ?? "0", currency)}
                  </p>
                  <p className="mt-2 text-sm text-zinc-600">Total sales in the {rangeFor(preset).label}.</p>
                </div>
                <DeltaPill value={comparison?.sales.delta_pct} />
              </div>
              <div
                className="mt-5 h-48 sm:h-56"
                role="img"
                aria-label={`Sales trend chart for the ${rangeFor(preset).label}: ${money(analytics?.totals.sales ?? "0", currency)} total sales.`}
              >
                <Line
                  data={{
                    labels: (analytics?.series ?? []).map((s) => s.period.slice(5)),
                    datasets: [
                      {
                        label: "Sales",
                        data: (analytics?.series ?? []).map((s) => Number(s.sales)),
                        borderColor: brand,
                        backgroundColor: brandWash,
                        fill: true,
                        tension: 0.35,
                        pointRadius: 3,
                        pointBackgroundColor: brand,
                        borderWidth: 2,
                      },
                      {
                        label: "Expenses",
                        data: (analytics?.series ?? []).map((s) => Number(s.expenses)),
                        borderColor: "#d4d4d8",
                        backgroundColor: "transparent",
                        fill: false,
                        tension: 0.35,
                        pointRadius: 2,
                        pointBackgroundColor: "#d4d4d8",
                        borderWidth: 2,
                      },
                    ],
                  }}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: "index", intersect: false },
                    plugins: { legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 6, padding: 16, font: { size: 12 } } } },
                    layout: { padding: { bottom: 4 } },
                    scales: {
                      x: { grid: { display: false }, border: { display: false }, ticks: { color: "#71717a", font: { size: 11 } } },
                      y: { beginAtZero: true, grid: { color: "#f4f4f5" }, border: { display: false }, ticks: { color: "#71717a", font: { size: 11 }, maxTicksLimit: 5 } },
                    },
                  }}
                />
              </div>
            </Card>

            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[28px] font-semibold leading-none tracking-tight tabular-nums text-zinc-900">
                    {money(analytics?.totals.profit ?? "0", currency)}
                  </p>
                  <p className="mt-2 flex items-center gap-1.5 text-sm text-zinc-600">
                    <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-500" /> profit this period
                  </p>
                </div>
                <DeltaPill value={comparison?.profit.delta_pct} />
              </div>
              <div className="mt-3">
                <ShareBar label="Sales" pct={sales > 0 ? 100 : 0} value={money(analytics?.totals.sales ?? "0", currency)} />
                <ShareBar label="Expenses" pct={share(expenses)} value={money(analytics?.totals.expenses ?? "0", currency)} />
                <ShareBar label="Profit" pct={share(profit)} value={money(analytics?.totals.profit ?? "0", currency)} />
              </div>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="[padding:0]">
              <div className="px-4 pt-4 sm:px-5 sm:pt-5">
                <h2 className="text-[15px] font-semibold text-zinc-900">Top products</h2>
                <p className="mt-0.5 text-sm text-zinc-600">Best sellers in this period, ranked by revenue.</p>
              </div>
              {(analytics?.top_products ?? []).length === 0 ? (
                <p className="px-5 py-4 text-sm text-zinc-600">No sales in this period.</p>
              ) : (
                <>
                  <ul className="mt-3 space-y-3 px-4 sm:hidden">
                    {(analytics?.top_products ?? []).slice(0, 6).map((row) => (
                      <li key={row.product}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <p className="min-w-0 truncate font-medium text-zinc-900">{row.product}</p>
                          <p className="shrink-0 font-semibold tabular-nums text-zinc-900">{money(row.revenue, currency)}</p>
                        </div>
                        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-100" role="img" aria-label={`${row.product}: ${((Number(row.revenue) / topRevenue) * 100).toFixed(0)} percent of top product`}>
                          <div className="h-full rounded-full bg-zinc-700" style={{ width: `${Math.max(3, (Number(row.revenue) / topRevenue) * 100)}%` }} />
                        </div>
                        <p className="mt-1 text-xs tabular-nums text-zinc-500">
                          {humanNumber(row.quantity)} units · {((Number(row.revenue) / topRevenue) * 100).toFixed(0)}% of top
                        </p>
                      </li>
                    ))}
                  </ul>
                  <div className="hidden overflow-x-auto sm:block">
                  <table className="mt-3 w-full text-sm">
                    <thead>
                      <tr className="border-y border-zinc-100 text-left text-xs font-medium text-zinc-500">
                        <th scope="col" className="px-3 py-2.5 font-medium sm:px-5">Product</th>
                        <th scope="col" className="px-2 py-2.5 text-right font-medium sm:px-3">Units</th>
                        <th scope="col" className="px-3 py-2.5 text-right font-medium sm:px-5">Revenue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {(analytics?.top_products ?? []).slice(0, 6).map((row) => (
                        <tr key={row.product}>
                          <td className="max-w-36 px-3 py-2.5 sm:max-w-none sm:px-5">
                            <span className="block truncate rounded-md bg-zinc-100 px-2 py-1 font-medium text-zinc-800" title={row.product}>
                              {row.product}
                            </span>
                            <span className="ml-2 hidden text-xs tabular-nums text-zinc-500 xl:inline">
                              {((Number(row.revenue) / topRevenue) * 100).toFixed(0)}% of top
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-zinc-600 sm:px-3">{humanNumber(row.quantity)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums text-zinc-900 sm:px-5">{money(row.revenue, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                  <div className="border-t border-zinc-100 py-1.5 text-center">
                    <Link
                      href="/catalogue"
                      className="inline-block min-h-11 rounded-lg px-4 py-2.5 text-sm font-medium text-zinc-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
                    >
                      View all
                    </Link>
                  </div>
                </>
              )}
            </Card>

            <Card className="[padding:0]">
              <div className="px-4 pt-4 sm:px-5 sm:pt-5">
                <h2 className="text-[15px] font-semibold text-zinc-900">Recent activity</h2>
                <p className="mt-0.5 text-sm text-zinc-600">Latest recorded actions for this business.</p>
              </div>
              {activity.length === 0 ? (
                <p className="px-5 py-4 text-sm text-zinc-600">Nothing recorded yet.</p>
              ) : (
                <>
                  <ul className="mt-3 divide-y divide-zinc-100 border-t border-zinc-100 text-sm">
                    {activity.slice(0, 6).map((event) => (
                      <li key={event.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                        <span className="min-w-0 truncate text-zinc-800">{event.summary || event.action_type}</span>
                        <StateBadge state={event.status} />
                      </li>
                    ))}
                  </ul>
                  <div className="border-t border-zinc-100 py-1.5 text-center">
                    <Link
                      href="/activity"
                      className="inline-block min-h-11 rounded-lg px-4 py-2.5 text-sm font-medium text-zinc-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
                    >
                      View all
                    </Link>
                  </div>
                </>
              )}
            </Card>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { title: "Catalogue", text: "Products and services on sale.", value: context?.counts.products ?? 0, href: "/catalogue" },
              { title: "Customers", text: "People this business serves.", value: context?.counts.customers ?? 0, href: "/transactions" },
              { title: "Suppliers", text: "Suppliers this business buys from.", value: context?.counts.suppliers ?? 0, href: "/transactions" },
              { title: "Profit margin", text: "Profit as a share of sales.", value: `${share(profit).toFixed(1)}%`, href: context?.role === "sales" ? "/transactions" : "/reports" },
            ].map((item) => (
              <Card key={item.title}>
                <h2 className="text-[15px] font-semibold text-zinc-900">{item.title}</h2>
                <p className="mt-0.5 text-sm text-zinc-600">{item.text}</p>
                <p className="mt-4 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900">{item.value}</p>
                <Link
                  href={item.href}
                  className="mt-2 inline-block min-h-11 rounded-lg py-2.5 pr-4 text-sm font-medium text-zinc-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
                >
                  View all
                </Link>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
