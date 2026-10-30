/* Floating mic: dictate from any app page, lands in the assistant. */

"use client";

import { usePathname, useRouter } from "next/navigation";
import { Mic, Square } from "lucide-react";
import { useSpeechInput } from "../lib/voice";
import { toastError, toastInfo } from "../lib/toast";

export const ASSISTANT_DRAFT_KEY = "shoptalk.assistantDraft";

export function FloatingMic() {
  const router = useRouter();
  const pathname = usePathname();
  const { listening, interim, supported, toggle, voiceError } = useSpeechInput((text) => {
    // Append, never overwrite: a second recording adds to the first so the
    // assistant receives the whole story, not just the last turn.
    try {
      const prev = window.sessionStorage.getItem(ASSISTANT_DRAFT_KEY);
      window.sessionStorage.setItem(ASSISTANT_DRAFT_KEY, prev ? `${prev} ${text}` : text);
    } catch {
      try {
        window.sessionStorage.setItem(ASSISTANT_DRAFT_KEY, text);
      } catch {
        // Storage blocked: navigation still shows the toast below.
      }
    }
    toastInfo("Heard you. Review it in the assistant.");
    if (pathname !== "/assistant") router.push("/assistant");
  });

  if (!supported || pathname === "/assistant") return null;

  return (
    <div className="fixed bottom-24 right-4 z-50 flex flex-col items-end gap-2 sm:bottom-6 sm:right-6 md:bottom-6">
      {voiceError ? (
        <p role="alert" className="max-w-64 rounded-xl border border-red-200 bg-white px-3 py-2 text-sm text-red-800 shadow-lg">
          {voiceError}
        </p>
      ) : null}
      {listening ? (
        <p role="status" className="max-w-64 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 shadow-lg">
          {interim ? interim : "Listening… keep talking, tap stop when done"}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => {
          if (voiceError) toastError(voiceError);
          toggle();
        }}
        aria-label={listening ? "Stop voice input" : "Voice input, opens assistant"}
        title={listening ? "Stop listening" : "Talk to your business"}
        className={`flex h-14 w-14 items-center justify-center rounded-full text-white shadow-[0_10px_28px_rgba(0,0,0,0.22)] transition-colors ${
          listening ? "mic-live bg-red-700" : "bg-zinc-900 hover:bg-zinc-700"
        }`}
      >
        {listening ? <Square aria-hidden className="h-5 w-5" /> : <Mic aria-hidden className="h-6 w-6" />}
      </button>
    </div>
  );
}
