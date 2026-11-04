/* App shell: sidebar on desktop, compact top bar on mobile.
   White-label: the business name/logo/brand colour lead; ShopTalk is a
   small "powered by" watermark. */

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  Building2,
  Check,
  ChevronDown,
  CircleHelp,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Menu,
  MessagesSquare,
  Package,
  PackagePlus,
  Search,
  Settings2,
  ShoppingCart,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { api, biz, getBusinessId, getToken, logout, rememberBusiness, setBusinessId } from "../lib/api";
import { Business, BusinessContext } from "../lib/types";
import { FloatingMic } from "./floating-mic";
import { InstallPrompt } from "./install-prompt";
import { can } from "../lib/permissions";

type NavChild = { href: string; label: string; Icon: typeof LayoutDashboard };

type NavLink = { href: string; label: string; Icon: typeof LayoutDashboard; permission?: string; ownerOnly?: boolean; hideFor?: string[]; children?: NavChild[] };

type RoleContext = { role?: string; permissions?: string[]; extra_permissions?: string[] };

const GROUPS: { label: string; links: NavLink[] }[] = [
  {
    label: "Main",
    links: [
      { href: "/assistant", label: "Assistant", Icon: MessagesSquare, permission: "assistant.use" },
      { href: "/dashboard", label: "Dashboard", Icon: LayoutDashboard },
    ],
  },
  {
    label: "Manage",
    links: [
      { href: "/catalogue", label: "Catalogue", Icon: Package, permission: "catalogue.view" },
      {
        href: "/transactions",
        label: "Transactions",
        Icon: ArrowLeftRight,
        children: [
          { href: "/transactions/sales", label: "Sales", Icon: ShoppingCart },
          { href: "/transactions/expenses", label: "Expenses", Icon: Wallet },
        ],
      },
      { href: "/restock", label: "Restock", Icon: PackagePlus, permission: "stock.write" },
    ],
  },
  {
    label: "Insights",
    links: [
      { href: "/reports", label: "Reports", Icon: BarChart3, permission: "reports.view", hideFor: ["sales"] },
      { href: "/activity", label: "Activity", Icon: ListOrdered, permission: "activity.view", hideFor: ["sales"] },
    ],
  },
  {
    label: "Administration",
    links: [
      { href: "/businesses", label: "Businesses", Icon: Building2, hideFor: ["sales"] },
      { href: "/team", label: "Team & roles", Icon: Users, ownerOnly: true },
      { href: "/setup", label: "Setup", Icon: Settings2, ownerOnly: true },
    ],
  },
];

function effectiveHas(ctx: RoleContext | undefined, permission: string): boolean {
  const granted = ctx?.permissions;
  if (granted && granted.length > 0) {
    return granted.includes("*") || granted.includes(permission);
  }
  return can(ctx?.role, permission);
}

function linkVisible(ctx: RoleContext | undefined, link: NavLink): boolean {
  if (link.ownerOnly && ctx?.role !== "owner") return false;
  if (link.permission && !effectiveHas(ctx, link.permission)) return false;
  // An explicit extra grant overrides a role-based hide; role defaults do not.
  if (ctx?.role && link.hideFor?.includes(ctx.role) && link.permission && !ctx.extra_permissions?.includes(link.permission)) return false;
  return true;
}

function visibleLinks(ctx: RoleContext | undefined): NavLink[] {
  // Role unknown while context loads: show all, backend still enforces.
  if (!ctx?.role) return GROUPS.flatMap((g) => g.links);
  return GROUPS.flatMap((g) => g.links).filter((l) => linkVisible(ctx, l));
}

function visibleGroups(ctx: RoleContext | undefined) {
  if (!ctx?.role) return GROUPS;
  return GROUPS.map((g) => ({
    ...g,
    links: g.links.filter((l) => linkVisible(ctx, l)),
  })).filter((g) => g.links.length > 0);
}

const LINKS = GROUPS.flatMap((g) => g.links);

