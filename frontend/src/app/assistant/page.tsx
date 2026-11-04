/* Assistant: text/voice chat, action previews, confirm or decline. */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiBlob, biz, downloadBlob } from "../../lib/api";
import { AssistantReply, ConfirmResult, PendingActionPayload, SaleDocuments, VisualPayload } from "../../lib/types";
import { VisualBlock } from "../../components/assistant-visual";
import { ChevronDown, Download, Ear, FileText, Keyboard, MessagesSquare, Mic, Paperclip, Printer, Send, Share2, Square, Trash2, Volume2, VolumeX, X } from "lucide-react";
import { cancelSpeech, isTtsSupported, speak, useSpeechInput } from "../../lib/voice";
import { useBusinessContext, useSession } from "../../components/nav";
import { canDo } from "../../lib/permissions";
import { ErrorNote, Loading, StateBadge, primaryButtonClass, secondaryButtonClass } from "../../components/ui";
import { ASSISTANT_DRAFT_KEY } from "../../components/floating-mic";
import { toastError, toastInfo, toastSuccess } from "../../lib/toast";
import { amount, money } from "../../lib/format";

interface ChatMessage {
  key: string;
  role: "user" | "assistant";
  text: string;
  state?: string;
  action?: PendingActionPayload | null;
  documents?: SaleDocuments | null;
  visual?: VisualPayload | null;
}

