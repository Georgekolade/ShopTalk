/* Activity log: every committed, failed, and confirmed action. */

"use client";

import { useCallback, useEffect, useState } from "react";
import { api, biz } from "../../lib/api";
import { canDo } from "../../lib/permissions";
import { ActivityEvent } from "../../lib/types";
import { useBusinessContext, useSession } from "../../components/nav";
import { Select2, enumOptions } from "../../components/select2";
import { DataTable } from "../../components/data-table";
import {
  ErrorNote,
  Loading,
  MobilePager,
  PageHeader,
  StateBadge,
  inputClass,
  paginate,
  primaryButtonClass,
  useMobilePager,
} from "../../components/ui";

export default function ActivityPage() {
  const { ready, businessId } = useSession();
  const { context } = useBusinessContext();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [status, setStatus] = useState("");
  const [actionType, setActionType] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const { page: eventPage, prev: eventPrev, next: eventNext, reset: resetEventPage } = useMobilePager(8);

  const load = useCallback(async () => {
    if (businessId === null) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (status) params.set("status", status);
      if (actionType) params.set("action_type", actionType);
      setEvents(await api<ActivityEvent[]>(biz(`/activity?${params}`, businessId)));
      resetEventPage();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [businessId, status, actionType, resetEventPage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    if (ready) load();
  }, [ready, load]);

  const { rows: mobileEvents, pageCount: eventPages, current: eventCurrent } = paginate(events, eventPage, 8);

  if (!ready || businessId === null) return <Loading label="Loading activity…" />;
  if (context && !canDo(context, "activity.view")) {
    return (
      <div>
        <PageHeader title="Activity" blurb="Audit trail: who did what, and how it ended." />
        <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
          <h2 className="font-semibold text-zinc-900">Not part of your role</h2>
          <p className="mt-1 text-sm text-zinc-600">Your sales records are on the Transactions page.</p>
        </section>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Activity"
        blurb="Audit trail: who did what, and how it ended."
      />
      <form
        className="mb-4 grid grid-cols-1 items-end gap-3 sm:flex sm:flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <label className="block w-full text-sm sm:w-80">
          <span className="mb-1 block font-medium text-zinc-700">Status</span>
          <Select2
            value={status}
            onChange={setStatus}
            ariaLabel="Status"
            options={[
              { value: "", label: "All" },
              ...enumOptions(["draft", "awaiting_confirmation", "confirmed", "completed", "failed"]),
            ]}
          />
        </label>
        <label className="block w-full text-sm sm:w-64">
          <span className="mb-1 block font-medium text-zinc-700">Action type</span>
          <input
            className={inputClass}
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
            placeholder="e.g. sale_commit"
          />
        </label>
        <button type="submit" disabled={loading} className={`${primaryButtonClass} w-full sm:w-auto`}>
          Filter
        </button>
      </form>
      <ErrorNote error={error} />
      {loading ? (
        <Loading label="Loading events…" />
      ) : events.length === 0 ? (
        <p className="text-sm text-zinc-600">No events match.</p>
      ) : (
        <div className="rounded-2xl border border-zinc-200 bg-white px-4 pb-4">
          {events.length === 0 ? null : (
            <>
            <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-white px-4 sm:hidden">
              {mobileEvents.map((event) => (
                <li key={event.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-800">{event.summary || event.action_type}</p>
                    <p className="mt-0.5 truncate text-xs text-zinc-500">
                      {new Date(event.created_at).toLocaleDateString()} · {event.actor_name ?? "-"} · {event.action_type}
                    </p>
                  </div>
                  <StateBadge state={event.status} />
                </li>
              ))}
            </ul>
            <MobilePager
              page={eventCurrent}
              pageCount={eventPages}
              totalLabel={`${events.length} events`}
              onPrev={eventPrev}
              onNext={() => eventNext(eventPages)}
            />
            </>
          )}
          <div className="hidden sm:block">
          <DataTable title="Activity" tableKey={events.map((e) => e.id).join("|")}>
            <thead>
              <tr>
                <th className="all">When</th>
                <th className="min-tablet">Actor</th>
                <th className="none">Action</th>
                <th className="all">Summary</th>
                <th className="min-mobile">Status</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="whitespace-nowrap text-zinc-600"><span className="sm:hidden">{new Date(event.created_at).toLocaleDateString()}</span><span className="hidden sm:inline">{new Date(event.created_at).toLocaleString()}</span></td>
                  <td>{event.actor_name ?? "-"}</td>
                  <td className="font-mono text-xs">{event.action_type}</td>
                  <td className="text-zinc-800"><span className="block max-w-40 truncate sm:max-w-none">{event.summary || "-"}</span></td>
                  <td>
                    <StateBadge state={event.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          </div>
        </div>
      )}
    </div>
  );
}
