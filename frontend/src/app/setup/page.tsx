/* Business setup: profile, permissions matrix, rules. Team lives on /team. */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, biz } from "../../lib/api";
import { Business, BusinessContext, KnowledgeDocument } from "../../lib/types";
import { COUNTRY_OPTIONS, countryByCode } from "../../lib/countries";
import { announceBusinessUpdated, setupComplete, useSession } from "../../components/nav";
import {
  Card,
  ErrorNote,
  Loading,
  PageHeader,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "../../components/ui";
import { Select2, titleCase } from "../../components/select2";
import { toastError, toastSuccess } from "../../lib/toast";
import { humanNumber } from "../../lib/format";

const KNOWLEDGE_FIELDS = [
  { key: "description", label: "What this business does", placeholder: "We sell provisions and drinks, retail and wholesale." },
  { key: "opening_hours", label: "Opening hours", placeholder: "8am-8pm, Monday to Saturday." },
  { key: "payment_methods", label: "How customers pay", placeholder: "Cash, transfer, POS. No credit for new customers." },
  { key: "delivery", label: "Delivery", placeholder: "We deliver within Ikeja for orders above NGN 50,000." },
  { key: "returns_policy", label: "Returns policy", placeholder: "Faulty items can be returned within 3 days with receipt." },
  { key: "units_notes", label: "Units and measures", placeholder: "Garri is sold per bag (50kg) or per paint rubber." },
  { key: "nicknames", label: "Local names and nicknames", placeholder: "Customers call Garri 5kg 'family bag'." },
  { key: "preferred_language", label: "Preferred language or style", placeholder: "Reply in simple English, pidgin is fine." },
] as const;

const STEPS = [
  { id: "profile", label: "Profile" },
  { id: "contact", label: "Contact" },
  { id: "teach", label: "Teach" },
  { id: "documents", label: "Documents" },
  { id: "done", label: "Done" },
] as const;

type StepId = (typeof STEPS)[number]["id"];



function SectionTitle({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h2 className="text-[15px] font-semibold text-zinc-900">{title}</h2>
      <p className="mt-0.5 text-sm leading-relaxed text-zinc-600">{text}</p>
    </div>
  );
}

export default function SetupPage() {
  const { ready, businessId } = useSession();
  const [context, setContext] = useState<BusinessContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [profile, setProfile] = useState<Partial<Business>>({});
  const [knowledge, setKnowledge] = useState<Record<string, string>>({});
  const [savingKnowledge, setSavingKnowledge] = useState(false);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [docTitle, setDocTitle] = useState("");
  const [docText, setDocText] = useState("");
  const [savingDoc, setSavingDoc] = useState(false);
  const [activeStep, setActiveStep] = useState<StepId>("profile");
  const stepChosenRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const canManage = context?.role === "owner";
  const [onboarding, setOnboarding] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read query flag once on mount
    setOnboarding(new URLSearchParams(window.location.search).get("onboarding") === "1");
  }, []);

  const load = useCallback(async () => {
    if (businessId === null) return;
    setLoading(true);
    setError(null);
    try {
      const ctx = await api<BusinessContext>(biz("/context", businessId));
      setContext(ctx);
      setProfile(ctx.business);
      const raw = ctx.business.settings?.knowledge;
      setKnowledge(
        typeof raw === "string"
          ? { description: raw }
          : Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k, String(v)])),
      );
      if (ctx.role === "owner") {
        // Documents are an add-on: if that one call fails (e.g. backend
        // not restarted yet), keep the page working and show none.
        try {
          setDocuments(await api<KnowledgeDocument[]>(biz("/knowledge", businessId)));
        } catch {
          setDocuments([]);
        }
      } else {
        setDocuments([]);
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

  async function saveProfile(event: React.FormEvent, next?: StepId) {
    event.preventDefault();
    if (businessId === null) return;
    setSaving(true);
    setError(null);
    try {
      await api(biz("/profile", businessId), { method: "PATCH", body: profile });
      toastSuccess("Profile saved.");
      announceBusinessUpdated();
      await load();
      if (next) {
        stepChosenRef.current = true;
        setActiveStep(next);
      }
    } catch (err) {
      setError(err);
      toastError(err instanceof Error ? err.message : "Could not save profile.");
    } finally {
      setSaving(false);
    }
  }

  async function saveKnowledge(event: React.FormEvent, next?: StepId) {
    event.preventDefault();
    if (businessId === null || !business) return;
    const filled = Object.values(knowledge).filter((v) => v.trim()).length;
    setSavingKnowledge(true);
    try {
      const cleaned = Object.fromEntries(
        Object.entries(knowledge).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v),
      );
      await api(biz("/profile", businessId), {
        method: "PATCH",
        body: { settings: { ...(business.settings ?? {}), knowledge: cleaned } },
      });
      toastSuccess("ShopTalk updated. It will use these facts from the next message.");
      await load();
      if (next && filled >= 1) {
        stepChosenRef.current = true;
        setActiveStep(next);
      } else if (next) {
        toastError("Add at least one fact so ShopTalk knows your business, then continue.");
      }
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not save what ShopTalk knows.");
    } finally {
      setSavingKnowledge(false);
    }
  }

  async function addPastedDoc(event: React.FormEvent) {
    event.preventDefault();
    if (businessId === null) return;
    setSavingDoc(true);
    try {
      await api(biz("/knowledge", businessId), {
        method: "POST",
        body: { title: docTitle.trim(), content: docText },
      });
      setDocTitle("");
      setDocText("");
      toastSuccess("Document added. ShopTalk can search it from the next message.");
      await load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not add that document.");
    } finally {
      setSavingDoc(false);
    }
  }

  async function uploadDoc(file: File | undefined) {
    if (businessId === null || !file) return;
    setSavingDoc(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await api(biz("/knowledge", businessId), { method: "POST", form });
      toastSuccess("Document added. ShopTalk can search it from the next message.");
      await load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not upload that document.");
    } finally {
      setSavingDoc(false);
    }
  }

  async function deleteDoc(doc: KnowledgeDocument) {
    if (businessId === null) return;
    setSavingDoc(true);
    try {
      await api(biz(`/knowledge/${doc.id}`, businessId), { method: "DELETE" });
      toastSuccess(`Deleted "${doc.title}".`);
      await load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not delete that document.");
    } finally {
      setSavingDoc(false);
    }
  }

  async function clearKnowledge() {
    if (businessId === null || !business) return;
    setSavingKnowledge(true);
    try {
      await api(biz("/profile", businessId), {
        method: "PATCH",
        body: { settings: { ...(business.settings ?? {}), knowledge: {} } },
      });
      toastSuccess("Cleared. ShopTalk now only uses your profile and records.");
      await load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not clear.");
    } finally {
      setSavingKnowledge(false);
    }
  }

  const business = context?.business;
  const teachFilled = Object.values(knowledge).filter((v) => v.trim()).length;
  const profileStepDone = Boolean(
    (business?.name ?? "").trim() && profile.country && profile.currency && profile.timezone,
  );
  const contactStepDone = Boolean(profile.phone?.trim() || profile.email?.trim());
  const teachStepDone = teachFilled >= 1;
  const docsDone = documents.length >= 1;
  const allDone = context ? setupComplete(context) : false;
  const showSteps = context?.role === "owner";
  const onboardingMode = onboarding || (showSteps && !allDone && !loading);

  function firstIncomplete(): StepId {
    if (!profileStepDone) return "profile";
    if (!contactStepDone) return "contact";
    if (!teachStepDone) return "teach";
    if (!docsDone) return "documents";
    return "done";
  }

  useEffect(() => {
    // Land on the first unfinished step until the owner picks one.
    if (ready && !loading && onboardingMode && !stepChosenRef.current) {
      setActiveStep(firstIncomplete());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loading, onboardingMode]);

  function goStep(step: StepId) {
    stepChosenRef.current = true;
    setActiveStep(step);
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function stepDone(id: StepId): boolean {
    if (id === "profile") return profileStepDone;
    if (id === "contact") return contactStepDone;
    if (id === "teach") return teachStepDone;
    if (id === "documents") return docsDone;
    return allDone;
  }

  if (!ready || businessId === null) return <Loading label="Loading setup..." />;
  const country = countryByCode(profile.country ?? "");
  const timezoneOptions = Array.from(
    new Set([profile.timezone ?? "", ...(country?.timezones ?? []), "Africa/Lagos", "UTC"].filter(Boolean)),
  );

  return (
    <div className="w-full">
      <PageHeader
        title={onboardingMode ? "Set up your business" : "Business setup"}
        blurb={
          onboardingMode
            ? "Five short steps. Profile and contact open the basics, teaching ShopTalk unlocks the dashboard."
            : "Profile, knowledge and rules for this business. Your brand leads receipts, invoices and every screen."
        }
        right={
          <button type="button" onClick={load} className={secondaryButtonClass}>
            Refresh
          </button>
        }
      />
      {onboardingMode ? (
        <p role="status" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium leading-relaxed text-amber-950">
          Finish your profile, a way to reach you, and at least one taught fact. Then the dashboard, assistant and reports open. Documents are optional.
        </p>
      ) : null}
      <ErrorNote error={error} />
      {loading ? (
        <Loading label="Loading profile..." />
      ) : business ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
          <div className="space-y-4">
          <div className="lg:sticky lg:top-6">
          <Card>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              {business.logo_data ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={business.logo_data} alt="" className="h-14 w-14 rounded-xl object-cover" />
              ) : (
                <span aria-hidden className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-xl font-bold text-white" style={{ background: business.brand_color || "#27272a" }}>
                  {business.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-xl font-semibold tracking-tight text-zinc-900">{business.name}</h2>
                <p className="mt-0.5 text-sm text-zinc-600">
                  {titleCase(business.business_type)} - {business.currency}
                  {business.country ? ` - ${business.country}` : ""} - Your role: {titleCase(context?.role ?? "")}
                </p>
              </div>
              <span className="w-fit rounded-full bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-700">
                {onboardingMode ? "Setup in progress" : "Active"}
              </span>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-3">
              {[
                { label: "Catalogue Items", value: humanNumber(context?.counts.products ?? 0) },
                { label: "Customers", value: humanNumber(context?.counts.customers ?? 0) },
                { label: "Suppliers", value: humanNumber(context?.counts.suppliers ?? 0) },
                { label: "Timezone", value: business.timezone || "-" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-xl bg-zinc-50 px-3.5 py-3">
                  <dt className="text-xs font-medium text-zinc-600">{stat.label}</dt>
                  <dd className="mt-1 truncate text-lg font-semibold tabular-nums text-zinc-900">{stat.value}</dd>
                </div>
              ))}
            </dl>
          </Card>
          </div>

            <Card>
              <SectionTitle title="Business rules" text="Stored rules the assistant and reports follow." />
              {(context?.rules ?? []).length === 0 ? (
                <p className="mt-3 text-sm text-zinc-600">No explicit rules stored. Default low-stock threshold is 10.</p>
              ) : (
                <div className="mt-4 grid grid-cols-1 gap-3">
                  {(context?.rules ?? []).map((rule, i) => (
                    <div key={i} className="rounded-xl bg-zinc-50 p-3.5">
                      <p className="text-sm font-semibold text-zinc-900">{titleCase(rule.rule_type)}</p>
                      <p className="mt-1 break-words font-mono text-xs text-zinc-600">{JSON.stringify(rule.structured_value)}</p>
                      <p className="mt-1 text-xs text-zinc-600">{titleCase(rule.source)}{rule.verified ? " - Verified" : " - Unverified"}</p>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {!onboardingMode && (
            <>
            <Card>
              <SectionTitle title="Team and roles" text="Members added here belong to this business only. Change a role to change what that person sees and can do." />
              {canManage ? (
                <>
                  <p className="mt-3 text-sm leading-relaxed text-zinc-600">
                    Add people, change roles, or disable access on the dedicated team page.
                  </p>
                  <Link href="/team" className={`${primaryButtonClass} mt-4 w-full`}>
                    Manage team &amp; roles
                  </Link>
                </>
              ) : (
                <p className="mt-3 text-sm leading-relaxed text-zinc-600">
                  Your role is {titleCase(context?.role ?? "")}. Only owners can change team access.
                </p>
              )}
            </Card>

            <Card>
              <SectionTitle title="Next steps" text="Keep the shop running from here." />
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href="/catalogue" className={secondaryButtonClass}>Catalogue</Link>
                <Link href="/assistant" className={secondaryButtonClass}>Assistant</Link>
                <Link href="/businesses" className={secondaryButtonClass}>Switch business</Link>
              </div>
            </Card>
            </>
            )}
          </div>

          <div className={`min-w-0 space-y-4 ${onboardingMode ? "order-first lg:order-none" : ""}`}>
              {canManage ? (
                <>
                  <nav aria-label="Setup steps" className="flex flex-wrap gap-1.5">
                    {STEPS.map((step, i) => {
                      const done = stepDone(step.id);
                      const active = activeStep === step.id;
                      return (
                        <button
                          key={step.id}
                          type="button"
                          onClick={() => goStep(step.id)}
                          aria-current={active ? "step" : undefined}
                          className={`flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                            active
                              ? "border-zinc-900 bg-zinc-900 text-white"
                              : done
                                ? "border-green-800 bg-green-50 text-green-900 hover:border-green-900"
                                : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-400 hover:text-zinc-900"
                          }`}
                        >
                          <span
                            aria-hidden
                            className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                              active ? "bg-white/20 text-white" : done ? "bg-green-800 text-white" : "bg-zinc-100 text-zinc-600"
                            }`}
                          >
                            {done && !active ? "✓" : i + 1}
                          </span>
                          {step.label}
                          {step.id === "documents" ? (
                            <span className="text-[11px] font-normal opacity-70">optional</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </nav>
                  {activeStep === "profile" && (
                  <Card>
                    <SectionTitle title="Step 1: Profile and branding" text="These details print on receipts and invoices and set money and time for reports." />
                    <form onSubmit={(e) => saveProfile(e, "contact")} className="mt-5 space-y-6">
                      <fieldset>
                        <legend className="text-sm font-semibold text-zinc-900">Business name</legend>
                        <div className="mt-3">
                          <label className="block text-sm">
                            <span className="mb-1.5 block font-medium text-zinc-800">Name</span>
                            <input className={inputClass} value={profile.name ?? ""} onChange={(e) => setProfile({ ...profile, name: e.target.value })} placeholder="Ada's Provisions" maxLength={200} />
                          </label>
                        </div>
                      </fieldset>
                      <fieldset>
                      <legend className="text-sm font-semibold text-zinc-900">Location and money</legend>
                      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <label className="block text-sm">
                          <span className="mb-1.5 block font-medium text-zinc-800">Country</span>
                          <Select2
                            value={profile.country ?? ""}
                            onChange={(v) => {
                              const c = countryByCode(v);
                              setProfile({ ...profile, country: v, currency: c?.currencies[0] ?? profile.currency, timezone: c?.timezones[0] ?? profile.timezone });
                            }}
                            ariaLabel="Country"
                            placeholder="Select country..."
                            options={COUNTRY_OPTIONS.map((c) => ({ value: c.code, label: `${c.emoji} ${c.name}` }))}
                          />
                        </label>
                        <label className="block text-sm">
                          <span className="mb-1.5 block font-medium text-zinc-800">Currency</span>
                          <Select2 value={profile.currency ?? ""} onChange={(v) => setProfile({ ...profile, currency: v })} ariaLabel="Currency" options={Array.from(new Set([profile.currency ?? "", ...(country?.currencies ?? [])].filter(Boolean))).map((c) => ({ value: c, label: c }))} />
                        </label>
                        <label className="block text-sm sm:col-span-2">
                          <span className="mb-1.5 block font-medium text-zinc-800">Timezone</span>
                          <Select2 value={profile.timezone ?? ""} onChange={(v) => setProfile({ ...profile, timezone: v })} ariaLabel="Timezone" options={timezoneOptions.map((tz) => ({ value: tz, label: tz }))} />
                        </label>
                      </div>
                    </fieldset>

                    <fieldset>
                      <legend className="text-sm font-semibold text-zinc-900">Branding</legend>
                      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <label className="block text-sm">
                          <span className="mb-1.5 block font-medium text-zinc-800">Brand colour</span>
                          <span className="flex items-center gap-3">
                            <input type="color" value={profile.brand_color || "#27272a"} onChange={(e) => setProfile({ ...profile, brand_color: e.target.value })} className="h-11 w-16 cursor-pointer rounded-lg border border-zinc-200 bg-white p-1" />
                            <span className="font-mono text-sm text-zinc-600">{profile.brand_color || "#27272a"}</span>
                          </span>
                        </label>
                        <label className="block text-sm">
                          <span className="mb-1.5 block font-medium text-zinc-800">Logo</span>
                          <input
                            type="file" accept="image/*" className="w-full text-sm"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              const reader = new FileReader();
                              reader.onload = () => setProfile((p) => ({ ...p, logo_data: String(reader.result ?? "") }));
                              reader.readAsDataURL(file);
                            }}
                          />
                        </label>
                      </div>
                    </fieldset>

                    <div className="flex flex-col gap-2 border-t border-zinc-100 pt-4 sm:flex-row sm:justify-end">
                      <button type="submit" disabled={saving || (onboardingMode && !profileStepDone)} className={`${primaryButtonClass} w-full sm:w-auto`}>
                        {saving ? "Saving..." : "Save and continue"}
                      </button>
                    </div>
                    {onboardingMode && !profileStepDone ? (
                      <p className="text-sm text-zinc-600">Add the business name, country, currency and timezone to continue.</p>
                    ) : null}
                  </form>
                </Card>
                  )}
                  {activeStep === "contact" && (
                  <Card>
                    <SectionTitle title="Step 2: Contact" text="So customers, suppliers and receipts can reach this business. A phone or email is required." />
                    <form onSubmit={(e) => saveProfile(e, "teach")} className="mt-5 space-y-6">
                    <fieldset>
                      <legend className="text-sm font-semibold text-zinc-900">Contact</legend>
                      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <label className="block text-sm">
                          <span className="mb-1.5 block font-medium text-zinc-800">Phone</span>
                          <input type="tel" className={inputClass} value={profile.phone ?? ""} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
                        </label>
                        <label className="block text-sm">
                          <span className="mb-1.5 block font-medium text-zinc-800">Email</span>
                          <input type="email" className={inputClass} value={profile.email ?? ""} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
                        </label>
                        <label className="block text-sm sm:col-span-2">
                          <span className="mb-1.5 block font-medium text-zinc-800">Address</span>
                          <input className={inputClass} value={profile.address ?? ""} onChange={(e) => setProfile({ ...profile, address: e.target.value })} />
                        </label>
                      </div>
                    </fieldset>

                    <div className="flex flex-col gap-2 border-t border-zinc-100 pt-4 sm:flex-row sm:justify-between">
                      <button type="button" onClick={() => goStep("profile")} className={`${secondaryButtonClass} w-full sm:w-auto`}>
                        Back
                      </button>
                      <button type="submit" disabled={saving || (onboardingMode && !contactStepDone)} className={`${primaryButtonClass} w-full sm:w-auto`}>
                        {saving ? "Saving..." : "Save and continue"}
                      </button>
                    </div>
                    {onboardingMode && !contactStepDone ? (
                      <p className="text-sm text-zinc-600">Add a phone number or email to continue.</p>
                    ) : null}
                    </form>
                  </Card>
                  )}
                </>
              ) : (
                <Card>
                  <SectionTitle title="Profile" text="Only owners and managers can edit the business profile." />
                  <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                    <div><dt className="text-zinc-600">Country</dt><dd className="font-medium text-zinc-900">{business.country || "-"}</dd></div>
                    <div><dt className="text-zinc-600">Currency</dt><dd className="font-medium text-zinc-900">{business.currency}</dd></div>
                    <div><dt className="text-zinc-600">Phone</dt><dd className="font-medium text-zinc-900">{business.phone || "-"}</dd></div>
                    <div><dt className="text-zinc-600">Email</dt><dd className="font-medium text-zinc-900">{business.email || "-"}</dd></div>
                    <div className="sm:col-span-2"><dt className="text-zinc-600">Address</dt><dd className="font-medium text-zinc-900">{business.address || "-"}</dd></div>
                  </dl>
                </Card>
              )}

              {(!canManage || activeStep === "teach") && (
              <Card>
                <SectionTitle
                  title={canManage ? "Step 3: Teach ShopTalk about your business" : "Teach ShopTalk about your business"}
                  text="These facts go into every assistant conversation for this business only. ShopTalk still checks prices, stock and totals from your records. It never guesses them."
                />
                {canManage ? (
                  <form onSubmit={(e) => saveKnowledge(e, "documents")} className="mt-5 space-y-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {KNOWLEDGE_FIELDS.map((field) => (
                        <label key={field.key} className="block text-sm">
                          <span className="mb-1.5 block font-medium text-zinc-800">{field.label}</span>
                          <textarea
                            className={`${inputClass} min-h-20 resize-y`}
                            maxLength={300}
                            value={knowledge[field.key] ?? ""}
                            placeholder={field.placeholder}
                            onChange={(e) => setKnowledge({ ...knowledge, [field.key]: e.target.value })}
                          />
                        </label>
                      ))}
                    </div>
                    <div className="flex flex-col gap-2 border-t border-zinc-100 pt-4 sm:flex-row sm:justify-between">
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <button type="button" onClick={() => goStep("contact")} className={`${secondaryButtonClass} w-full sm:w-auto`}>
                          Back
                        </button>
                        <button type="button" disabled={savingKnowledge} onClick={clearKnowledge} className={`${secondaryButtonClass} w-full sm:w-auto`}>
                          Clear all
                        </button>
                      </div>
                      <button type="submit" disabled={savingKnowledge || (onboardingMode && teachFilled === 0)} className={`${primaryButtonClass} w-full sm:w-auto`}>
                        {savingKnowledge ? "Saving..." : "Save and continue"}
                      </button>
                    </div>
                    {onboardingMode && teachFilled === 0 ? (
                      <p className="text-sm text-zinc-600">Fill at least one fact. That unlocks the dashboard.</p>
                    ) : null}
                  </form>
                ) : (
                  <p className="mt-3 text-sm leading-relaxed text-zinc-600">
                    Only owners can teach ShopTalk. Ask the owner to add business facts here.
                  </p>
                )}
                <div className="mt-5 rounded-xl bg-zinc-50 p-3.5">
                  <p className="text-sm font-semibold text-zinc-900">What ShopTalk knows right now</p>
                  <ul className="mt-2 space-y-1 text-sm leading-relaxed text-zinc-700">
                    <li>Profile: {business.name}, {titleCase(business.business_type)}, {business.currency}, {business.timezone}.</li>
                    <li>Records: {humanNumber(context?.counts.products ?? 0)} catalogue items, {humanNumber(context?.counts.customers ?? 0)} customers, {humanNumber(context?.counts.suppliers ?? 0)} suppliers.</li>
                    <li>Taught facts: {Object.values(knowledge).filter((v) => v.trim()).length} of {KNOWLEDGE_FIELDS.length} filled. Verified rules: {(context?.rules ?? []).filter((r) => r.verified).length}.</li>
                    <li>Business documents: {documents.length} saved for ShopTalk to search.</li>
                  </ul>
                </div>
              </Card>
              )}

              {(!canManage || activeStep === "documents") && (
              <Card>
                <SectionTitle
                  title={canManage ? "Step 4: Business documents (optional)" : "Business documents"}
                  text="Long-term knowledge for ShopTalk: price lists, policies, supplier notes. Upload a PDF or text file, or paste text. ShopTalk searches these documents when you ask. Only the text is kept, never the file. To work on a single PDF just once, attach it in the Assistant instead."
                />
                {canManage ? (
                  <div className="mt-5 space-y-4">
                    <form onSubmit={addPastedDoc} className="space-y-3">
                      <label className="block text-sm">
                        <span className="mb-1.5 block font-medium text-zinc-800">Title</span>
                        <input className={inputClass} value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder="Delivery policy" maxLength={200} />
                      </label>
                      <label className="block text-sm">
                        <span className="mb-1.5 block font-medium text-zinc-800">Paste document text</span>
                        <textarea className={`${inputClass} min-h-28 resize-y`} value={docText} onChange={(e) => setDocText(e.target.value)} placeholder="We deliver within Ikeja for orders above NGN 50,000..." />
                      </label>
                      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                        <button type="submit" disabled={savingDoc || !docText.trim()} className={`${primaryButtonClass} w-full sm:w-auto`}>
                          {savingDoc ? "Saving..." : "Add document"}
                        </button>
                      </div>
                    </form>
                    <div className="border-t border-zinc-100 pt-4">
                      <label className="block text-sm">
                        <span className="mb-1.5 block font-medium text-zinc-800">Or upload a file (.pdf, .txt, .md, max 2 MB)</span>
                        <input
                          type="file" accept=".pdf,.txt,.md,text/plain,application/pdf" disabled={savingDoc} className="w-full text-sm"
                          onChange={(e) => { uploadDoc(e.target.files?.[0]); e.target.value = ""; }}
                        />
                      </label>
                    </div>
                    {documents.length === 0 ? (
                      <p className="text-sm text-zinc-600">No documents yet. Add one above and ask ShopTalk about it in the Assistant.</p>
                    ) : (
                      <ul className="space-y-2">
                        {documents.map((doc) => (
                          <li key={doc.id} className="flex items-start gap-3 rounded-xl bg-zinc-50 px-3.5 py-3">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-zinc-900">{doc.title}</p>
                              <p className="mt-0.5 text-xs text-zinc-600">{doc.source_type === "pdf" ? "PDF" : doc.source_type === "text" ? "Text file" : "Pasted"} - {humanNumber(doc.char_count)} characters</p>
                              <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-700">{doc.excerpt}</p>
                            </div>
                            <button type="button" disabled={savingDoc} onClick={() => deleteDoc(doc)} className={`${secondaryButtonClass} shrink-0`}>
                              Delete
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <p className="mt-3 text-sm leading-relaxed text-zinc-600">Only owners can add business documents. Ask the owner to add them here.</p>
                )}
                {canManage ? (
                  <div className="mt-5 flex flex-col gap-2 border-t border-zinc-100 pt-4 sm:flex-row sm:justify-between">
                    <button type="button" onClick={() => goStep("teach")} className={`${secondaryButtonClass} w-full sm:w-auto`}>
                      Back
                    </button>
                    <button type="button" onClick={() => goStep("done")} className={`${primaryButtonClass} w-full sm:w-auto`}>
                      Continue
                    </button>
                  </div>
                ) : null}
              </Card>
              )}
              {canManage && activeStep === "done" && (
              <Card>
                <SectionTitle
                  title="Step 5: Done"
                  text="Review what ShopTalk knows, then open your dashboard. You can revisit any step anytime."
                />
                <ul className="mt-4 space-y-2 text-sm leading-relaxed text-zinc-700">
                  <li>
                    {profileStepDone ? "✓" : "○"} Profile: {business.name || "not set"}, {business.business_type}, {business.currency}, {business.timezone || "not set"}.
                    {!profileStepDone ? (
                      <> <button type="button" onClick={() => goStep("profile")} className="font-semibold text-zinc-900 underline">Fix in Profile</button></>
                    ) : null}
                  </li>
                  <li>
                    {contactStepDone ? "✓" : "○"} Contact: {[business.phone, business.email].filter(Boolean).join(" · ") || "not set"}.
                    {!contactStepDone ? (
                      <> <button type="button" onClick={() => goStep("contact")} className="font-semibold text-zinc-900 underline">Fix in Contact</button></>
                    ) : null}
                  </li>
                  <li>
                    {teachStepDone ? "✓" : "○"} Taught facts: {teachFilled} of {KNOWLEDGE_FIELDS.length} filled.
                    {!teachStepDone ? (
                      <> <button type="button" onClick={() => goStep("teach")} className="font-semibold text-zinc-900 underline">Teach ShopTalk</button></>
                    ) : null}
                  </li>
                  <li>
                    {docsDone ? "✓" : "○"} Business documents: {documents.length} saved
                    {documents.length === 0 ? " (optional)" : ""}.
                  </li>
                  <li>Records: {humanNumber(context?.counts.products ?? 0)} catalogue items, {humanNumber(context?.counts.customers ?? 0)} customers, {humanNumber(context?.counts.suppliers ?? 0)} suppliers.</li>
                </ul>
                <div className="mt-5 flex flex-col gap-2 border-t border-zinc-100 pt-4 sm:flex-row sm:justify-between">
                  <button type="button" onClick={() => goStep("documents")} className={`${secondaryButtonClass} w-full sm:w-auto`}>
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={!allDone}
                    onClick={() => {
                      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                      window.location.assign("/dashboard");
                    }}
                    className={`${primaryButtonClass} w-full sm:w-auto`}
                  >
                    Open dashboard
                  </button>
                </div>
                {!allDone ? (
                  <p className="mt-2 text-sm text-zinc-600">Finish the profile, contact and at least one taught fact to unlock the dashboard.</p>
                ) : null}
              </Card>
              )}

          </div>
        </div>
      ) : null}
    </div>
  );
}
