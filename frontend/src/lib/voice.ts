/* Voice input (speech-to-text) and output (text-to-speech). */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api";

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
}

type RecognitionCtor = new () => SpeechRecognitionInstance;

function cleanTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Join two transcript fragments without repeating the overlap. Recognizers
 * re-report growing snapshots of the same phrase ("hello", then "hello I
 * hope"), so a plain append turns one phrase into stacked copies. */
export function joinTranscripts(a: string, b: string): string {
  const left = cleanTranscript(a);
  const right = cleanTranscript(b);
  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;
  if (right.startsWith(left)) return right;
  if (left.startsWith(right)) return left;
  const leftWords = left.split(" ");
  const rightWords = right.split(" ");
  const maxOverlap = Math.min(leftWords.length, rightWords.length);
  for (let k = maxOverlap; k > 0; k -= 1) {
    const tail = leftWords.slice(-k).join(" ").toLowerCase();
    const head = rightWords.slice(0, k).join(" ").toLowerCase();
    if (tail === head) return [...leftWords, ...rightWords.slice(k)].join(" ");
  }
  return `${left} ${right}`;
}

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, RecognitionCtor | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceSupported(): boolean {
  return recognitionCtor() !== null;
}

/** The mic can always be recorded, even where the browser has no working
 * speech service: the recording is transcribed server-side instead. */
export function canRecordAudio(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
  const w = window as unknown as Record<string, unknown>;
  return typeof w.AudioContext === "function" || typeof w.webkitAudioContext === "function";
}

function audioContextCtor(): (new () => AudioContext) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const ctor = w.AudioContext ?? w.webkitAudioContext;
  return typeof ctor === "function" ? (ctor as new () => AudioContext) : null;
}

