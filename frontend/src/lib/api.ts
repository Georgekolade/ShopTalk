/* Typed client for the ShopTalk Django API. */

import { ApiError, ApiErrorEnvelope } from "./types";

// Empty = same-origin /api/*, rewritten server-side to the backend.
// Never fall back to 127.0.0.1: in production that is the visitor's own
// machine, not the backend, and every auth call fails.
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

const TOKEN_KEY = "shoptalk.token";
const BUSINESS_KEY = "shoptalk.businessId";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export function getBusinessId(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(BUSINESS_KEY);
  const id = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(id) ? id : null;
}

export function setBusinessId(id: number | null) {
  if (typeof window === "undefined") return;
  if (id === null) window.localStorage.removeItem(BUSINESS_KEY);
  else window.localStorage.setItem(BUSINESS_KEY, String(id));
}

export function logout() {
  setToken(null);
  setBusinessId(null);
  // A parked assistant draft belongs to the signed-out session.
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem("shoptalk.assistantDraft");
  }
}

const LAST_KEY = "shoptalk.lastBusiness";

export interface LastBusiness {
  id: number;
  name: string;
  brand_color: string;
  logo_data: string;
  /** Account that last used this business on this device, when known.
   * Login only re-picks a stored business for that same account. */
  username?: string;
}

/** The business the user last worked in. Survives logout so the login
 * screen can wear its branding and the next sign-in can skip the picker. */
export function getLastBusiness(): LastBusiness | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastBusiness>;
    if (typeof parsed.id !== "number" || typeof parsed.name !== "string") return null;
    return {
      id: parsed.id,
      name: parsed.name,
      brand_color: typeof parsed.brand_color === "string" ? parsed.brand_color : "",
      logo_data: typeof parsed.logo_data === "string" ? parsed.logo_data : "",
      username: typeof parsed.username === "string" ? parsed.username : undefined,
    };
  } catch {
    return null;
  }
}

/** Snapshot the current business. Merges so partial updates keep brand assets,
 * but switching businesses drops the previous one's assets. */
export function rememberBusiness(next: Partial<LastBusiness> & { id: number; name: string }): void {
  if (typeof window === "undefined") return;
  const prev = getLastBusiness();
  const same = prev?.id === next.id;
  const merged: LastBusiness = {
    id: next.id,
    name: next.name,
    brand_color: next.brand_color ?? (same ? prev?.brand_color ?? "" : ""),
    logo_data: next.logo_data ?? (same ? prev?.logo_data ?? "" : ""),
    username: next.username ?? (same ? prev?.username : undefined),
  };
  try {
    window.localStorage.setItem(LAST_KEY, JSON.stringify(merged));
  } catch {
    // Private mode: login falls back to ShopTalk branding.
  }
}

function isEnvelope(body: unknown): body is ApiErrorEnvelope {
  if (typeof body !== "object" || body === null) return false;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) return false;
  return typeof (err as { message?: unknown }).message === "string";
}

function timeoutError(): ApiError {
  return new ApiError(0, {
    error: {
      code: "timeout",
      message: "ShopTalk took too long to answer.",
      field: null,
      next_step:
        "Wait a moment, then retry. If it keeps happening, check that " +
        "the ShopTalk backend and AI service are running.",
    },
  });
}

function networkError(): ApiError {
  return new ApiError(0, {
    error: {
      code: "network",
      message: "Cannot reach the ShopTalk server.",
      field: null,
      next_step: API_BASE
        ? `Start the backend, then retry. Expected at ${API_BASE}.`
        : "Check that the ShopTalk services are running, then retry.",
    },
  });
}

/** Parse a JSON body, but turn HTML error pages (proxy 404s, Django debug
 * pages, ngrok blocks) into a readable error instead of a JSON doctype crash. */
function parseJsonBody(text: string, status: number): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const looksHtml = /^\s*</.test(text);
    throw new ApiError(status, {
      error: {
        code: "bad-response",
        message: looksHtml
          ? "Server returned a page instead of data."
          : "Server returned an unreadable response.",
        field: null,
        next_step:
          "The ShopTalk backend did not answer properly. Check that the backend service is running (port 8000), then retry.",
      },
    });
  }
}

// Concurrent identical GETs (shell + page both ask for /context) share
// one network round trip. Entries clear on settle, so data stays fresh.
const inFlightGets = new Map<string, Promise<unknown>>();

export function api<T>(
  path: string,
  options: { method?: string; body?: unknown; form?: FormData; timeoutMs?: number } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  if (method !== "GET") return apiOnce<T>(path, options);
  const key = `${path}::${getToken() ?? ""}`;
  const existing = inFlightGets.get(key);
  if (existing) return existing as Promise<T>;
  const pending = apiOnce<T>(path, options).finally(() => inFlightGets.delete(key));
  inFlightGets.set(key, pending);
  return pending;
}

async function apiOnce<T>(
  path: string,
  options: { method?: string; body?: unknown; form?: FormData; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Token ${token}`;
  let payload: BodyInit | undefined;
  if (options.form) {
    payload = options.form;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(options.body);
  }
  const method = options.method ?? "GET";
  let response: Response;
  for (let attempt = 1; ; attempt += 1) {
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
      });
      break;
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      // Slow mobile networks drop the first try; safe reads get one retry.
      if (timedOut && method === "GET" && attempt < 2) continue;
      if (timedOut) throw timeoutError();
      throw networkError();
    }
  }
  const text = await response.text();
  const data: unknown = parseJsonBody(text, response.status);
  if (response.status === 401 && getToken()) {
    // Stale token (for example after a database reset): clear it once and
    // send the user to sign in instead of repeating failed requests.
    logout();
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
    }
  }
  if (!response.ok) {
    if (isEnvelope(data)) throw new ApiError(response.status, data);
    throw new ApiError(response.status, {
      error: {
        code: "internal",
        message: `Request failed (${response.status}).`,
        field: null,
        next_step: "Retry. If it repeats, check the server logs.",
      },
    });
  }
  return data as T;
}

export function biz(path: string, businessId: number): string {
  return `/api/businesses/${businessId}${path}`;
}

export async function apiBlob(path: string): Promise<Blob> {
  const token = getToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Token ${token}` } : {},
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        const data: unknown = JSON.parse(text);
        if (isEnvelope(data)) throw new ApiError(response.status, data);
      } catch (err) {
        if (err instanceof ApiError) throw err;
      }
    }
    throw new Error(`Download failed (${response.status}).`);
  }
  return response.blob();
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
