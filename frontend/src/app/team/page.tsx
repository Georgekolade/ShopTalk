/* Team & roles: who can access this business and what each role may do. */

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Minus, Plus, UserPlus, Users, X } from "lucide-react";
import { api, biz } from "../../lib/api";
import { TeamMember } from "../../lib/types";
import { useBusinessContext, useSession } from "../../components/nav";
import { GRANTABLE_PERMISSIONS, PERMISSION_COLUMNS, ROLE_PERMISSIONS, can } from "../../lib/permissions";
import { titleCase } from "../../components/select2";
import { Select2 } from "../../components/select2";
import {
  ErrorNote,
  Loading,
  PageHeader,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "../../components/ui";
import { toastSuccess } from "../../lib/toast";

const ASSIGNABLE_ROLES = ["manager", "sales", "inventory"] as const;

const ROLE_BLURB: Record<string, string> = {
  owner: "Full access. Leads the business; cannot be changed here.",
  manager: "Runs the shop: sales, stock, expenses, reports. No team or setup.",
  sales: "Records sales, sees sale records, uses the assistant.",
  inventory: "Receives stock, manages the catalogue.",
};

const ROLE_DOT: Record<string, string> = {
  owner: "bg-zinc-900",
  manager: "bg-green-800",
  sales: "bg-sky-700",
  inventory: "bg-amber-700",
};

function ExtraPermChips({
  role,
  extras,
  onToggle,
  idPrefix,
}: {
  role: string;
  extras: string[];
  onToggle: (value: string) => void;
  idPrefix: string;
}) {
  const defaults = new Set(defaultsForRole(role));
  return (
    <div className="flex flex-wrap gap-1.5">
      {GRANTABLE_PERMISSIONS.map((perm) => {
        const locked = defaults.has(perm.value);
        const on = locked || extras.includes(perm.value);
        return (
          <button
            key={perm.value}
            type="button"
            id={`${idPrefix}-${perm.value}`}
            disabled={locked}
            onClick={() => onToggle(perm.value)}
            aria-pressed={on}
            title={locked ? `${perm.label} (included in the ${role} role)` : perm.label}
            className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
              locked
                ? "cursor-default border-green-200 bg-green-50 text-green-900"
                : on
                  ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700"
                  : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400 hover:text-zinc-900"
            }`}
          >
            {locked || on ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Plus aria-hidden className="h-3.5 w-3.5" />}
            {perm.label}
          </button>
        );
      })}
    </div>
  );
}

function defaultsForRole(role: string): string[] {
  const allowed = ROLE_PERMISSIONS[role] ?? [];
  if (allowed.includes("*")) return GRANTABLE_PERMISSIONS.map((p) => p.value);
  return GRANTABLE_PERMISSIONS.map((p) => p.value).filter((v) => allowed.includes(v));
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-800">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${ROLE_DOT[role] ?? "bg-zinc-400"}`} />
      <span className="capitalize">{role}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const active = status === "active";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        active ? "bg-green-800 text-white" : "bg-zinc-200 text-zinc-700"
      }`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${active ? "bg-green-200" : "bg-zinc-500"}`} />
      <span className="capitalize">{status}</span>
    </span>
  );
}

export interface MemberDraft {
  role: string;
  status: string;
  extras: string[];
}

function EditMemberModal({
  member,
  saving,
  onClose,
  onSave,
}: {
  member: TeamMember;
  saving: boolean;
  onClose: () => void;
  onSave: (draft: MemberDraft) => void;
}) {
  const [role, setRole] = useState(member.role);
  const [status, setStatus] = useState(member.status);
  const [extras, setExtras] = useState<string[]>(member.extra_permissions ?? []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dirty =
    role !== member.role ||
    status !== member.status ||
    [...extras].sort().join("|") !== [...(member.extra_permissions ?? [])].sort().join("|");

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-950/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${member.username}`}
      onClick={onClose}
    >
      <div
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-white">
            {member.username.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold text-zinc-900">{member.username}</h2>
            <div className="mt-0.5 flex flex-wrap gap-1.5">
              <RoleBadge role={member.role} />
              <StatusBadge status={member.status} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close editor"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-zinc-700">Role</span>
            <Select2
              value={role}
              onChange={(v) => {
                setRole(v);
                setExtras((old) => old.filter((p) => !new Set(defaultsForRole(v)).has(p)));
              }}
              ariaLabel={`Role for ${member.username}`}
              options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }))}
            />
          </label>
          <p className="text-xs text-zinc-500">{ROLE_BLURB[role] ?? ""}</p>

          <div>
            <span id={`status-label-${member.id}`} className="mb-1 block text-sm font-medium text-zinc-700">Status</span>
            <div className="flex w-fit rounded-full border border-zinc-200 p-0.5" role="group" aria-labelledby={`status-label-${member.id}`}>
              {(["active", "disabled"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  aria-pressed={status === s}
                  className={`min-h-11 rounded-full px-4 py-2 text-xs font-semibold capitalize ${
                    status === s ? "bg-zinc-900 text-white" : "text-zinc-600 hover:text-zinc-900"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-zinc-700">
              Extra permissions {extras.length > 0 ? <span className="text-zinc-500">({extras.length} added)</span> : null}
            </p>
            <ExtraPermChips
              role={role}
              extras={extras}
              onToggle={(v) => setExtras((old) => (old.includes(v) ? old.filter((x) => x !== v) : [...old, v]))}
              idPrefix={`member-${member.id}`}
            />
            <p className="mt-2 text-xs text-zinc-500">Green chips come with the role. Dark chips are extras you add.</p>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={onClose} className={`${secondaryButtonClass} w-full sm:w-auto`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => onSave({ role, status, extras })}
            className={dirty && !saving ? `${primaryButtonClass} w-full sm:w-auto` : `${primaryButtonClass} w-full opacity-40 sm:w-auto`}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TeamPage() {
  const { ready, businessId } = useSession();
  const { context } = useBusinessContext();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [denied, setDenied] = useState(false);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newRole, setNewRole] = useState("sales");
  const [adding, setAdding] = useState(false);

  const [savingId, setSavingId] = useState<number | null>(null);
  const [newExtras, setNewExtras] = useState<string[]>([]);
  const [editing, setEditing] = useState<TeamMember | null>(null);

  function toggleExtra(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  const isOwner = context?.role === "owner";

  const load = useCallback(async () => {
    if (businessId === null) return;
    setLoading(true);
    setError(null);
    setDenied(false);
    try {
      const list = await api<TeamMember[]>(biz("/team", businessId));
      setMembers(list);
    } catch (err) {
      if (err instanceof Error && /403|forbidden|manager/i.test(err.message)) setDenied(true);
      else setError(err);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    if (ready) load();
  }, [ready, load]);

  async function addMember(event: React.FormEvent) {
    event.preventDefault();
    if (businessId === null) return;
    setAdding(true);
    setError(null);
    try {
      const created = await api<{ username: string; role: string; user_created: boolean }>(
        biz("/team", businessId),
        { method: "POST", body: { username: username.trim(), password, role: newRole, extra_permissions: newExtras } },
      );
      setUsername("");
      setPassword("");
      setNewExtras([]);
      toastSuccess(
        created.user_created
          ? `${created.username} added as ${created.role}. They can sign in now.`
          : `${created.username} is now ${created.role}.`,
      );
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setAdding(false);
    }
  }

  async function saveMember(member: TeamMember, draft: MemberDraft) {
    if (businessId === null) return;
    setSavingId(member.id);
    setError(null);
    try {
      await api(biz(`/team/${member.id}`, businessId), {
        method: "PATCH",
        body: { role: draft.role, status: draft.status, extra_permissions: draft.extras },
      });
      toastSuccess(`${member.username} updated.`);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setSavingId(null);
    }
  }

  if (!ready || businessId === null) return <Loading label="Loading team…" />;

  const counts = ASSIGNABLE_ROLES.map((role) => ({
    role,
    count: members.filter((m) => m.role === role).length,
  }));
  const owners = members.filter((m) => m.role === "owner").length;

  return (
    <div>
      <PageHeader
        title="Team & roles"
        blurb={`${context?.business.name ?? "This business"} · control who can sign in and what each role may touch. Only the owner can change the team.`}
        right={
          !loading && members.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white">
              <Users aria-hidden className="h-3.5 w-3.5" />
              {members.length} member{members.length === 1 ? "" : "s"} · {owners} owner{owners === 1 ? "" : "s"}
            </span>
          ) : undefined
        }
      />
      <ErrorNote error={error} />

      {loading ? (
        <Loading label="Loading team…" />
      ) : denied || (context && !isOwner) ? (
        <div className="space-y-4">
          <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
            <h2 className="font-semibold text-zinc-900">Owner only</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Your role ({context?.role ?? "unknown"}) is for working in the business, not managing the team.
              Ask the owner to add people or change roles.
            </p>
          </section>
          <PermissionMatrix currentRole={context?.role} />
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-12">
          <div className="space-y-4 lg:sticky lg:top-6 lg:col-span-4">
          <section aria-labelledby="add-member-heading" className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-800 text-white">
                <UserPlus className="h-5 w-5" />
              </span>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-green-800">Invite</p>
                <h2 id="add-member-heading" className="font-semibold text-zinc-900">Add a team member</h2>
                <p className="mt-0.5 text-xs text-zinc-600">
                  Every login created here belongs to {context?.business?.name ?? "this business"} only. It never works in another business. New usernames can sign in with the password you set.
                </p>
              </div>
            </div>
            <form onSubmit={addMember} className="mt-4 grid gap-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Username</span>
                <input
                  className={inputClass}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoComplete="off"
                  placeholder="e.g. ama"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Password <span className="font-normal text-zinc-500">(new logins)</span></span>
                <input
                  className={inputClass}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder="Set for first sign-in"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Role</span>
                <Select2 value={newRole} onChange={setNewRole} ariaLabel="Role" options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }))} />
              </label>
              <div className="flex items-end">
                <button type="submit" disabled={adding} className={`${primaryButtonClass} w-full`}>
                  {adding ? "Adding…" : "Add member"}
                </button>
              </div>
            </form>
            <div className="mt-3 rounded-xl bg-zinc-50 p-3">
              <p className="mb-2 text-xs font-semibold text-zinc-700">
                Extra permissions on top of {newRole} {newExtras.length > 0 ? <span className="font-normal text-zinc-500">({newExtras.length} added)</span> : <span className="font-normal text-zinc-500">(optional)</span>}
              </p>
              <ExtraPermChips
                role={newRole}
                extras={newExtras}
                onToggle={(v) => setNewExtras((old) => toggleExtra(old, v))}
                idPrefix="member-new"
              />
            </div>
            <p className="mt-2 text-xs text-zinc-500">{ROLE_BLURB[newRole]}</p>
          </section>
          </div>
          <div className="space-y-4 lg:col-span-8">
          <section aria-labelledby="members-heading" className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
            <div className="flex flex-wrap items-center gap-2 p-4 sm:px-5">
              {counts.map(({ role, count }) => (
                <span key={role} className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700">
                  <span className="capitalize">{role}</span> · {count}
                </span>
              ))}
            </div>
            <h2 id="members-heading" className="sr-only">Members</h2>
            {members.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-zinc-600">No members yet.</p>
            ) : (
              <ul className="divide-y divide-zinc-100 border-t border-zinc-100">
                {members.map((member) => {
                  const locked = member.role === "owner";
                  const extraCount = member.extra_permissions?.length ?? 0;
                  return (
                    <li key={member.id} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-white">
                        {member.username.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-zinc-900">{member.username}</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <RoleBadge role={member.role} />
                          <StatusBadge status={member.status} />
                          {extraCount > 0 ? (
                            <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2.5 py-0.5 text-xs font-semibold text-green-900">
                              +{extraCount} extra
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {locked ? (
                        <span className="hidden shrink-0 text-xs text-zinc-500 sm:block">Cannot be changed here</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setEditing(member)}
                          className={`${secondaryButtonClass} shrink-0`}
                        >
                          Edit
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <PermissionMatrix currentRole={context?.role} />
          </div>
        </div>
      )}
      {editing && isOwner ? (
        <EditMemberModal
          key={editing.id}
          member={editing}
          saving={savingId === editing.id}
          onClose={() => setEditing(null)}
          onSave={(draft) => saveMember(editing, draft)}
        />
      ) : null}
    </div>
  );
}

const MATRIX_ROLES = ["owner", "manager", "sales", "inventory"];

/** Full permission grid: every role against every capability. Your row is highlighted. */
function PermissionMatrix({ currentRole }: { currentRole?: string }) {
  return (
    <section aria-labelledby="perm-matrix-heading" className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
      <h2 id="perm-matrix-heading" className="font-semibold text-zinc-900">Who can do what</h2>
      <p className="mt-0.5 text-xs text-zinc-600">The backend enforces this on every request. The app only shows options your role can use.</p>
      <ul className="mt-4 space-y-2 sm:hidden">
        {MATRIX_ROLES.map((role) => (
          <li
            key={role}
            className={`rounded-xl border px-3.5 py-3 ${role === currentRole ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 bg-white"}`}
          >
            <p className="text-sm font-semibold text-zinc-900">
              {titleCase(role)}
              {role === currentRole ? <span className="ml-1.5 font-normal text-zinc-500">(you)</span> : null}
            </p>
            <ul className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
              {PERMISSION_COLUMNS.map((c) => (
                <li key={c.permission} className="flex items-center gap-1.5 text-xs text-zinc-700">
                  {can(role, c.permission) ? (
                    <Check aria-label={`${c.label} allowed`} className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  ) : (
                    <Minus aria-label={`${c.label} not allowed`} className="h-3.5 w-3.5 shrink-0 text-zinc-300" />
                  )}
                  <span className="min-w-0 truncate">{c.label}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <div className="mt-4 hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[30rem] text-left text-[13px]">
          <thead>
            <tr className="border-b border-zinc-100 text-xs text-zinc-600">
              <th className="py-2 pr-2 font-medium">Role</th>
              {PERMISSION_COLUMNS.map((c) => (
                <th key={c.permission} className="px-1.5 py-2 text-center font-medium">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {MATRIX_ROLES.map((role) => (
              <tr key={role} className={role === currentRole ? "bg-zinc-50 font-semibold" : ""}>
                <td className="py-2 pr-2 text-zinc-900">{titleCase(role)}</td>
                {PERMISSION_COLUMNS.map((c) => (
                  <td key={c.permission} className="px-1.5 py-2 text-center">
                    {can(role, c.permission) ? (
                      <Check aria-label="Allowed" className="mx-auto h-4 w-4 text-emerald-600" />
                    ) : (
                      <Minus aria-label="Not allowed" className="mx-auto h-4 w-4 text-zinc-300" />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
