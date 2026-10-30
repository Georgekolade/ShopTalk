/* In-app toasts: bottom-end stack matching the light theme. No vendor UI. */

type ToastKind = "success" | "error" | "info";

const DURATIONS: Record<ToastKind, number> = {
  success: 2800,
  error: 4200,
  info: 2800,
};

const DOTS: Record<ToastKind, string> = {
  success: "background:#15803d",
  error: "background:#b91c1c",
  info: "background:#0369a1",
};

const BARS: Record<ToastKind, string> = {
  success: "background:#15803d",
  error: "background:#b91c1c",
  info: "background:#0369a1",
};

function ensureStack(): HTMLElement {
  let stack = document.getElementById("st-toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "st-toast-stack";
    stack.setAttribute("role", "region");
    stack.setAttribute("aria-label", "Notifications");
    stack.style.cssText = [
      "position:fixed",
      "right:max(1rem, env(safe-area-inset-right))",
      "bottom:max(1rem, env(safe-area-inset-bottom))",
      "z-index:100",
      "display:flex",
      "flex-direction:column",
      "gap:0.5rem",
      "max-width:calc(100vw - 2rem)",
      "width:22rem",
    ].join(";");
    document.body.appendChild(stack);
  }
  return stack;
}

function show(kind: ToastKind, title: string) {
  if (typeof document === "undefined") return;
  const stack = ensureStack();
  while (stack.children.length >= 3) stack.firstElementChild?.remove();

  const el = document.createElement("div");
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.style.cssText = [
    "position:relative",
    "overflow:hidden",
    "background:#fff",
    "border:1px solid #e4e4e7",
    "border-radius:0.9rem",
    "box-shadow:0 12px 32px rgb(0 0 0 / 0.12)",
    "padding:0.7rem 0.9rem 0.85rem",
    "display:flex",
    "align-items:center",
    "gap:0.6rem",
    "animation:st-toast-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both",
  ].join(";");

  const dot = document.createElement("span");
  dot.setAttribute("aria-hidden", "true");
  dot.style.cssText = `flex-shrink:0;width:0.55rem;height:0.55rem;border-radius:9999px;${DOTS[kind]}`;

  const text = document.createElement("p");
  text.textContent = title;
  text.style.cssText = "flex:1;min-width:0;margin:0;font-size:0.85rem;font-weight:500;color:#18181b;line-height:1.35;overflow-wrap:anywhere";

  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.style.cssText = [
    "flex-shrink:0",
    "width:2.75rem",
    "height:2.75rem",
    "border-radius:9999px",
    "border:0",
    "background:#f4f4f5",
    "color:#52525b",
    "font-size:1rem",
    "line-height:1",
    "cursor:pointer",
  ].join(";");

  const bar = document.createElement("span");
  bar.setAttribute("aria-hidden", "true");
  bar.style.cssText = [
    "position:absolute",
    "left:0",
    "bottom:0",
    "height:2px",
    "width:100%",
    "transform-origin:left",
    `animation:st-toast-bar ${DURATIONS[kind]}ms linear forwards`,
    BARS[kind],
  ].join(";");

  el.append(dot, text, close, bar);
  stack.appendChild(el);

  let remaining = DURATIONS[kind];
  let startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const dismiss = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    el.style.transition = "opacity 160ms ease, transform 160ms ease";
    el.style.opacity = "0";
    el.style.transform = "translateY(4px)";
    window.setTimeout(() => el.remove(), 170);
  };
  const arm = (ms: number) => {
    startedAt = Date.now();
    timer = setTimeout(dismiss, ms);
  };
  close.addEventListener("click", dismiss);
  el.addEventListener("mouseenter", () => {
    if (timer) clearTimeout(timer);
    timer = null;
    remaining -= Date.now() - startedAt;
    bar.style.animationPlayState = "paused";
  });
  el.addEventListener("mouseleave", () => {
    bar.style.animationPlayState = "running";
    arm(Math.max(0, remaining));
  });
  arm(remaining);
}

export function toastSuccess(title: string) {
  show("success", title);
}

export function toastError(title: string) {
  show("error", title);
}

export function toastInfo(title: string) {
  show("info", title);
}