export function useSession() {
  const router = useRouter();
  const [ids, setIds] = useState<{ token: string | null; businessId: number | null; resolved: boolean }>({
    token: null,
    businessId: null,
    resolved: false,
  });

  useEffect(() => {
    const token = getToken();
    const businessId = getBusinessId();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read session after hydration
    setIds({ token, businessId, resolved: true });
    if (!token) router.replace("/login");
    else if (businessId === null) router.replace("/businesses");
  }, [router]);

  const ready = ids.resolved && ids.token !== null && ids.businessId !== null;
  return { ready, businessId: ids.businessId };
}

export function useBusinessContext() {
  // The shell lives in the root layout and never unmounts, so context must
  // follow the session: re-read token+business on every navigation and
  // refetch when either changed (sign-out, sign-in, account switch).
  // Reading once on mount left the previous account's business on screen
  // until a hard refresh.
  const pathname = usePathname();
  const [state, setState] = useState<{ context: BusinessContext | null; loaded: boolean }>({
    context: null,
    loaded: false,
  });
  // Profile saves (logo, brand colour, name) announce themselves so every
  // surface (sidebar, top bar, switcher) updates with no refresh.
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((n) => n + 1);
    window.addEventListener("shoptalk:business-updated", refresh);
    return () => window.removeEventListener("shoptalk:business-updated", refresh);
  }, []);
  useEffect(() => {
    // No fetched-once guard here: dev StrictMode mounts, unmounts, and
    // remounts effects, and a guard that skips the second run leaves
    // `loaded` false forever (bare shell, no sidebar anywhere). One small
    // context fetch per navigation is the correct trade.
    const token = getToken();
    const id = getBusinessId();
    if (!token || id === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- session cleared on sign-out
      setState({ context: null, loaded: true });
      return;
    }
    let live = true;
    api<BusinessContext>(biz("/context", id))
      .then((context) => { if (live) setState({ context, loaded: true }); })
      .catch(() => { if (live) setState({ context: null, loaded: true }); });
    return () => { live = false; };
  }, [pathname, revision]);
  return state;
}

/** Announce a business profile change. The shell and every context
 * consumer refetch on the next paint, so the logo and brand update
 * everywhere with no page refresh. */
export function announceBusinessUpdated() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("shoptalk:business-updated"));
  }
}

/** Onboarding is complete only when the core profile is filled in. */
export function isOnboarded(context: BusinessContext | null): boolean {
  const b = context?.business;
  if (!b) return false;
  return Boolean(b.name && b.country && b.currency && b.timezone && (b.phone || b.email));
}

/** Taught facts the owner gave ShopTalk (Setup > Teach step). */
export function taughtCount(context: BusinessContext | null): number {
  const raw = context?.business.settings?.knowledge;
  if (typeof raw === "string") return raw.trim() ? 1 : 0;
  if (raw && typeof raw === "object") {
    return Object.values(raw).filter((v) => String(v ?? "").trim()).length;
  }
  return 0;
}

/** Setup is finished only when the profile is complete AND the owner has
 * taught ShopTalk at least one fact. The dashboard unlocks after both. */
export function setupComplete(context: BusinessContext | null): boolean {
  return isOnboarded(context) && taughtCount(context) >= 1;
}

function OfflineNote() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const down = () => setOnline(false);
    const up = () => setOnline(true);
    window.addEventListener("offline", down);
    window.addEventListener("online", up);
    return () => {
      window.removeEventListener("offline", down);
      window.removeEventListener("online", up);
    };
  }, []);

  if (online) return null;
  return (
    <p className="bg-amber-200 px-4 py-2 text-center text-sm font-semibold text-amber-950">
      You are offline. ShopTalk needs a connection to record anything.
    </p>
  );
}

function BrandMark({ context }: { context: BusinessContext | null }) {
  const business = context?.business;
  const color = business?.brand_color || "#14532d";
  if (business?.logo_data) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={business.logo_data} alt="" className="h-10 w-10 rounded-lg object-cover" />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-white"
      style={{ background: color }}
    >
      {(business?.name ?? "S").slice(0, 1).toUpperCase()}
    </span>
  );
}