function DocumentCard({
  documents,
  businessName,
  currency,
}: {
  documents: SaleDocuments;
  businessName: string;
  currency: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const slug = businessName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "ShopTalk";
  const lines = documents.lines ?? [];
  const total = documents.total ? (currency ? money(documents.total, currency) : amount(documents.total)) : null;

  async function downloadInvoice() {
    if (busy) return;
    const filename = `${slug}-Invoice-${documents.invoice_number}.pdf`;
    setBusy("invoice");
    try {
      const blob = await apiBlob(documents.invoice_url);
      downloadBlob(blob, filename);
      toastSuccess("Invoice downloaded.");
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setBusy(null);
    }
  }

  async function printReceipt() {
    if (busy) return;
    setBusy("print");
    try {
      const blob = await apiBlob(documents.receipt_url);
      const objectUrl = URL.createObjectURL(blob);
      const frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
      frame.src = objectUrl;
      frame.onload = () => {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        window.setTimeout(() => { frame.remove(); URL.revokeObjectURL(objectUrl); }, 60_000);
      };
      document.body.appendChild(frame);
      toastSuccess("Receipt sent to the printer.");
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Print failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200">
      <div className="bg-zinc-50 p-3">
        <div className="mx-auto max-w-[220px] rounded-lg bg-white p-3 shadow-sm ring-1 ring-zinc-100">
          <p className="text-center text-[11px] font-bold leading-tight text-zinc-900">{businessName || "Receipt"}</p>
          <p className="mt-0.5 text-center text-[9px] text-zinc-500">
            {documents.receipt_number ? `#${documents.receipt_number}` : `Sale #${documents.sale_id}`}
          </p>
          <div className="my-2 border-t border-dashed border-zinc-200" />
          {lines.slice(0, 4).map((line, i) => (
            <div key={i} className="flex justify-between gap-2 py-0.5 text-[10px]">
              <span className="min-w-0 truncate text-zinc-700">{line.product} ×{line.quantity}</span>
              <span className="shrink-0 tabular-nums text-zinc-900">{amount(line.line_total)}</span>
            </div>
          ))}
          {lines.length > 4 ? <p className="py-0.5 text-[9px] text-zinc-400">+{lines.length - 4} more items</p> : null}
          {total ? (
            <>
              <div className="my-2 border-t border-dashed border-zinc-200" />
              <div className="flex justify-between text-[11px] font-bold text-zinc-900">
                <span>Total</span>
                <span className="tabular-nums">{total}</span>
              </div>
            </>
          ) : null}
          <p className="mt-2 text-center text-[8px] tracking-wide text-zinc-400">Powered by ShopTalk AI</p>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-zinc-100 bg-white px-3 py-2">
        <FileText aria-hidden className="h-4 w-4 shrink-0 text-green-800" />
        <p className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-900">{documents.invoice_number}</p>
        {total ? <p className="shrink-0 text-xs font-bold tabular-nums text-green-900">{total}</p> : null}
      </div>
      <div className="flex border-t border-zinc-100 bg-white">
        <button type="button" disabled={busy !== null} onClick={printReceipt} className="flex min-h-10 flex-1 items-center justify-center gap-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50">
          <Printer aria-hidden className="h-3.5 w-3.5" />
          {busy === "print" ? "…" : "Receipt"}
        </button>
        <button type="button" disabled={busy !== null} onClick={downloadInvoice} className="flex min-h-10 flex-1 items-center justify-center gap-1.5 border-l border-zinc-100 text-xs font-semibold text-green-800 transition-colors hover:bg-green-50 disabled:opacity-50">
          <Download aria-hidden className="h-3.5 w-3.5" />
          {busy === "invoice" ? "…" : "Invoice"}
        </button>
      </div>
    </div>
  );
}

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `msg-${Date.now()}-${keyCounter}`;
}

interface HistoryItem {
  role: string;
  content: string;
  documents?: SaleDocuments | null;
  visual?: VisualPayload | null;
}

function sameText(role: "user" | "assistant", localText: string, remote: string): boolean {
  if (localText === remote) return true;
  // Attached files render as "name: instruction" locally but are stored
  // as the plain instruction on the server.
  if (role === "user") {
    const cut = localText.indexOf(": ");
    if (cut !== -1 && localText.slice(cut + 2) === remote) return true;
  }
  return false;
}

/** Fold freshly polled history into local state: server order wins, but
 * nothing duplicates and local-only extras (pending approval cards,
 * badges) survive. A trailing local tail not yet on the server (a send
 * still in flight) is kept as-is. Returns the very same array when
 * nothing changed, so polls don't re-render or re-scroll the chat. */
function mergeServerMessages(old: ChatMessage[], items: HistoryItem[]): ChatMessage[] {
  const server = items.filter((m) => m.role === "user" || m.role === "assistant");
  if (server.length === 0) return old.length === 0 ? old : [];
  const merged: ChatMessage[] = [];
  let li = 0;
  for (const s of server) {
    let found = -1;
    for (let j = li; j < old.length; j += 1) {
      if (old[j].role === s.role && sameText(old[j].role, old[j].text, s.content)) {
        found = j;
        break;
      }
    }
    if (found === -1) {
      merged.push({
        key: nextKey(),
        role: s.role as "user" | "assistant",
        text: s.content,
        documents: s.documents ?? undefined,
        visual: s.visual ?? undefined,
      });
    } else {
      const keep = old[found];
      const docs = keep.documents ?? s.documents ?? undefined;
      const vis = keep.visual ?? s.visual ?? undefined;
      merged.push(keep.documents === docs && keep.visual === vis ? keep : { ...keep, documents: docs, visual: vis });
      li = found + 1;
    }
  }
  for (let j = li; j < old.length; j += 1) merged.push(old[j]);
  if (merged.length === old.length && merged.every((m, i) => m === old[i])) return old;
  return merged;
}

function ApprovalCard({
  action,
  onDecide,
  busy,
}: {
  action: PendingActionPayload;
  onDecide: (confirm: boolean) => void;
  busy: boolean;
}) {
  const payload = action.payload as {
    lines?: { product: string; quantity: string; line_total: string }[];
    name?: string;
    kind?: string;
    selling_price?: string;
    cost_price?: string | null;
    stock_tracked?: boolean;
    changes?: { label: string; from: string; to: string }[];
  };
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-amber-300 bg-amber-50">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 px-3 py-2">
        <p className="text-xs font-semibold text-amber-900">Review: {action.action_type.replaceAll("_", " ")}</p>
        <StateBadge state={action.state} />
      </div>
      <div className="px-3 py-3">
        <p className="text-sm text-zinc-800">{action.summary}</p>
        {payload.lines ? (
          <dl className="mt-2 space-y-1 border-t border-amber-200 pt-2 text-sm">
            {payload.lines.map((line, index) => (
              <div key={index} className="flex justify-between gap-3">
                <dt className="text-zinc-700">
                  {line.product} <span className="text-zinc-500">x {line.quantity}</span>
                </dt>
                <dd className="font-medium tabular-nums text-zinc-900">{amount(line.line_total)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {!payload.lines && payload.name ? (
          <dl className="mt-2 space-y-1 border-t border-amber-200 pt-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-700">Item</dt>
              <dd className="font-medium text-zinc-900">{payload.name}{payload.kind ? ` (${payload.kind})` : null}</dd>
            </div>
            {payload.selling_price ? (
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-700">Selling price</dt>
                <dd className="font-medium tabular-nums text-zinc-900">{amount(payload.selling_price)}</dd>
              </div>
            ) : null}
            {payload.cost_price ? (
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-700">Cost price</dt>
                <dd className="font-medium tabular-nums text-zinc-900">{amount(payload.cost_price)}</dd>
              </div>
            ) : null}
            {payload.stock_tracked ? (
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-700">Stock</dt>
                <dd className="font-medium text-zinc-900">Tracked</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {!payload.lines && payload.changes ? (
          <dl className="mt-2 space-y-1 border-t border-amber-200 pt-2 text-sm">
            {payload.changes.map((change, index) => (
              <div key={index} className="flex justify-between gap-3">
                <dt className="text-zinc-700">{change.label}</dt>
                <dd className="font-medium tabular-nums text-zinc-900">{change.from} → {change.to}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button type="button" disabled={busy} onClick={() => onDecide(true)} className={`${primaryButtonClass} w-full sm:w-auto`}>
            Confirm
          </button>
          <button type="button" disabled={busy} onClick={() => onDecide(false)} className={`${secondaryButtonClass} w-full sm:w-auto`}>
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}

function highlightAmounts(text: string): React.ReactNode {
  const pattern = /(?:NGN|USD|GBP|EUR|GHS|KES|ZAR|XOF|XAF|₦|\$|€|£|₵)\s?[\d,]+(?:\.\d{1,2})?|[+-]?\d+(?:\.\d+)?%/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(<strong key={m.index} className="font-semibold tabular-nums">{m[0]}</strong>);
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length > 1 ? nodes : text;
}

/** Inline emphasis + amounts: **bold** first, then money highlighting. */
function renderInline(text: string, keyPrefix: string): React.ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return highlightAmounts(text);
  const nodes: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      nodes.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold text-zinc-900">
          {highlightAmounts(part)}
        </strong>,
      );
    } else {
      nodes.push(<span key={`${keyPrefix}-t${i}`}>{highlightAmounts(part)}</span>);
    }
  });
  return nodes;
}

function isTableRow(line: string): boolean {
  return /^\|.*\|\s*$/.test(line.trim());
}

function isTableDivider(line: string): boolean {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|");
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function FormattedReply({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let bulletBuffer: string[] = [];
  let numbered = false;
  let tableBuffer: string[][] = [];

  function flushBullets() {
    if (bulletBuffer.length === 0) return;
    const Tag = numbered ? "ol" : "ul";
    const cls = numbered ? "my-2 list-decimal space-y-1 pl-5" : "my-2 list-disc space-y-1 pl-5";
    elements.push(
      <Tag key={`b-${elements.length}`} className={cls}>
        {bulletBuffer.map((b, i) => <li key={i}>{renderInline(b, `li${elements.length}-${i}`)}</li>)}
      </Tag>,
    );
    bulletBuffer = [];
    numbered = false;
  }

  function flushTable() {
    if (tableBuffer.length === 0) return;
    const [header] = tableBuffer;
    const rows =
      tableBuffer.length > 1 && isTableDivider(`|${tableBuffer[1].join("|")}|`)
        ? tableBuffer.slice(2)
        : tableBuffer.slice(1);
    elements.push(
      <div key={`t-${elements.length}`} className="my-2 overflow-x-auto rounded-lg border border-zinc-200">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-zinc-50">
              {header.map((cell, i) => (
                <th
                  key={i}
                  scope="col"
                  className={`border-b border-zinc-200 px-2.5 py-1.5 font-semibold text-zinc-700 ${i === 0 ? "text-left" : "text-right"}`}
                >
                  {renderInline(cell, `th${elements.length}-${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="odd:bg-white even:bg-zinc-50/60">
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className={`border-t border-zinc-100 px-2.5 py-1.5 text-zinc-800 ${c === 0 ? "text-left" : "text-right tabular-nums"}`}
                  >
                    {renderInline(cell, `td${elements.length}-${r}-${c}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    tableBuffer = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = trimmed.match(/^(#{2,3})\s+(.*)/);
    if (heading) {
      flushBullets();
      flushTable();
      const level = heading[1].length;
      elements.push(
        level === 2 ? (
          <h3 key={`h-${elements.length}`} className="mb-1 mt-3 text-[15px] font-bold tracking-tight text-zinc-900 first:mt-0">
            {renderInline(heading[2], `h${elements.length}`)}
          </h3>
        ) : (
          <h4 key={`h-${elements.length}`} className="mb-0.5 mt-2.5 text-[13px] font-bold text-zinc-900 first:mt-0">
            {renderInline(heading[2], `h${elements.length}`)}
          </h4>
        ),
      );
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushBullets();
      flushTable();
      elements.push(<hr key={`r-${elements.length}`} className="my-2.5 border-zinc-200" />);
      continue;
    }
    if (isTableRow(trimmed)) {
      flushBullets();
      tableBuffer.push(splitRow(trimmed));
      continue;
    }
    flushTable();
    const bulletMatch = trimmed.match(/^[-•*]\s+(.*)/);
    const numMatch = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (bulletMatch) {
      if (numbered) flushBullets();
      numbered = false;
      bulletBuffer.push(bulletMatch[1]);
    } else if (numMatch) {
      if (!numbered && bulletBuffer.length > 0) flushBullets();
      numbered = true;
      bulletBuffer.push(numMatch[1]);
    } else {
      flushBullets();
      if (!trimmed) {
        elements.push(<span key={`s-${elements.length}`} className="block h-1.5" />);
      } else {
        elements.push(<p key={`p-${elements.length}`} className="my-1 leading-relaxed">{renderInline(trimmed, `p${elements.length}`)}</p>);
      }
    }
  }
  flushBullets();
  flushTable();
  return <div className="space-y-0.5">{elements}</div>;
}

function TypingRow() {
  return (
    <div className="flex justify-start" role="status" aria-label="Assistant is working">
      <div className="flex items-center gap-1.5 rounded-2xl bg-white px-4 py-3">
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-500" />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-500" />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-500" />
      </div>
    </div>
  );
}

/** Dictated text goes after whatever is already typed, never over it. */
function appendVoice(base: string, heard: string): string {
  const clean = heard.trim();
  if (!clean) return base;
  const trimmed = base.trimEnd();
  return trimmed ? `${trimmed} ${clean}` : clean;
}

function suggestionsFor(ctx: { role?: string; permissions?: string[] } | null): string[] {
  return [
    ...(canDo(ctx, "sales.write") ? ["Sell 2 garri"] : []),
    ...(canDo(ctx, "reports.view") ? ["How much did we sell this week?", "What is running low?"] : []),
    ...(canDo(ctx, "expenses.write") ? ["Spent 5000 on transport"] : []),
    ...(canDo(ctx, "stock.write") ? ["We received 10 garri"] : []),
  ].slice(0, 4);
}

export default function AssistantPage() {
  const { ready, businessId } = useSession();
  const { context } = useBusinessContext();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [voiceMode, setVoiceMode] = useState(false);
  // Server and first client paint agree on audio; stored preference and
  // floating-mic handoffs apply after mount (see below).
  const [mode, setMode] = useState<"audio" | "text">("audio");
  // Spoken replies are on unless the user turns them off.
  const [ttsOn, setTtsOn] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  // Latest control state for timers and mic callbacks (they see stale state).
  const ctlRef = useRef<{ continuous: boolean; mode: "audio" | "text"; supported: boolean; listening: boolean }>({
    continuous: true,
    mode: "audio",
    supported: false,
    listening: false,
  });
  const startRef = useRef<(() => void) | null>(null);
  const autoTimer = useRef<number | null>(null);
  // Continuous conversation: the mic re-opens after each reply (default on).
  const [continuous, setContinuous] = useState(true);

  // The mic stays open until the user taps stop: silence never stands it
  // down, so segment ends need no bookkeeping.
  const handleSegmentEnd = useCallback(() => {}, []);

  const speakReply = useCallback(
    (text: string) => {
      if (!ttsOn || !isTtsSupported()) return;
      if (autoTimer.current) {
        window.clearTimeout(autoTimer.current);
        autoTimer.current = null;
      }
      setSpeaking(true);
      speak(text, () => {
        setSpeaking(false);
        // Continuous conversation: the reply ends, the mic re-opens by
        // itself, Alexa-style. A short pause keeps it from hearing its
        // own tail as the user speaking.
        const ctl = ctlRef.current;
        if (!ctl.continuous || ctl.mode !== "audio" || !ctl.supported || ctl.listening) return;
        if (typeof document !== "undefined" && document.hidden) return;
        autoTimer.current = window.setTimeout(() => {
          autoTimer.current = null;
          const now = ctlRef.current;
          if (!now.continuous || now.mode !== "audio" || !now.supported || now.listening) return;
          if (typeof document !== "undefined" && document.hidden) return;
          startRef.current?.();
        }, 600);
      });
    },
    [ttsOn],
  );
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [attachment, setAttachment] = useState<File | null>(null);
  // Desktop audio mode: conversation floats at bottom-right, collapsible.
  const [chatOpen, setChatOpen] = useState(true);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Mirrors `busy` for the realtime poll (interval callbacks see stale state).
  const busyRef = useRef(false);
  // True while the user sits at the latest message: polls and replies may
  // auto-scroll. False while reading history: never yank the view.
  const stickRef = useRef(true);

  const updateStick = useCallback(() => {
    const doc = document.documentElement;
    const winNear = doc.scrollHeight - window.scrollY - window.innerHeight < 160;
    const box = chatBodyRef.current;
    const boxNear = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    stickRef.current = winNear && boxNear;
  }, []);
  // Text that was already in the box when the mic opened, and the live
  // transcript rendered after it. Dictation appends; it never wipes.
  const voiceBaseRef = useRef("");
  const voiceLiveRef = useRef("");

  const send = useCallback(
    async (text: string, inputMode: "text" | "voice") => {
      const file = inputMode === "text" ? attachment : null;
      const instruction = text.trim() || (file ? "Summarise this document." : "");
      if (!businessId || !instruction || busy) return;
      stickRef.current = true;
      setBusy(true);
      setError(null);
      const userMessage: ChatMessage = {
        key: nextKey(), role: "user",
        text: file ? `${file.name}: ${instruction}` : instruction,
      };
      setMessages((old) => [...old, userMessage]);
      setDraft("");
      setAttachment(null);
      try {
        const reply = file
          ? await (async () => {
              const form = new FormData();
              form.append("text", instruction);
              form.append("input_mode", inputMode);
              if (conversationId !== null) form.append("conversation_id", String(conversationId));
              form.append("file", file);
              return api<AssistantReply>(biz("/assistant/messages", businessId), { method: "POST", form, timeoutMs: 90000 });
            })()
          : await api<AssistantReply>(biz("/assistant/messages", businessId), {
              method: "POST",
              timeoutMs: 90000, body: { text: instruction, input_mode: inputMode, conversation_id: conversationId },
            });
        setConversationId(reply.conversation_id);
        setMessages((old) => [
          ...old,
          { key: nextKey(), role: "assistant", text: reply.reply, state: reply.state, action: reply.action, documents: reply.documents, visual: reply.visual },
        ]);
        speakReply(reply.reply);
      } catch (err) {
        setError(err);
        toastError(err instanceof Error ? err.message : "Assistant could not answer.");
      } finally {
        setBusy(false);
      }
    },
    [businessId, busy, conversationId, speakReply, attachment],
  );

  // A transcript that lands while a reply is still in flight waits here and
  // sends the moment the assistant is free. Nothing spoken is ever dropped.
  const pendingAudioRef = useRef<string | null>(null);
  const { listening, interim, supported, toggle, start, stop, voiceError } = useSpeechInput(
    (text) => {
      voiceLiveRef.current = "";
      setVoiceMode(true);
      if (mode === "audio") {
        // Audio mode is a live conversation: words send on their own.
        // Anything typed stays parked in the text box for later.
        if (!busy) {
          const kept = draft;
          send(text, "voice");
          if (kept) setDraft(kept);
        } else {
          pendingAudioRef.current = text;
          toastInfo("One moment, sending your words as soon as the last answer lands.");
        }
        return;
      }
      // Text mode: the final transcript appends after existing text for Send.
      const composed = appendVoice(voiceBaseRef.current, text);
      voiceBaseRef.current = composed;
      setDraft(composed);
      toastInfo("Heard you. Added to the box below. Check it, then Send.");
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    (live) => {
      // Live transcript renders after existing text while talking.
      if (mode !== "text") return;
      voiceLiveRef.current = live;
      setDraft(appendVoice(voiceBaseRef.current, live));
    },
    handleSegmentEnd,
  );

  useEffect(() => {
    startRef.current = start;
  });

  useEffect(() => {
    if (!busy && pendingAudioRef.current) {
      const text = pendingAudioRef.current;
      pendingAudioRef.current = null;
      const kept = draft;
      send(text, "voice");
      if (kept) setDraft(kept);
    }
  }, [busy, send, draft]);

  function switchMode(next: "audio" | "text") {
    if (next === mode) return;
    // A live turn finishes under the mode it started in: predictable, safe.
    if (listening) stop();
    setMode(next);
    try {
      window.localStorage.setItem("shoptalk-assistant-mode", next);
    } catch {
      // Private browsing: the toggle still works for this visit.
    }
  }

  const toggleVoice = useCallback(() => {
    if (!listening) {
      // Barge-in: cut off the speaking reply first, then listen.
      cancelSpeech();
      setSpeaking(false);
      if (autoTimer.current) {
        window.clearTimeout(autoTimer.current);
        autoTimer.current = null;
      }
      voiceBaseRef.current = draft;
      voiceLiveRef.current = "";
    }
    setVoiceMode(true);
    toggle();
  }, [listening, draft, toggle]);

  const toggleContinuous = useCallback(() => {
    setContinuous((c) => {
      const next = !c;
      try {
        window.localStorage.setItem("shoptalk-voice-continuous", next ? "1" : "0");
      } catch {
        /* preference only */
      }
      return next;
    });
  }, []);

  const toggleTts = useCallback(() => {
    const next = !ttsOn;
    setTtsOn(next);
    if (!next) {
      cancelSpeech();
      setSpeaking(false);
    } else if (isTtsSupported()) toastSuccess("Spoken replies on.");
  }, [ttsOn]);

  function handleDraftChange(value: string) {
    if (listening) {
      // Typed while dictating: fold keystrokes into the base so the next
      // live update appends after them instead of wiping them.
      const live = voiceLiveRef.current;
      voiceBaseRef.current = live && value.includes(live) ? value.replace(live, "").trimEnd() : value;
    }
    setDraft(value);
  }

  async function clearChat() {
    if (!businessId || busy) return;
    if (!confirmingClear) {
      setConfirmingClear(true);
      window.setTimeout(() => setConfirmingClear(false), 4000);
      return;
    }
    setConfirmingClear(false);
    try {
      await api(biz("/assistant/history", businessId), { method: "DELETE" });
      setMessages([]);
      setConversationId(null);
      setError(null);
      toastSuccess("Chat cleared. Start fresh below.");
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not clear chat.");
    }
  }

  useEffect(() => {
    let nextMode: "audio" | "text" | null = null;
    try {
      if (window.localStorage.getItem("shoptalk-voice-continuous") === "0") {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- restore persisted voice preference
        setContinuous(false);
      }
      const saved = window.sessionStorage.getItem(ASSISTANT_DRAFT_KEY);
      if (saved) {
        setDraft(saved);
        setVoiceMode(true);
        window.sessionStorage.removeItem(ASSISTANT_DRAFT_KEY);
        toastInfo("Heard you. Check it below, then Send.");
        requestAnimationFrame(() => textareaRef.current?.focus());
        nextMode = "text";
      } else if (window.localStorage.getItem("shoptalk-assistant-mode") === "text") {
        nextMode = "text";
      }
    } catch {
      // Private mode: stay on the audio default.
    }
    if (nextMode) {
      setMode(nextMode);
    }
  }, []);

  useEffect(() => {
    if (!businessId) return;
    api<{
      conversation_id: number | null;
      messages: HistoryItem[];
    }>(biz("/assistant/history", businessId))
      .then((data) => {
        if (data.conversation_id) setConversationId(data.conversation_id);
        setMessages(
          data.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              key: nextKey(),
              role: m.role as "user" | "assistant",
              text: m.content,
              documents: m.documents ?? undefined,
              visual: m.visual ?? undefined,
            })),
        );
      })
      .catch(() => undefined);
  }, [businessId]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    ctlRef.current = { continuous, mode, supported, listening };
  });

  useEffect(() => {
    window.addEventListener("scroll", updateStick, { passive: true });
    return () => window.removeEventListener("scroll", updateStick);
  }, [updateStick]);

  // WhatsApp-style realtime: pick up turns sent from anywhere (another
  // device, another tab) within a few seconds. Merging keeps local-only
  // state like pending approval cards; nothing duplicates, nothing drops.
  useEffect(() => {
    if (!businessId) return;
    const bid = businessId;
    let stopped = false;
    async function poll() {
      if (stopped || document.hidden || busyRef.current) return;
      let data: {
        conversation_id: number | null;
        messages: HistoryItem[];
      } | null = null;
      try {
        data = await api<{
          conversation_id: number | null;
          messages: HistoryItem[];
        }>(biz("/assistant/history", bid));
      } catch {
        return; // off the air: try again on the next tick
      }
      if (stopped || busyRef.current || !data) return;
      setConversationId(data.conversation_id);
      setMessages((old) => mergeServerMessages(old, data.messages));
    }
    const id = window.setInterval(poll, 4000);
    const onVisible = () => {
      void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [businessId]);

  useEffect(() => {
    // Keep the latest turn visible — but only while the user sits at the
    // bottom. A realtime update must never yank someone reading history.
    if (!stickRef.current) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  useEffect(
    () => () => {
      if (autoTimer.current) window.clearTimeout(autoTimer.current);
      cancelSpeech();
    },
    [],
  );

  // A question waiting for confirmation must never hide in a collapsed box.
  useEffect(() => {
    if (messages.some((m) => m.action?.state === "awaiting_confirmation")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- surface pending approval
      setChatOpen(true);
    }
  }, [messages]);

  // Keep the newest turn visible inside the floating box (desktop).
  useEffect(() => {
    if (!stickRef.current) return;
    const box = chatBodyRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages, busy, chatOpen]);

  const decide = useCallback(
    async (action: PendingActionPayload, confirm: boolean) => {
      if (!businessId || busy) return;
      stickRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const result = await api<ConfirmResult>(biz(`/assistant/actions/${action.id}/confirm`, businessId), {
          method: "POST",
          timeoutMs: 30000, body: { confirm },
        });
        setMessages((old) => {
          const updated = old.map((message) =>
            message.action?.id === action.id ? { ...message, action: { ...action, state: result.state } } : message,
          );
          // Realtime sync (or a replayed confirm from another device) may
          // already show this reply: never append it twice.
          if (updated.some((message) => message.role === "assistant" && message.text === result.reply)) {
            return updated;
          }
          return [
            ...updated,
            { key: nextKey(), role: "assistant", text: result.reply, state: result.state, documents: result.documents },
          ];
        });
        toastSuccess(confirm ? "Confirmed and saved." : "Declined.");
        speakReply(result.reply);
      } catch (err) {
        setError(err);
        toastError(err instanceof Error ? err.message : "Could not finish that action.");
      } finally {
        setBusy(false);
      }
    },
    [businessId, busy, speakReply],
  );

  if (!ready || businessId === null) return <Loading label="Loading assistant..." />;
  if (context && !canDo(context, "assistant.use")) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-5 sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Assistant not available</h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600">
          Your role ({context.role}) is read-only. You can use the dashboard, catalogue, reports and activity pages.
          Owners, managers, sales and inventory roles can use the assistant.
        </p>
      </div>
    );
  }

  // Text mode greets with prompts. Audio mode stays quiet until the first
  // turn arrives, then the chat rail glides in.
  const welcomeSection =
    messages.length === 0 && !busy && mode === "text" ? (
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 sm:p-8">
        <h2 className="text-xl font-semibold tracking-tight text-zinc-900">What happened in the shop today?</h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600">
          Say it plainly. ShopTalk prepares the record and waits for your confirmation.
        </p>
        <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {suggestionsFor(context ?? null).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => send(suggestion, "text")}
              className="min-h-11 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 transition-colors hover:border-zinc-400 hover:bg-zinc-50"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </section>
    ) : null;

  const conversationTurns = (
    <>
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.key} className="flex justify-end">
            <p className="max-w-[88%] rounded-2xl rounded-br-md bg-zinc-900 px-4 py-3 text-sm leading-relaxed text-white sm:max-w-[70%]">
              {message.text}
            </p>
          </div>
        ) : (
          <div key={message.key} className="flex items-start gap-2.5">
            <span aria-hidden className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-bold text-white">
              S
            </span>
            <div className="min-w-0 max-w-[92%] rounded-2xl rounded-tl-md border border-zinc-200 bg-white px-4 py-3 text-sm leading-relaxed text-zinc-900 sm:max-w-[78%]">
              <FormattedReply text={message.text} />
              {message.visual ? (
                <VisualBlock visual={message.visual} currency={context?.business?.currency ?? ""} />
              ) : null}
              {message.state && message.state !== "completed" ? (
                <div className="mt-2">
                  <StateBadge state={message.state} />
                </div>
              ) : null}
              {message.action && message.action.state === "awaiting_confirmation" ? (
                <ApprovalCard
                  action={message.action}
                  busy={busy}
                  onDecide={(confirm) => decide(message.action as PendingActionPayload, confirm)}
                />
              ) : null}
              {message.documents ? (
                <DocumentCard
                  documents={message.documents}
                  businessName={context?.business?.name ?? ""}
                  currency={context?.business?.currency ?? ""}
                />
              ) : null}
            </div>
          </div>
        ),
      )}
      {busy ? <TypingRow /> : null}
      <div ref={bottomRef} />
    </>
  );

  const audioPanel = (
    <div className="mx-auto flex w-full max-w-md flex-col items-center justify-center px-4 py-10 text-center lg:min-h-[72dvh]">
      <div className="mx-auto flex h-44 w-44 items-center justify-center">
        <button
          type="button"
          onClick={toggleVoice}
          disabled={!supported}
          aria-label={
            listening ? "Stop listening" : busy ? "Talk (sends after the answer)" : speaking ? "Talk (the assistant is speaking)" : "Start talking"
          }
          title={listening ? "Stop listening" : "Start talking"}
          className={`flex h-28 w-28 items-center justify-center rounded-full shadow-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            listening
              ? "mic-live bg-red-700 text-white"
              : speaking
                ? "bg-green-800 text-white hover:bg-green-700"
                : "bg-zinc-900 text-white hover:bg-zinc-700"
          }`}
        >
          {listening ? (
            <Square aria-hidden className="h-9 w-9" />
          ) : speaking ? (
            <Volume2 aria-hidden className="h-11 w-11" />
          ) : (
            <Mic aria-hidden className="h-11 w-11" />
          )}
        </button>
      </div>
      <p role="status" className="mt-4 text-sm font-medium text-zinc-800">
        {listening
          ? interim ? `Hearing: ${interim}` : "Listening. Tap stop when you are done."
          : busy
            ? "Thinking."
            : speaking
              ? "Speaking. Tap the mic any time to cut in."
              : supported
                ? continuous
                  ? "Tap the mic and talk. The mic stays open until you tap stop, and re-opens after each reply."
                  : "Tap the mic and talk. Your words send automatically."
                : "This browser has no speech recognition. Switch to Text mode to type instead."}
      </p>
      {voiceError ? (
        <p role="alert" className="mx-auto mt-3 max-w-md rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-800">
          {voiceError}
        </p>
      ) : null}
    </div>
  );

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] w-full flex-col">
      <div className="mb-5 sm:mb-7">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900 sm:text-2xl">Assistant</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600">
              <span className="sm:hidden">Talk or type. Nothing is final until you confirm it.</span>
              <span className="hidden sm:inline">
                {mode === "audio"
                  ? "Talk it through. Your words send on their own. Nothing is final until you confirm it."
                  : "Record sales, stock and expenses by voice or text. Nothing is final until you confirm it."}
              </span>
            </p>
          </div>
          {messages.length > 0 && !busy ? (
            <button
              type="button"
              onClick={clearChat}
              title={confirmingClear ? "Tap again to clear the whole chat" : "Clear chat"}
              aria-label={confirmingClear ? "Tap again to confirm clearing the chat" : "Clear chat"}
              aria-live="polite"
              className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full border px-3.5 py-2 text-sm font-semibold transition-colors sm:w-auto ${
                confirmingClear
                  ? "border-red-700 bg-red-700 text-white hover:bg-red-600"
                  : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400 hover:text-zinc-900"
              }`}
            >
              <Trash2 aria-hidden className="h-4 w-4" />
              <span className="hidden sm:inline">{confirmingClear ? "Tap again to confirm" : "Clear chat"}</span>
            </button>
          ) : null}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div role="group" aria-label="Assistant mode" className="grid flex-1 grid-cols-2 rounded-full border border-zinc-200 bg-white p-0.5 sm:flex sm:flex-none">
            {(
              [
                { value: "audio", label: "Audio", Icon: Mic },
                { value: "text", label: "Text", Icon: Keyboard },
              ] as const
            ).map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => switchMode(value)}
                aria-pressed={mode === value}
                className={`flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                  mode === value ? "bg-zinc-900 text-white" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                <Icon aria-hidden className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={toggleTts}
            aria-pressed={ttsOn}
            aria-label={ttsOn ? "Turn spoken replies off" : "Turn spoken replies on"}
            title="Spoken replies"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors ${
              ttsOn
                ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700"
                : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-400 hover:text-zinc-900"
            }`}
          >
            {ttsOn ? <Volume2 aria-hidden className="h-4 w-4" /> : <VolumeX aria-hidden className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={toggleContinuous}
            aria-pressed={continuous}
            aria-label={continuous ? "Turn auto-listen off" : "Turn auto-listen on"}
            title="Auto-listen: the mic re-opens by itself after each reply"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors ${
              continuous
                ? "border-green-800 bg-green-800 text-white hover:bg-green-700"
                : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-400 hover:text-zinc-900"
            }`}
          >
            <Ear aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>

      <ErrorNote error={error} />

      {mode === "audio" ? (
        messages.length === 0 && !busy ? (
          <div>{audioPanel}</div>
        ) : (
          <>
            {/* Audio takes the full screen. On desktop the conversation
                floats bottom-right and collapses; below lg it flows in
                the page above the sticky mic bar. */}
            <section aria-label="Voice control" className="hidden lg:block">
              {audioPanel}
            </section>
            <div
              className={
                chatOpen
                  ? "lg:fixed lg:bottom-6 lg:right-6 lg:z-40 lg:flex lg:max-h-[72dvh] lg:w-[26rem] lg:flex-col lg:overflow-hidden lg:rounded-2xl lg:border lg:border-zinc-200 lg:bg-white lg:shadow-[0_24px_60px_rgba(0,0,0,0.18)]"
                  : "lg:hidden"
              }
            >
              <div className="hidden items-center gap-2 border-b border-zinc-100 px-4 py-2.5 lg:flex">
                <MessagesSquare aria-hidden className="h-4 w-4 text-zinc-600" />
                <p className="flex-1 text-sm font-semibold text-zinc-900">Conversation</p>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">{messages.length}</span>
                <button
                  type="button"
                  onClick={() => setChatOpen(false)}
                  aria-label="Collapse conversation"
                  title="Collapse"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
                >
                  <ChevronDown aria-hidden className="h-4 w-4" />
                </button>
              </div>
              <div ref={chatBodyRef} onScroll={updateStick} className="animate-enter space-y-4 pb-2 sm:space-y-5 lg:overflow-y-auto lg:p-4">
                {conversationTurns}
              </div>
            </div>
            {!chatOpen ? (
              <button
                type="button"
                onClick={() => setChatOpen(true)}
                aria-label="Open conversation"
                className="fixed bottom-6 right-6 z-40 hidden min-h-11 items-center gap-2 rounded-full bg-zinc-900 py-2.5 pl-4 pr-4 text-sm font-semibold text-white shadow-[0_16px_40px_rgba(0,0,0,0.25)] transition-colors hover:bg-zinc-700 lg:flex"
              >
                <MessagesSquare aria-hidden className="h-4 w-4" />
                Conversation
                <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs font-semibold">{messages.length}</span>
              </button>
            ) : null}
            <div className="sticky bottom-16 z-30 -mx-4 mt-2 border-t border-zinc-200 bg-[#f4f4f2]/95 px-4 pb-3 pt-3 backdrop-blur sm:-mx-6 sm:px-6 lg:hidden">
              {voiceError ? (
                <p role="alert" className="mb-2 rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-800 shadow-lg">
                  {voiceError}
                </p>
              ) : null}
              <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-2 pr-4 shadow-[0_16px_40px_rgba(0,0,0,0.10)]">
                <button
                  type="button"
                  onClick={toggleVoice}
                  disabled={!supported}
                  aria-label={
                    listening ? "Stop listening" : busy ? "Talk (sends after the answer)" : speaking ? "Talk (the assistant is speaking)" : "Start talking"
                  }
                  className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white shadow-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    listening
                      ? "mic-live bg-red-700"
                      : speaking
                        ? "bg-green-800"
                        : "bg-zinc-900"
                  }`}
                >
                  {listening ? (
                    <Square aria-hidden className="h-6 w-6" />
                  ) : speaking ? (
                    <Volume2 aria-hidden className="h-7 w-7" />
                  ) : (
                    <Mic aria-hidden className="h-7 w-7" />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <p role="status" className="truncate text-sm font-medium text-zinc-800">
                    {listening
                      ? "Listening. Tap stop when done."
                      : busy
                        ? "Thinking."
                        : speaking
                          ? "Speaking."
                          : supported
                            ? "Tap the mic and talk."
                            : "No speech recognition here."}
                  </p>
                  {listening && interim ? (
                    <p className="mt-0.5 truncate text-xs text-zinc-500">{interim}</p>
                  ) : null}
                </div>
              </div>
            </div>
          </>
        )
      ) : (
        <div className="flex-1 space-y-4 pb-6 sm:space-y-5">
          {welcomeSection}
          {conversationTurns}
        </div>
      )}

      {mode === "text" ? (
      <div className="sticky bottom-16 z-30 -mx-4 mt-4 bg-[#f4f4f2]/95 px-4 pb-3 pt-3 backdrop-blur sm:-mx-6 sm:px-6 sm:pb-5 md:bottom-0 lg:-mx-8 lg:px-8">
        <div className="mx-auto w-full sm:w-[70%]">
        {voiceError ? (
          <p role="alert" className="mb-2 rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-800 shadow-lg">
            {voiceError}
          </p>
        ) : null}
        <form
          className="flex items-end gap-1.5 rounded-2xl border border-zinc-200 bg-white p-2 shadow-[0_16px_40px_rgba(0,0,0,0.10)] focus-within:border-zinc-300 focus-within:ring-4 focus-within:ring-zinc-900/5 sm:gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft, voiceMode ? "voice" : "text");
          }}
        >
          {supported ? (
            <button
              type="button"
              onClick={toggleVoice}
              aria-label={listening ? "Stop listening" : "Start voice input"}
              title={listening ? "Stop listening" : "Voice input"}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors ${
                listening ? "mic-live bg-red-700 text-white" : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"
              }`}
            >
              {listening ? <Square aria-hidden className="h-4 w-4" /> : <Mic aria-hidden className="h-5 w-5" />}
            </button>
          ) : null}
          <label
            className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-zinc-100 text-zinc-800 transition-colors hover:bg-zinc-200"
            title="Attach a PDF or text file, then write the instruction in the message box"
          >
            <Paperclip aria-hidden className="h-5 w-5" />
            <span className="sr-only">Attach a PDF or text file</span>
            <input
              type="file" accept=".pdf,.txt,.md,text/plain,application/pdf" className="hidden"
              onChange={(e) => { setAttachment(e.target.files?.[0] ?? null); e.target.value = ""; }}
            />
          </label>
          <label className="sr-only" htmlFor="assistant-message">Message the assistant</label>
          <textarea
            ref={textareaRef}
            id="assistant-message"
            rows={1}
            className="max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-500 transition-colors focus:border-zinc-300 focus:bg-white focus:outline-none"
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(draft, voiceMode ? "voice" : "text");
              }
            }}
            placeholder={attachment ? "Instruction for this file, e.g. add this stock..." : supported ? "Type or dictate a request..." : "Type a request..."}
            autoFocus
          />
          <button
            type="button"
            onClick={toggleTts}
            aria-pressed={ttsOn}
            aria-label={ttsOn ? "Turn spoken replies off" : "Turn spoken replies on"}
            title="Spoken replies"
            className={`hidden h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors sm:flex ${
              ttsOn ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"
            }`}
          >
            {ttsOn ? <Volume2 aria-hidden className="h-5 w-5" /> : <VolumeX aria-hidden className="h-5 w-5" />}
          </button>
          <button
            type="submit"
            disabled={busy || (!draft.trim() && !attachment)}
            aria-label="Send message"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send aria-hidden className="h-5 w-5" />
          </button>
        </form>
        {attachment ? (
          <div className="mt-2 flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm shadow-lg">
            <FileText aria-hidden className="h-4 w-4 shrink-0 text-zinc-700" />
            <span className="min-w-0 flex-1 truncate text-zinc-900">{attachment.name}</span>
            <span className="hidden text-xs text-zinc-500 sm:inline">Write the instruction above, then Send. Nothing saves without your confirm.</span>
            <button type="button" onClick={() => setAttachment(null)} aria-label="Remove attachment" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-800 hover:bg-zinc-200">
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        {listening || (voiceMode && draft) ? (
          <div
            aria-live="polite"
            className="mt-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm shadow-lg"
          >
            <p className="text-xs font-semibold text-zinc-500">
              {listening ? "Heard so far, keep talking" : "Heard, check it, then Send"}
            </p>
            <p className="mt-1 leading-relaxed text-zinc-900">{draft || "…"}</p>
          </div>
        ) : null}
        {supported ? null : (
          <p className="mt-2 px-1 text-xs text-zinc-600">This browser has no speech recognition. Typed requests take the same path.</p>
        )}
        </div>
      </div>
      ) : null}
    </div>
  );
}