/** Resample mono PCM down to the 16 kHz the transcription endpoint wants. */
function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += samples[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/** Encode mono float PCM as a 16-bit WAV blob (16 kHz after downsample). */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function isTtsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Prefer a natural English voice; fall back to the browser default. */
function pickVoice(): SpeechSynthesisVoice | null {
  if (!isTtsSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
  const pool = english.length > 0 ? english : voices;
  return (
    pool.find((v) => /natural|neural|premium|enhanced/i.test(v.name)) ??
    pool.find((v) => /google us english|samantha|zira|david|mark|karen|moira|tessa/i.test(v.name)) ??
    pool.find((v) => v.default) ??
    pool[0] ??
    null
  );
}

/** Strip markdown and symbols so replies sound like speech, not markup. */
export function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/₦/g, "naira ")
    .replace(/₵/g, "cedis ")
    .replace(/\$/g, "dollars ")
    .replace(/€/g, "euros ")
    .replace(/£/g, "pounds ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_#>|~]/g, "")
    .replace(/^\s*[-•·]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

let currentUtterance: SpeechSynthesisUtterance | null = null;

export function speak(text: string, onEnd?: () => void) {
  if (!isTtsSupported()) return;
  cancelSpeech();
  const clean = toSpeakable(text);
  if (!clean) {
    onEnd?.();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(clean);
  currentUtterance = utterance;
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 1;
  if (onEnd) {
    utterance.onend = () => {
      if (currentUtterance === utterance) currentUtterance = null;
      onEnd();
    };
    utterance.onerror = () => {
      if (currentUtterance === utterance) currentUtterance = null;
      onEnd();
    };
  }
  window.speechSynthesis.speak(utterance);
}

export function cancelSpeech() {
  if (!isTtsSupported()) return;
  if (currentUtterance) {
    currentUtterance.onend = null;
    currentUtterance.onerror = null;
    currentUtterance = null;
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  if (synth.speaking || synth.pending) {
    synth.pause();
    synth.resume();
    synth.cancel();
  }
}

let braveVerdict: Promise<boolean> | null = null;

/** Brave and some Chromium forks expose speech recognition but ship no
 * speech-service key, so every attempt fails with a `network` error. */
function isBraveLike(): Promise<boolean> {
  if (!braveVerdict) {
    braveVerdict = (async () => {
      try {
        const nav = navigator as unknown as { brave?: { isBrave?: () => unknown } };
        return (await nav.brave?.isBrave?.()) === true;
      } catch {
        return false;
      }
    })();
  }
  return braveVerdict;
}

/** Can this device reach Google at all? The mic streams to Google speech
 * servers, so unreachable Google means a dead mic. An image probe needs
 * no CORS headers, unlike fetch, so the answer is trustworthy. Fully
 * offline, no request is emitted at all: the answer is already known. */
function canReachGoogle(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const img = new Image();
    const timer = window.setTimeout(() => finish(false), 8000);
    function finish(ok: boolean) {
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    }
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = `https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png?probe=${Date.now()}`;
  });
}

/** Pause length that ends a turn; the mic stays open for more talk. */
const TURN_SILENCE_MS = 4000;
/** Dead air that stops the mic quietly, with no error shown. */
const IDLE_STOP_MS = 30000;
/** Mic-energy RMS at or above this counts as voice. */
const VAD_THRESHOLD = 0.02;
/** Auto-restart gap bounds (mobile indicator flicker backoff). */
const RESTART_BASE_MS = 250;
const RESTART_MAX_MS = 2000;

export function useSpeechInput(

  onFinal: (text: string) => void,
  onInterim?: (text: string) => void,
  onSegmentEnd?: (hadSpeech: boolean) => void,
) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [supported, setSupported] = useState(false);
  const recognition = useRef<SpeechRecognitionInstance | null>(null);
  const callback = useRef(onFinal);
  const interimCallback = useRef(onInterim);
  // Transcript survives across auto-restarts while the mic stays open.
  const finalRef = useRef("");
  const interimRef = useRef("");
  // Words banked from earlier auto-ended sessions. A pause ends the
  // browser session, never the user's turn: segments accumulate here so
  // a moment of silence never wipes what was already said.
  const accumRef = useRef("");
  // This session's raw interim fragment (no accumulation): banked into
  // accumRef when the session auto-ends so nothing is counted twice.
  const sessionInterimRef = useRef("");
  // Final transcripts keyed by result index: rebuilt, never appended, so a
  // re-reported final cannot be counted twice.
  const finalsByIndexRef = useRef<Map<number, string>>(new Map());
  const restartTimerRef = useRef<number | null>(null);
  // Backup recording of the same turn, captured as 16 kHz WAV (the
  // format the transcription endpoint requires). The browser speech
  // service can hear speech yet return nothing; if it does, this
  // recording is transcribed server-side instead of losing the words.
  const captureRef = useRef<{
    stream: MediaStream;
    ctx: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
    analyser: AnalyserNode;
    chunks: Float32Array[];
    sampleRate: number;
  } | null>(null);
  const manualStopRef = useRef(false);
  const erroredRef = useRef(false);
  // Voice heard during the current recognition segment (final or live
  // transcript). Lets the page tell silence from speech for auto-listen.
  const heardRef = useRef(false);
  // Set by halt(): the current auto-end must not restart the mic.
  const haltedRef = useRef(false);
  const segmentEndRef = useRef(onSegmentEnd);
  // Live Muse interim: ticks while recording; uploads serialize.
  const interimTimerRef = useRef<number | null>(null);
  const interimBusyRef = useRef(false);
  // Voice-activity clock: last moment real voice was heard (mic energy
  // or browser text). Drives pause-to-send and dead-air stop.
  const lastVoiceAtRef = useRef(0);
  const idleTimerRef = useRef<number | null>(null);
  const autoTurnBusyRef = useRef(false);
  // Auto-restart gap: backs off while sessions die speechless so the
  // mobile mic indicator stops flickering in dead air.
  const restartDelayRef = useRef(RESTART_BASE_MS);

  useEffect(() => {
    interimCallback.current = onInterim;
  }, [onInterim]);

  useEffect(() => {
    segmentEndRef.current = onSegmentEnd;
  }, [onSegmentEnd]);

  useEffect(() => {
    setSupported(isVoiceSupported() || canRecordAudio());
  }, []);

  useEffect(() => {
    callback.current = onFinal;
  }, [onFinal]);

  useEffect(() => {
    return () => {
      if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current);
      if (interimTimerRef.current) window.clearInterval(interimTimerRef.current);
      if (idleTimerRef.current) window.clearInterval(idleTimerRef.current);
      recognition.current?.stop();
      const capture = captureRef.current;
      captureRef.current = null;
      if (capture) {
        try {
          capture.processor.disconnect();
          capture.source.disconnect();
        } catch {
          /* unmounting */
        }
        capture.stream.getTracks().forEach((t) => t.stop());
        void capture.ctx.close().catch(() => undefined);
      }
    };
  }, []);

  const startBackupRecording = useCallback(() => {
    const Ctor = audioContextCtor();
    if (!Ctor || !canRecordAudio() || captureRef.current) return;
    void navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (captureRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const ctx = new Ctor();
        const source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(4096, 1, 1);
    // Voice-activity tap: feeds the watchdog RMS meter, never the speakers.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
        const chunks: Float32Array[] = [];
        processor.onaudioprocess = (event) => {
          chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        };
        // ScriptProcessor only runs while connected; route through a
        // silent gain so the mic never plays back into the speakers.
        const mute = ctx.createGain();
        mute.gain.value = 0;
        source.connect(processor);
        processor.connect(mute);
        mute.connect(ctx.destination);
        captureRef.current = {
          stream, ctx, source, processor, analyser, chunks, sampleRate: ctx.sampleRate,
        };
      })
      .catch(() => undefined);
  }, []);

  /** Stop the backup capture and return it as one 16 kHz WAV blob. */
  const stopBackupRecording = useCallback((): Blob | null => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (!capture) return null;
    try {
      capture.processor.disconnect();
      capture.source.disconnect();
    } catch {
      /* already torn down */
    }
    capture.stream.getTracks().forEach((t) => t.stop());
    void capture.ctx.close().catch(() => undefined);
    const total = capture.chunks.reduce((sum, c) => sum + c.length, 0);
    if (total === 0) return null;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of capture.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return encodeWav(downsample(merged, capture.sampleRate, 16000), 16000);
  }, []);

  /** POST the audio recorded so far and show the running transcript.
   * Interim only: failures stay silent, the final upload on stop decides. */
  const transcribeSnapshot = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture || interimBusyRef.current) return;
    const total = capture.chunks.reduce((sum, c) => sum + c.length, 0);
    if (total < capture.sampleRate * 2) return;
    interimBusyRef.current = true;
    try {
      const merged = new Float32Array(total);
      let offset = 0;
      for (const chunk of capture.chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const blob = encodeWav(downsample(merged, capture.sampleRate, 16000), 16000);
      const form = new FormData();
      form.append("file", blob, "live.wav");
      const data = await api<{ text: string }>("/api/assistant/transcribe", { method: "POST", form, timeoutMs: 60000 });
      const live = cleanTranscript(data.text || "");
      // Browser live text wins when the speech service hears anything.
      if (live && !heardRef.current) {
        setInterim(live);
        interimCallback.current?.(live);
      }
    } catch {
      /* interim is best-effort; the final upload reports real failures */
    } finally {
      interimBusyRef.current = false;
    }
  }, []);

  /** Deliver a finished turn. Browser transcript wins; if the speech
   * service caught nothing, the backup recording is transcribed
   * server-side so the words are not lost. */
  const finishTurn = useCallback(
    async (text: string) => {
      const blob = stopBackupRecording();
      const heard = cleanTranscript(text);
      if (heard) {
        setVoiceError("");
        callback.current(heard);
        return;
      }
      // Silent when there is nothing to transcribe: the mic simply keeps
      // listening, and the user notices nothing.
      if (!blob || blob.size === 0) return;
      setInterim("Transcribing your recording…");
      try {
        const form = new FormData();
        form.append("file", blob, "recording.wav");
        const data = await api<{ text: string }>("/api/assistant/transcribe", { method: "POST", form, timeoutMs: 60000 });
        const transcribed = cleanTranscript(data.text || "");
        setInterim("");
        if (transcribed) {
          setVoiceError("");
          callback.current(transcribed);
        }
      } catch {
        setInterim("");
      }
    },
    [stopBackupRecording],
  );

  const stop = useCallback(() => {
    // Manual stop means "I'm done talking": end this session for good and
    // deliver whatever was heard. Auto-ends below restart instead.
    manualStopRef.current = true;
    if (interimTimerRef.current) {
      window.clearInterval(interimTimerRef.current);
      interimTimerRef.current = null;
    }
    if (idleTimerRef.current) {
      window.clearInterval(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (restartTimerRef.current) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (!recognition.current) {
      // Stopping in the gap between auto-sessions (or in recorder-only
      // mode): deliver what was banked, or transcribe the recording.
      const text = accumRef.current.trim();
      setListening(false);
      void finishTurn(text);
      return;
    }
    recognition.current?.stop();
  }, [finishTurn]);

  /** Snapshot the backup recording WITHOUT stopping it: encodes the audio
   * captured so far as 16 kHz WAV and clears the bank for the next turn.
   * The mic stream stays open, so listening continues seamlessly. */
  const snapshotBackupRecording = useCallback((): Blob | null => {
    const capture = captureRef.current;
    if (!capture || capture.chunks.length === 0) return null;
    const total = capture.chunks.reduce((sum, c) => sum + c.length, 0);
    if (total < capture.sampleRate / 2) return null;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of capture.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    capture.chunks = [];
    return encodeWav(downsample(merged, capture.sampleRate, 16000), 16000);
  }, []);

  /** Deliver one paused turn while the mic stays open. Browser text wins;
   * otherwise the snapshot goes to Vosk. Any failure stays silent: the
   * mic keeps listening and the user notices nothing. */
  const deliverAutoTurn = useCallback(async () => {
    if (autoTurnBusyRef.current || manualStopRef.current || haltedRef.current || erroredRef.current) return;
    const banked = joinTranscripts(accumRef.current, finalRef.current);
    const blob = snapshotBackupRecording();
    if (!banked && !blob) return;
    autoTurnBusyRef.current = true;
    try {
      if (banked) {
        setVoiceError("");
        callback.current(banked);
      } else if (blob) {
        try {
          const form = new FormData();
          form.append("file", blob, "turn.wav");
          const data = await api<{ text: string }>("/api/assistant/transcribe", { method: "POST", form, timeoutMs: 60000 });
          const transcribed = cleanTranscript(data.text || "");
          if (transcribed) {
            setVoiceError("");
            callback.current(transcribed);
          }
        } catch {
          /* Vosk unreachable: stay silent, keep listening */
        }
      }
    } finally {
      accumRef.current = "";
      finalRef.current = "";
      sessionInterimRef.current = "";
      finalsByIndexRef.current.clear();
      heardRef.current = false;
      setInterim("");
      autoTurnBusyRef.current = false;
    }
  }, [snapshotBackupRecording]);

  /** One-second watchdog. Voice (mic energy or browser text) resets the
   * clock. A few quiet seconds with banked words ends the turn but the
   * mic stays open for more talk; long dead air stops silently. The chat
   * keeps every delivered turn, so nothing said is ever lost. */
  const watchdog = useCallback(() => {
    if (manualStopRef.current || erroredRef.current || haltedRef.current) return;
    if (!captureRef.current && !recognition.current) return;
    const now = Date.now();
    let voice = false;
    try {
      const analyser = captureRef.current?.analyser;
      if (analyser) {
        const buf = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
        voice = Math.sqrt(sum / buf.length) >= VAD_THRESHOLD;
      }
    } catch {
      voice = false;
    }
    if (voice) {
      lastVoiceAtRef.current = now;
      restartDelayRef.current = RESTART_BASE_MS;
      return;
    }
    const banked = accumRef.current.trim() || finalRef.current.trim();
    if (banked && now - lastVoiceAtRef.current >= TURN_SILENCE_MS) {
      void deliverAutoTurn();
      return;
    }
    if (!banked && now - lastVoiceAtRef.current >= IDLE_STOP_MS) {
      // Dead air: drop the empty bank and stop quietly. No error: the
      // user simply stopped talking.
      if (captureRef.current) captureRef.current.chunks = [];
      stop();
    }
  }, [deliverAutoTurn, stop]);

  // Runs when recognition reports a `network` failure: checks the browser
  // first, then whether Google is reachable at all, and says which one it is.
  const diagnoseNetworkError = useCallback(() => {
    setVoiceError("Mic blocked by the network. Checking what is in the way…");
    void (async () => {
      if (await isBraveLike()) {
        setVoiceError("This browser cannot do voice input. Open ShopTalk in Chrome or Edge and tap the mic there. Typing works the same way.");
        return;
      }
      if (!(await canReachGoogle())) {
        setVoiceError("Your network cannot reach Google services, which the mic needs. Turn off VPN, ad-blocker, or data-saver, then tap the mic again. Typing works the same way.");
        return;
      }
      setVoiceError("The mic service hiccuped. Tap the mic and try once more. Typing works the same way.");
    })();
  }, []);

  const launch = useCallback(function restart() {
    // One live recognizer only. A second instance hearing the same speech
    // interleaves duplicate fragments into one transcript.
    if (recognition.current) return;
    if (restartTimerRef.current) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const instance = new Ctor();
    instance.lang = "en-US";
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    // Keep recording across pauses: when the browser auto-ends a quiet
    // session we start a fresh one, until the user taps stop.
    instance.continuous = true;
    instance.onresult = (event: SpeechRecognitionEvent) => {
      if (recognition.current !== instance) return;
      // Rebuild from the full result list every event. Finals are stored
      // per result index, and only the latest interim counts: Android
      // Chrome re-reports growing snapshots of one phrase, so appending
      // every report stacks copies ("hello hello hello I hope...").
      let latestInterim = "";
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = cleanTranscript(result[0].transcript);
        if (!transcript) continue;
        if (result.isFinal) finalsByIndexRef.current.set(i, transcript);
        else latestInterim = transcript;
      }
      finalRef.current = [...finalsByIndexRef.current.entries()]
        .sort((a, b) => a[0] - b[0])
        .reduce((all, [, text]) => joinTranscripts(all, text), "");
      sessionInterimRef.current = latestInterim;
      const sessionLive = joinTranscripts(finalRef.current, latestInterim);
      const live = joinTranscripts(accumRef.current, sessionLive);
      interimRef.current = live;
      setInterim(live);
      if (live) {
        heardRef.current = true;
        lastVoiceAtRef.current = Date.now();
        restartDelayRef.current = RESTART_BASE_MS;
        interimCallback.current?.(live);
      }
    };
    instance.onend = () => {
      if (recognition.current !== instance) return;
      recognition.current = null;
      if (manualStopRef.current) {
        setListening(false);
        // Done talking: banked segments plus this session's tail go
        // through once, so a pause mid-sentence never costs words.
        const tail = joinTranscripts(finalRef.current, sessionInterimRef.current);
        const text = joinTranscripts(accumRef.current, tail);
        finalsByIndexRef.current.clear();
        // Browser transcript if there is one; otherwise the backup
        // recording is transcribed server-side inside finishTurn.
        void finishTurn(text);
        return;
      }
      // Auto-end (pause, hiccup): bank only confirmed finals, keep the mic
      // open. Banking the interim too would count it again when the next
      // session re-reports the same phrase.
      if (finalRef.current) accumRef.current = joinTranscripts(accumRef.current, finalRef.current);
      finalRef.current = "";
      sessionInterimRef.current = "";
      finalsByIndexRef.current.clear();
      setInterim(accumRef.current);
      const hadSpeech = heardRef.current;
      heardRef.current = false;
      try {
        segmentEndRef.current?.(hadSpeech);
      } catch {
        /* a listener hiccup must never break the mic loop */
      }
      if (!erroredRef.current && !haltedRef.current) {
        // Brief pause before restarting: instant restarts on Android
        // Chrome overlap the dying session and duplicate speech. The gap
        // backs off while sessions die speechless so the mobile mic
        // indicator stops flickering in dead air; voice resets it.
        restartTimerRef.current = window.setTimeout(() => {
          restartTimerRef.current = null;
          if (!manualStopRef.current && !erroredRef.current && !haltedRef.current) restart();
        }, restartDelayRef.current);
        restartDelayRef.current = Math.min(restartDelayRef.current * 2, RESTART_MAX_MS);
      } else setListening(false);
    };
    instance.onerror = (event: { error?: string }) => {
      if (recognition.current !== instance) return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        erroredRef.current = true;
        setVoiceError("Microphone blocked. Allow mic access in the browser, then try again.");
        manualStopRef.current = true;
      } else if (event.error === "no-speech") {
        // Silence, not failure: the browser ends this session and the
        // auto-restart in onend opens a fresh one. Do not stop here, or
        // the restart races the still-closing session.
        return;
      } else if (event.error && event.error !== "aborted") {
        erroredRef.current = true;
        manualStopRef.current = true;
        // "network" means the browser could not reach its own cloud speech
        // servers. Nothing to do with the ShopTalk backend. Run the
        // diagnosis so the message names the actual cause.
        if (event.error === "network" && typeof navigator !== "undefined" && !navigator.onLine) {
          setVoiceError("You are offline, so the mic cannot hear you. Reconnect, then try again. Typing works the same way.");
        } else if (event.error === "network" && captureRef.current) {
          // The backup recording saves this turn: it is transcribed
          // server-side when the session ends just below.
          setVoiceError("Browser speech service failed. Transcribing your recording instead…");
        } else if (event.error === "network") {
          void diagnoseNetworkError();
        } else {
          setVoiceError(`Voice input failed (${event.error}). Typing works the same way.`);
        }
      }
      try {
        instance.stop();
      } catch {
        /* already closing */
      }
    };
    recognition.current = instance;
    try {
      instance.start();
    } catch {
      // start() throws if called twice in a row; the live session continues.
    }
    setListening(true);
  }, [diagnoseNetworkError, finishTurn]);

  const start = useCallback(() => {
    // Speech recognition or plain recording: at least one must exist.
    if (!recognitionCtor() && !canRecordAudio()) return;
    // Already listening (or restarting): a fresh start here would orphan
    // the live recognizer and wipe the transcript it is building.
    if (recognition.current || restartTimerRef.current || captureRef.current) return;
    setVoiceError("");
    cancelSpeech();
    finalRef.current = "";
    interimRef.current = "";
    accumRef.current = "";
    sessionInterimRef.current = "";
    finalsByIndexRef.current.clear();
    manualStopRef.current = false;
    erroredRef.current = false;
    heardRef.current = false;
    haltedRef.current = false;
    setInterim("");
    // Record from the first moment: if the speech service returns
    // nothing, this recording is the only copy of the user's words.
    startBackupRecording();
    // Live interim: transcribe the audio so far every few seconds so
    // words appear while talking; the upload on stop stays final.
    if (interimTimerRef.current) window.clearInterval(interimTimerRef.current);
    interimTimerRef.current = window.setInterval(() => {
      void transcribeSnapshot();
    }, 4000);
    // Watchdog: a pause ends the turn (browser text or Vosk delivers
    // it), long dead air stops silently. The chat keeps everything.
    lastVoiceAtRef.current = Date.now();
    restartDelayRef.current = RESTART_BASE_MS;
    if (idleTimerRef.current) window.clearInterval(idleTimerRef.current);
    idleTimerRef.current = window.setInterval(() => {
      watchdog();
    }, 1000);
    launch();
    if (!recognitionCtor()) setListening(true);
  }, [launch, startBackupRecording, transcribeSnapshot, watchdog]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  // Stop the mic and keep it stopped: the next auto-end will not restart.
  // The next manual start clears the halt.
  const halt = useCallback(() => {
    haltedRef.current = true;
    if (interimTimerRef.current) {
      window.clearInterval(interimTimerRef.current);
      interimTimerRef.current = null;
    }
    if (idleTimerRef.current) {
      window.clearInterval(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (restartTimerRef.current) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    // Halted turns are abandoned: drop the backup recording too.
    void stopBackupRecording();
    if (recognition.current) recognition.current.stop();
    else setListening(false);
  }, [stopBackupRecording]);

  return { listening, interim, supported, toggle, start, stop, halt, voiceError };
}
