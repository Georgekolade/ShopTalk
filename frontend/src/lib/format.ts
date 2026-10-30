/* Money + date formatting in the business currency/locale. */

export function money(value: string | number | null | undefined, currency: string): string {
  const num = typeof value === "number" ? value : Number(value ?? 0);
  if (!currency) return String(value ?? "0");
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(num) ? num : 0);
  } catch {
    return `${currency} ${value ?? "0"}`;
  }
}

/** Human amount without currency symbol: 9,500.00. */
export function amount(value: string | number | null | undefined): string {
  const num = typeof value === "number" ? value : Number(value ?? 0);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(num) ? num : 0);
}

/** Human count or quantity: 1,250 or 1,250.5. */
export function humanNumber(value: string | number | null | undefined): string {
  const num = typeof value === "number" ? value : Number(value ?? 0);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 3,
  }).format(Number.isFinite(num) ? num : 0);
}

export function deltaLabel(delta: number | null | undefined): string {
  if (delta === null || delta === undefined) return "new";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta}%`;
}

/** Brand color guard: only 6-digit hex reaches paint; anything else falls back. */
export function brandHex(color: string | null | undefined, fallback: string): string {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

/** Translucent fill from a hex brand color, e.g. #14532d -> #14532d14. */
export function brandFill(color: string | null | undefined, alphaHex: string, fallback: string): string {
  const hex = brandHex(color, "");
  return hex ? `${hex}${alphaHex}` : fallback;
}
