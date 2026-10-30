/* Sign in or create an account, then set up or pick a business. */

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Eye, EyeOff, LockKeyhole, UserRound } from "lucide-react";
import { api, getBusinessId, getLastBusiness, rememberBusiness, setBusinessId, setToken } from "../../lib/api";
import type { LastBusiness } from "../../lib/api";
import type { Business } from "../../lib/types";
import { ErrorNote, inputClass, primaryButtonClass } from "../../components/ui";
import { brandHex } from "../../lib/format";
import { toastError, toastSuccess } from "../../lib/toast";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // White labelling reaches the auth page: wear the last business branding.
  // Loaded after mount so the server HTML matches the first client paint.
  const [lastBusiness, setLastBusiness] = useState<LastBusiness | null>(null);
  const brand = brandHex(lastBusiness?.brand_color, "#18181b");

  useEffect(() => {
    const saved = getLastBusiness();
    if (saved) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only branding after mount
      setLastBusiness(saved);
    }
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = mode === "login" ? "/api/auth/token/" : "/api/auth/register/";
      const data = await api<{ token: string }>(path, {
        method: "POST",
        body: { username, password },
      });
      setToken(data.token);
      if (mode === "register") {
        toastSuccess("Account created.");
        router.replace("/businesses");
        return;
      }
      // Any existing business goes straight to its dashboard. Only a brand
      // new account with no business at all sees business setup.
      const list = await api<Business[]>("/api/businesses");
      if (list.length === 0) {
        router.replace("/businesses");
        return;
      }
      // A stored business may only be re-picked for the same account that
      // used it last. Never inherited across an account switch.
      const last = getLastBusiness();
      const sameAccount = last?.username?.toLowerCase() === username.trim().toLowerCase();
      const stored = getBusinessId() ?? (sameAccount ? last?.id ?? null : null);
      const picked = list.find((b) => b.id === stored) ?? list[0];
      setBusinessId(picked.id);
      rememberBusiness({ ...picked, username: username.trim().toLowerCase() });
      toastSuccess("Signed in.");
      router.replace("/dashboard");
    } catch (err) {
      setError(err);
      toastError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex w-full flex-1 items-center justify-center py-8 sm:py-12">
      <div className="w-full max-w-md">
        {lastBusiness ? (
          <div className="mb-6 flex flex-col items-center text-center">
            {lastBusiness.logo_data ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={lastBusiness.logo_data} alt="" className="h-12 w-12 rounded-2xl object-cover" />
            ) : (
              <span
                aria-hidden
                className="flex h-12 w-12 items-center justify-center rounded-2xl text-xl font-bold text-white"
                style={{ background: brand }}
              >
                {lastBusiness.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-zinc-900">{lastBusiness.name}</h1>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-zinc-600">
              Sign in to continue to {lastBusiness.name}.
            </p>
          </div>
        ) : (
          <div className="mb-6 flex flex-col items-center text-center">
            <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-900 text-xl font-bold text-white">
              S
            </span>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-zinc-900">ShopTalk AI</h1>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-zinc-600">
              Talk to your business. Record sales, stock and expenses, then see the numbers.
            </p>
          </div>
        )}

        <div className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-6">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1 text-sm font-medium" role="tablist" aria-label="Account">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={`min-h-10 rounded-lg px-3 py-2 ${
                  mode === m ? "bg-white font-semibold text-zinc-900 shadow-sm" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                {m === "login" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="mt-5">
            <div className="space-y-4">
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-zinc-800">Username</span>
                <span className="relative block">
                  <UserRound aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                  <input
                    className={`${inputClass} pl-10`}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    autoCapitalize="none"
                    required
                  />
                </span>
              </label>
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-zinc-800">Password</span>
                <span className="relative block">
                  <LockKeyhole aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                  <input
                    type={showPassword ? "text" : "password"}
                    className={`${inputClass} pl-10 pr-12`}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                  >
                    {showPassword ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}
                  </button>
                </span>
              </label>
            </div>

            <ErrorNote error={error} />
            <button type="submit" disabled={busy} className={`${primaryButtonClass} mt-5 w-full`}>
              {busy ? "Working..." : mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>

          <p className="mt-5 border-t border-zinc-100 pt-4 text-center text-[13px] leading-relaxed text-zinc-600">
            {mode === "login" ? (
              "New here? Create an account, then set up your business."
            ) : (
              "Next step: set up your business. The dashboard opens only after setup is complete."
            )}
          </p>
        </div>

        <p className="mt-5 text-center text-xs text-zinc-500">Your business name and brand lead every screen. ShopTalk stays in the background.</p>
      </div>
    </main>
  );
}
