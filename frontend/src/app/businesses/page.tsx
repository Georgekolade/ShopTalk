/* Businesses: pick one, or run the onboarding wizard for a new profile. */

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Building2, ChevronRight, Plus } from "lucide-react";
import { api, getBusinessId, getToken, rememberBusiness, setBusinessId } from "../../lib/api";
import { Business } from "../../lib/types";
import { COUNTRY_OPTIONS, countryByCode } from "../../lib/countries";
import { money } from "../../lib/format";
import {
  Card,
  ErrorNote,
  Loading,
  PageHeader,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  staggerStyle,
} from "../../components/ui";
import { Select2, enumOptions } from "../../components/select2";
import { toastError, toastSuccess } from "../../lib/toast";

const TYPES = ["retail", "service", "hybrid"];
const MODULES = ["inventory", "expenses", "invoicing", "reports"];

export default function BusinessesPage() {
  const router = useRouter();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: "", business_type: "retail", country: "NG", currency: "NGN",
    timezone: "Africa/Lagos", phone: "", email: "", address: "",
    brand_color: "#14532d", logo_data: "", modules: ["inventory", "expenses"] as string[],
  });
  const [creating, setCreating] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [currentId, setCurrentId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api<Business[]>("/api/businesses");
      // Members under a single business skip the picker entirely and land
      // in their shop. Multi-business users (or anyone switching) pick.
      if (list.length === 1 && getBusinessId() === null) {
        setBusinessId(list[0].id);
        router.replace("/dashboard");
        return;
      }
      setBusinesses(list);
      // Onboarding wizard only for accounts with no business at all.
      setShowWizard(list.length === 0);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    setCurrentId(getBusinessId());
    load();
  }, [router, load]);

  function choose(id: number) {
    const picked = businesses.find((b) => b.id === id);
    if (picked) rememberBusiness(picked);
    setBusinessId(id);
    // Full reload: the shell reads business context once per mount.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/dashboard");
  }

  function pickCountry(code: string) {
    const country = countryByCode(code);
    setForm((f) => ({
      ...f,
      country: code,
      currency: country?.currencies[0] ?? f.currency,
      timezone: country?.timezones[0] ?? f.timezone,
    }));
  }

  function onLogo(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setForm((f) => ({ ...f, logo_data: String(reader.result ?? "") }));
    reader.readAsDataURL(file);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!form.phone.trim() && !form.email.trim()) {
      setStep(1);
      setError(new Error("Add a phone number or email so customers and receipts can reach you."));
      toastError("Add a phone number or email to finish setup.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const business = await api<Business>("/api/businesses", {
        method: "POST",
        body: {
          name: form.name, business_type: form.business_type,
          currency: form.currency.toUpperCase(), timezone: form.timezone,
          country: form.country, phone: form.phone, email: form.email,
          address: form.address, brand_color: form.brand_color,
          logo_data: form.logo_data, enabled_modules: form.modules, settings: {},
        },
      });
      setBusinessId(business.id);
      toastSuccess("Business created. Welcome in.");
      // Full reload: shell must re-read the new business context before gating.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/dashboard");
    } catch (err) {
      setError(err);
      toastError(err instanceof Error ? err.message : "Could not create business.");
    } finally {
      setCreating(false);
    }
  }

  const country = countryByCode(form.country);
  const canCreate = businesses.length === 0 || businesses.some((b) => b.role === "owner" || b.role === "manager");

  return (
    <div>
      <PageHeader
        title={businesses.length === 0 && !loading ? "First, set up your business" : "Your businesses"}
        blurb={
          businesses.length === 0 && !loading
            ? "Finish this onboarding and your dashboard opens. Nothing else is accessible until your shop is set up."
            : "Pick a business on the left to switch into it, or set up a new one on the right."
        }
      />
      <ErrorNote error={error} />
      {loading ? (
        <Loading label="Loading businesses…" />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-12">
          <section aria-label="Your businesses" className="rounded-2xl border border-zinc-200 bg-white p-3 sm:p-4 lg:col-span-3 lg:sticky lg:top-6">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-zinc-900">Your businesses</h2>
              <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700">
                {businesses.length}
              </span>
            </div>
            {businesses.length === 0 ? (
              <div className="mt-3 flex items-start gap-3 rounded-xl bg-zinc-50 p-3.5">
                <Building2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-zinc-500" />
                <p className="text-sm leading-relaxed text-zinc-600">
                  No businesses yet. Complete the setup form{` `}to create your first one.
                </p>
              </div>
            ) : (
              <ul className="mt-3 space-y-2">
                {businesses.map((business, index) => {
                  const isCurrent = business.id === currentId;
                  return (
                    <li key={business.id}>
                      <button
                        type="button"
                        onClick={() => choose(business.id)}
                        style={staggerStyle(index)}
                        aria-current={isCurrent ? "true" : undefined}
                        className={`animate-enter-stagger flex w-full items-center gap-2.5 rounded-xl border p-2.5 text-left transition-colors ${
                          isCurrent
                            ? "border-zinc-900 bg-zinc-50"
                            : "border-zinc-200 bg-white hover:border-zinc-400"
                        }`}
                      >
                        {business.logo_data ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={business.logo_data} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
                        ) : (
                          <span
                            aria-hidden
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
                            style={{ background: business.brand_color || "#27272a" }}
                          >
                            {business.name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-zinc-900">{business.name}</span>
                            {business.role ? (
                              <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold capitalize text-zinc-700">
                                {business.role}
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-zinc-600">
                            {business.business_type} · {money(0, business.currency).replace(/[\d.,\s]/g, "") || business.currency}
                            {business.country ? ` · ${business.country}` : ""}
                          </span>
                        </span>
                        {isCurrent ? (
                          <span className="shrink-0 rounded-full bg-green-800 px-2.5 py-1 text-[11px] font-semibold text-white">
                            Current
                          </span>
                        ) : (
                          <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-zinc-400" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <div className="min-w-0 lg:col-span-9">
      {!loading && businesses.length > 0 && !showWizard && canCreate ? (
        <button
          type="button"
          onClick={() => setShowWizard(true)}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-300 bg-white p-5 text-sm font-semibold text-zinc-900 transition-colors hover:border-zinc-500"
        >
          <Plus aria-hidden className="h-4 w-4" />
          Set up another business
        </button>
      ) : null}

      {showWizard ? (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold text-zinc-900">
            {businesses.length === 0 ? "Set up your business" : "Set up a new business"}
          </h2>
          <p className="text-xs font-semibold text-zinc-500">Step {step + 1} of 3</p>
        </div>
        <form onSubmit={create}>
          {step === 0 ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm sm:col-span-2">
                <span className="mb-1 block font-medium text-zinc-700">Business name</span>
                <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required={step === 0} placeholder="Ada's Provisions" />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Country</span>
                <Select2 value={form.country} onChange={pickCountry} ariaLabel="Country" options={COUNTRY_OPTIONS.map((c) => ({ value: c.code, label: `${c.emoji} ${c.name}` }))} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Business type</span>
                <Select2 value={form.business_type} onChange={(v) => setForm({ ...form, business_type: v })} ariaLabel="Business type" options={enumOptions(TYPES)} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Currency</span>
                <Select2 value={form.currency} onChange={(v) => setForm({ ...form, currency: v })} ariaLabel="Currency" options={Array.from(new Set([form.currency, ...(country?.currencies ?? [])])).map((c) => ({ value: c, label: c }))} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Timezone</span>
                <Select2 value={form.timezone} onChange={(v) => setForm({ ...form, timezone: v })} ariaLabel="Timezone" options={Array.from(new Set([form.timezone, ...(country?.timezones ?? [])])).map((tz) => ({ value: tz, label: tz }))} />
              </label>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Phone {country?.callingCodes[0] ? `(${country.callingCodes[0]})` : ""}</span>
                <input className={inputClass} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+234…" />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Email</span>
                <input type="email" className={inputClass} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </label>
              <label className="block text-sm sm:col-span-2">
                <span className="mb-1 block font-medium text-zinc-700">Address (printed on receipts/invoices)</span>
                <input className={inputClass} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </label>
              <label className="block text-sm sm:col-span-2">
                <span className="mb-1 block font-medium text-zinc-700">Modules</span>
                <Select2
                  multiple
                  value={form.modules}
                  onChange={(v: string[]) => setForm({ ...form, modules: v })}
                  ariaLabel="Modules"
                  placeholder="Pick modules..."
                  options={enumOptions(MODULES)}
                />
                <span className="mt-1 block text-xs text-zinc-600">Search and pick every module this business needs.</span>
              </label>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Logo (used on dashboard + documents)</span>
                <input type="file" accept="image/*" className="text-sm" onChange={(e) => onLogo(e.target.files?.[0])} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-zinc-700">Brand colour</span>
                <input type="color" value={form.brand_color} onChange={(e) => setForm({ ...form, brand_color: e.target.value })} className="h-11 w-20 cursor-pointer rounded-lg border border-zinc-900/15 bg-white p-1" />
              </label>
              <div className="flex items-center gap-3 rounded-xl border border-zinc-900/10 p-3 sm:col-span-2">
                {form.logo_data ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={form.logo_data} alt="" className="h-12 w-12 rounded-lg object-cover" />
                ) : (
                  <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-lg font-display text-xl font-bold text-white" style={{ background: form.brand_color }}>
                    {(form.name || "S").slice(0, 1).toUpperCase()}
                  </span>
                )}
                <div className="text-sm">
                  <p className="font-semibold text-zinc-900">{form.name || "Your business"}</p>
                  <p className="text-xs text-zinc-500">Powered by ShopTalk AI · documents carry your name, logo and colour</p>
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-2">
            {step > 0 ? (
              <button type="button" onClick={() => setStep(step - 1)} className={secondaryButtonClass}>Back</button>
            ) : null}
            {step < 2 ? (
              <button type="button" onClick={() => setStep(step + 1)} className={primaryButtonClass}>Continue</button>
            ) : (
              <button type="submit" disabled={creating} className={primaryButtonClass}>
                {creating ? "Creating…" : "Create business"}
              </button>
            )}
            <button type="button" onClick={load} className={secondaryButtonClass}>Refresh</button>
            {businesses.length > 0 ? (
              <button type="button" onClick={() => setShowWizard(false)} className={secondaryButtonClass}>Cancel</button>
            ) : null}
          </div>
        </form>
      </Card>
      ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
