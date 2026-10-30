/* Install prompt: browser install banner for the ShopTalk PWA. */

"use client";

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

type BIPEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

const DISMISS_KEY = "shoptalk.installDismissed";

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  // iOS has no install event: decided after mount so server HTML matches.
  const [showIos, setShowIos] = useState(false);
  // Session dismissal reads once at mount; never bounced through an effect.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return window.sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (isIos() && !isStandalone()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only platform check after mount
      setShowIos(true);
    }
    if (isStandalone() || isIos()) return;
    function onBIP(e: Event) {
      e.preventDefault();
      setDeferred(e as BIPEvent);
    }
    window.addEventListener("beforeinstallprompt", onBIP);
    return () => window.removeEventListener("beforeinstallprompt", onBIP);
  }, []);

  if (isStandalone() || dismissed) return null;
  if (!deferred && !showIos) return null;

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    try {
      await deferred.userChoice;
    } catch {
      // Choice unresolved: keep the banner up.
      return;
    }
    setDeferred(null);
    dismiss();
  }

  function dismiss() {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Private mode: banner simply hides for this view.
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Install ShopTalk"
      className="fixed inset-x-3 bottom-44 z-40 rounded-2xl border border-zinc-200 bg-white p-3 shadow-[0_10px_28px_rgba(0,0,0,0.16)] md:inset-x-auto md:bottom-6 md:right-6 md:w-80"
    >
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/icon-192.png" alt="" width={40} height={40} className="h-10 w-10 rounded-xl" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-900">Install ShopTalk</p>
          <p className="mt-0.5 text-[13px] leading-snug text-zinc-600">
            {showIos && !deferred
              ? "Tap Share, then Add to Home Screen for full-screen access."
              : "Add it to your home screen for full-screen, one-tap access."}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
      {deferred ? (
        <button
          type="button"
          onClick={install}
          className="mt-2.5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white"
        >
          <Download aria-hidden className="h-4 w-4" /> Install app
        </button>
      ) : null}
    </div>
  );
}
