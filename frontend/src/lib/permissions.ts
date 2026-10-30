/* Mirror of backend ROLE_PERMISSIONS. Backend still enforces every request. */

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: ["*"],
  manager: ["*"],
  sales: ["sales.write", "catalogue.view", "assistant.use"],
  staff: ["sales.write", "catalogue.view", "assistant.use"],
  inventory: ["stock.write", "catalogue.write", "catalogue.view", "reports.view", "activity.view", "assistant.use"],
  finance: ["expenses.write", "reports.view", "catalogue.view", "activity.view", "assistant.use"],
  viewer: ["reports.view", "catalogue.view", "activity.view"],
};

export function can(role: string | undefined, permission: string): boolean {
  if (!role) return false;
  const allowed = ROLE_PERMISSIONS[role] ?? [];
  return allowed.includes("*") || allowed.includes(permission);
}

/** Effective check: server-computed grants win, role defaults are the fallback. */
export function canDo(
  context: { role?: string; permissions?: string[] } | null | undefined,
  permission: string,
): boolean {
  const granted = context?.permissions;
  if (granted && granted.length > 0) {
    return granted.includes("*") || granted.includes(permission);
  }
  return can(context?.role, permission);
}

export const GRANTABLE_PERMISSIONS: { value: string; label: string }[] = [
  { value: "sales.write", label: "Record sales" },
  { value: "stock.write", label: "Receive stock" },
  { value: "expenses.write", label: "Record expenses" },
  { value: "catalogue.write", label: "Edit catalogue" },
  { value: "catalogue.view", label: "View catalogue" },
  { value: "reports.view", label: "View reports" },
  { value: "activity.view", label: "View activity" },
  { value: "assistant.use", label: "Use assistant" },
];

export const PERMISSION_COLUMNS: { permission: string; label: string }[] = [
  { permission: "assistant.use", label: "Assistant" },
  { permission: "catalogue.write", label: "Catalogue Edit" },
  { permission: "sales.write", label: "Sales" },
  { permission: "stock.write", label: "Stock" },
  { permission: "expenses.write", label: "Expenses" },
  { permission: "reports.view", label: "Reports" },
];