function Brand({ context }: { context: BusinessContext | null }) {
  const business = context?.business;
  return (
    <Link href="/assistant" className="flex min-h-11 items-center gap-2.5">
      <BrandMark context={context} />
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[15px] font-semibold text-zinc-900">
          {business?.name ?? "ShopTalk"}
        </span>
        <span className="block text-[11px] font-medium text-zinc-500">
          {business ? "Powered by ShopTalk AI" : "Talk to your business"}
        </span>
      </span>
    </Link>
  );
}

function SidebarLinks({ current, context, onNavigate }: { current: string; context?: RoleContext; onNavigate?: () => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const linkClass = (active: boolean) =>
    `flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
      active
        ? "nav-active font-semibold text-zinc-900"
        : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
    }`;
  return (
    <nav className="mt-5" aria-label="Primary">
      {visibleGroups(context).map((group) => (
        <div key={group.label} className="mb-5">
          <p className="px-2 pb-1.5 text-xs font-medium text-zinc-500">{group.label}</p>
          <div className="space-y-0.5">
            {group.links.map(({ href, label, Icon, children }) => {
              if (children && children.length > 0) {
                const childActive = children.some(
                  (child) => current === child.href || current.startsWith(`${child.href}/`),
                );
                const open = expanded[label] ?? childActive;
                return (
                  <div key={href}>
                    <button
                      type="button"
                      onClick={() => setExpanded((prev) => ({ ...prev, [label]: !open }))}
                      aria-expanded={open}
                      className={linkClass(childActive)}
                    >
                      <Icon aria-hidden className="h-4 w-4 shrink-0" />
                      <span className="flex-1 text-left">{label}</span>
                      <ChevronDown aria-hidden className={`h-4 w-4 transition-transform duration-200 ease-out ${open ? "rotate-180" : ""}`} />
                    </button>
                    {open ? (
                      <div className="ml-4 mt-0.5 space-y-0.5 border-l border-zinc-200 pl-2">
                        {children.map((child) => {
                          const active = current === child.href;
                          return (
                            <Link
                              key={child.href}
                              href={child.href}
                              onClick={onNavigate}
                              aria-current={active ? "page" : undefined}
                              className={linkClass(active)}
                            >
                              <child.Icon aria-hidden className="h-4 w-4 shrink-0" />
                              {child.label}
                            </Link>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              }
              const active = current === href;
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={linkClass(active)}
                >
                  <Icon aria-hidden className="h-4 w-4 shrink-0" />
                  {label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function BusinessCard({ context }: { context: BusinessContext | null }) {
  if (!context) return null;
  return (
    <Link
      href="/businesses"
      title="Switch business"
      className="block rounded-xl border border-zinc-200 bg-white p-3 transition-colors hover:border-zinc-400"
    >
      <p className="truncate text-sm font-semibold text-zinc-900">
        {context.business.name}
      </p>
      <p className="mt-0.5 text-xs text-zinc-500">
        {context.role} · {context.business.currency}
        {context.business.country ? ` · ${context.business.country}` : ""}
      </p>
    </Link>
  );
}

function useBusinessList() {
  const [businesses, setBusinesses] = useState<Business[] | null>(null);
  useEffect(() => {
    if (!getToken()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resolve empty session once
      setBusinesses([]);
      return;
    }
    api<Business[]>("/api/businesses")
      .then(setBusinesses)
      .catch(() => setBusinesses([]));
  }, []);
  return businesses;
}

/** Current business button with a dropdown to jump between businesses. */
function BusinessSwitcher({ context, compact = false }: { context: BusinessContext | null; compact?: boolean }) {
  const businesses = useBusinessList();
  const [open, setOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function choose(b: Business) {
    setOpen(false);
    if (b.id === (currentId ?? context?.business.id)) return;
    rememberBusiness({ id: b.id, name: b.name, brand_color: b.brand_color, logo_data: b.logo_data });
    setSwitchingTo(b.name);
    setBusinessId(b.id);
    // Full reload: the shell reads business context once per mount.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/dashboard");
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read session after hydration
    setCurrentId(getBusinessId());
  }, []);

  // Keyboard: Escape closes and hands focus back to the trigger.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open ]);

  // Focus moves into the list on open so Tab/Enter walk the options.
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const selected = panelRef.current.querySelector<HTMLElement>('[aria-selected="true"]');
    const first = panelRef.current.querySelector<HTMLElement>('button[role="option"]');
    (selected ?? first)?.focus();
  }, [open, businesses]);

  if (!context) return null;

  // Preloading: the business list is still on its way. Show a skeleton
  // shaped like the toggle so the sidebar never jumps when it lands.
  if (businesses === null) {
    return compact ? (
      <span
        role="status"
        aria-label="Loading businesses"
        className="flex min-h-11 items-center gap-1.5 rounded-full border border-zinc-200 px-3 py-1.5"
      >
        <span aria-hidden className="skeleton h-4 w-16 rounded-full" />
      </span>
    ) : (
      <div role="status" aria-label="Loading businesses" className="rounded-xl border border-zinc-200 bg-white p-3">
        <div aria-hidden className="skeleton h-4 w-2/3 rounded-md" />
        <div aria-hidden className="skeleton mt-2 h-3 w-1/3 rounded-md" />
      </div>
    );
  }
  if (businesses.length === 0) return <BusinessCard context={context} />;

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  return (
    <div className="relative">
      {open ? (
        <span
          aria-hidden="true"
          className="fixed inset-0 z-40 cursor-default"
          onClick={() => close(false)}
        />
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(true) : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Switch business"
        className={
          compact
            ? "flex min-h-11 items-center gap-1.5 rounded-full border border-zinc-200 px-3 py-1.5 text-sm font-semibold text-zinc-900"
            : "flex min-h-11 w-full items-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 text-left transition-colors hover:border-zinc-400"
        }
      >
        {compact ? (
          <>
            <ArrowLeftRight aria-hidden className="h-4 w-4" />
            Switch
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-zinc-900">{context.business.name}</span>
              <span className="mt-0.5 block text-xs capitalize text-zinc-500">
                {context.role} · {context.business.currency}
              </span>
            </span>
          </>
        )}
        <ChevronDown aria-hidden className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          ref={panelRef}
          role="listbox"
          aria-label="Businesses"
          className={`absolute z-50 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl ${
            compact ? "right-0 mt-2 w-64" : "inset-x-0 bottom-full mb-2"
          }`}
        >
          <ul className="nice-scroll max-h-64 overflow-y-auto py-1">
            {businesses.map((b) => {
              const active = b.id === (currentId ?? context.business.id);
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => choose(b)}
                    className={`flex min-h-11 w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors ${
                      active ? "bg-zinc-100 font-semibold text-zinc-900" : "text-zinc-700 hover:bg-zinc-50"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{b.name}</span>
                      {b.role ? (
                        <span className="mt-0.5 block text-xs capitalize text-zinc-500">{b.role}</span>
                      ) : null}
                    </span>
                    {active ? <Check aria-hidden className="h-4 w-4 shrink-0 text-green-800" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <Link
            href="/businesses"
            onClick={() => setOpen(false)}
            className="block min-h-11 border-t border-zinc-100 px-3 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-zinc-50"
          >
            Manage businesses
          </Link>
        </div>
      ) : null}
      {switchingTo ? (
        <div
          role="status"
          aria-label={`Switching to ${switchingTo}`}
          className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-3 bg-[#f4f4f2] px-6 text-center"
        >
          <span
            aria-hidden
            className="flex h-12 w-12 animate-pulse items-center justify-center rounded-2xl bg-zinc-900 text-xl font-bold text-white"
          >
            {switchingTo.slice(0, 1).toUpperCase()}
          </span>
          <p className="text-sm font-semibold text-zinc-900">Switching to {switchingTo}…</p>
          <p className="text-xs text-zinc-500">Loading its dashboard.</p>
        </div>
      ) : null}
    </div>
  );
}

function SignOut({ business }: { business: Business | null }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        // Remember this business first: logout clears the session but the
        // login screen should still wear its branding.
        if (business) {
          rememberBusiness({
            id: business.id,
            name: business.name,
            brand_color: business.brand_color,
            logo_data: business.logo_data,
          });
        }
        logout();
        router.replace("/login");
      }}
      aria-label="Sign out"
      className="pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700"
    >
      <LogOut aria-hidden className="h-4 w-4" /> Sign out
    </button>
  );
}

const ONBOARDING_PATHS = ["/businesses", "/setup", "/login", "/"];

/* Shared sidebar content: desktop aside and the mobile drawer render the same body. */
function SidebarBody({ current, context, onNavigate, hideBrand }: { current: string; context: BusinessContext | null; onNavigate?: () => void; hideBrand?: boolean }) {
  return (
    <>
      {hideBrand ? null : <Brand context={context} />}
      <Link
        href="/assistant"
        onClick={onNavigate}
        className="mt-4 flex min-h-11 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-700"
      >
        <Search aria-hidden className="h-4 w-4" />
        <span className="flex-1">Search...</span>
        <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1.5 text-[11px] font-medium text-zinc-500">⌘K</kbd>
      </Link>
      <div className="flex-1">
        <SidebarLinks current={current} context={context ?? undefined} onNavigate={onNavigate} />
      </div>
      <div className="rounded-xl border border-zinc-200 p-3.5">
        <p className="text-sm font-semibold text-zinc-900">Talk to your business</p>
        <p className="mt-1 text-[13px] leading-snug text-zinc-600">
          Record sales, expenses and stock by voice or text.
        </p>
        <Link href="/assistant" onClick={onNavigate} className="mt-2 inline-block min-h-11 py-2 text-sm font-medium text-zinc-900 hover:underline">
          Open assistant
        </Link>
      </div>
      <div className="sticky bottom-0 -mb-1 mt-3 space-y-2 border-t border-zinc-100 bg-white pb-1 pt-2">
        <BusinessSwitcher context={context} />
        <SignOut business={context?.business ?? null} />
      </div>
    </>
  );
}

/* Bottom tab bar: thumb-reach navigation on phones. Desktop keeps the sidebar. */
const TAB_ORDER = [
  { href: "/assistant", label: "Assistant", Icon: MessagesSquare },
  { href: "/dashboard", label: "Home", Icon: LayoutDashboard },
  { href: "/transactions", label: "Record", Icon: ArrowLeftRight },
  { href: "/reports", label: "Reports", Icon: BarChart3 },
  { href: "/activity", label: "Activity", Icon: ListOrdered },
] as const;

function MobileBottomNav({ current, context }: { current: string; context?: RoleContext }) {
  const allowed = new Set(visibleLinks(context).map((l) => l.href));
  const tabs = TAB_ORDER.filter((t) => allowed.has(t.href));
  if (tabs.length === 0) return null;
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map(({ href, label, Icon }) => {
          const active = current === href || (href === "/transactions" && current.startsWith("/transactions/"));
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`mx-0.5 my-1 flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 text-[11px] leading-none ${
                  active ? "nav-active font-semibold text-zinc-900" : "font-medium text-zinc-500"
                }`}
              >
                <Icon aria-hidden className="h-5 w-5" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { context, loaded } = useBusinessContext();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const brand = context?.business.brand_color;
  const onOnboardingPath = pathname === "/businesses" || pathname === "/setup";
  // Only the owner can complete business setup, so only the owner is
  // ever gated by it. Everyone under the business goes straight to work.
  const isOwner = context?.role === "owner";
  const needsOnboarding = loaded && (!context || (isOwner && !setupComplete(context)));
  // While the session is still resolving, render the bare layout with no
  // sidebar and no nav. Otherwise every refresh flashes the full shell,
  // including on the onboarding page, which must never show it.
  const bare = pathname === "/login" || pathname === "/" || !loaded || (onOnboardingPath && needsOnboarding);

  // Lock page scroll while the mobile drawer is open; Escape closes it.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);

  // New users finish onboarding before any app page opens.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- close drawer after navigation
    setDrawerOpen(false);
    if (!loaded) return;
    if (pathname === "/dashboard" || pathname === "/assistant") {
      // Handled below: no business at all goes to business setup.
    }
    if (!context) {
      if (!ONBOARDING_PATHS.includes(pathname)) router.replace("/businesses");
      return;
    }
    if (ONBOARDING_PATHS.includes(pathname)) return;
    if (context.role === "owner" && !setupComplete(context))
      router.replace("/setup?onboarding=1");
  }, [context, loaded, pathname, router]);

  if (bare) {
    return (
      <div className="flex min-h-dvh w-full flex-col bg-[#f4f4f2]">
        <OfflineNote />
        <div className="flex w-full flex-1 flex-col px-4 py-6 sm:px-6 sm:py-10 lg:px-10">
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-full flex-col"
      style={{ "--brand": brand || "#14532d" } as React.CSSProperties}
    >
      <OfflineNote />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-zinc-900"
      >
        Skip to content
      </a>
      <header className="border-b border-zinc-200 bg-white md:hidden">
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            aria-label="Open menu"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-zinc-700 hover:bg-zinc-100"
          >
            <Menu aria-hidden className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <Brand context={context} />
          </div>
          <BusinessSwitcher context={context} compact />
        </div>
      </header>
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
            className="absolute inset-0 h-full w-full cursor-default bg-zinc-950/40"
          />
          <div className="rail-scroll absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto bg-white px-4 py-4 shadow-xl">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <Brand context={context} />
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                autoFocus
                aria-label="Close menu"
                className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-zinc-700 hover:bg-zinc-100"
              >
                <X aria-hidden className="h-5 w-5" />
              </button>
            </div>
            <SidebarBody current={pathname} context={context} onNavigate={() => setDrawerOpen(false)} hideBrand />
          </div>
        </div>
      ) : null}
      <div className="flex flex-1 items-stretch">
        <aside className="rail-scroll sticky top-0 hidden h-dvh w-64 shrink-0 flex-col overflow-y-auto border-r border-zinc-200 bg-white px-4 py-4 md:flex">
          <SidebarBody current={pathname} context={context} />
        </aside>
        <div className="min-w-0 flex-1">
          <div className="sticky top-0 z-10 hidden items-center justify-between border-b border-zinc-200 bg-white px-6 py-3 md:flex">
            <span className="w-40" />
            <p className="text-sm font-medium text-zinc-900">
              {LINKS.flatMap((l) => [l, ...(l.children ?? [])]).find((l) => l.href === pathname)?.label ?? "ShopTalk"}
            </p>
            <div className="flex w-40 items-center justify-end gap-1.5">
              <Link href="/setup" aria-label="Help and setup" className="rounded-full border border-zinc-200 p-2 text-zinc-600 hover:text-zinc-900">
                <CircleHelp aria-hidden className="h-4 w-4" />
              </Link>
              <Link href="/activity" aria-label="Recent activity" className="rounded-full border border-zinc-200 p-2 text-zinc-600 hover:text-zinc-900">
                <Bell aria-hidden className="h-4 w-4" />
              </Link>
              <Link href="/businesses" aria-label="Switch business" className="ml-1">
                <BrandMark context={context} />
              </Link>
            </div>
          </div>
          <main id="main" tabIndex={-1} className="w-full px-4 py-4 pb-28 sm:px-6 sm:py-6 md:pb-8 lg:px-8">{children}</main>
        </div>
      </div>
      <MobileBottomNav current={pathname} context={context ?? undefined} />
      <InstallPrompt />
      <FloatingMic />
    </div>
  );
}
