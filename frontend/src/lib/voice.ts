/* Voice input (speech-to-text) and output (text-to-speech). */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
}

type RecognitionCtor = new () => SpeechRecognitionInstance;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, RecognitionCtor | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceSupported(): boolean {
  return recognitionCtor() !== null;
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
  const utterance = new SpeechSynthesisUtterance(toSpeakable(text));
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
  const manualStopRef = useRef(false);
  const erroredRef = useRef(false);
  // Voice heard during the current recognition segment (final or live
  // transcript). Lets the page tell silence from speech for auto-listen.
  const heardRef = useRef(false);
  // Set by halt(): the current auto-end must not restart the mic.
  const haltedRef = useRef(false);
  const segmentEndRef = useRef(onSegmentEnd);

  useEffect(() => {
    interimCallback.current = onInterim;
  }, [onInterim]);

  useEffect(() => {
    segmentEndRef.current = onSegmentEnd;
  }, [onSegmentEnd]);

  useEffect(() => {
    setSupported(isVoiceSupported());
  }, []);

  useEffect(() => {
    callback.current = onFinal;
  }, [onFinal]);

  useEffect(() => {
    return () => recognition.current?.stop();
  }, []);

  const stop = useCallback(() => {
    // Manual stop means "I'm done talking": end this session for good and
    // deliver whatever was heard. Auto-ends below restart instead.
    manualStopRef.current = true;
    if (!recognition.current) {
      // Stopping in the gap between auto-sessions: deliver what was
      // banked so far instead of dropping it.
      const text = accumRef.current.trim();
      setListening(false);
      if (text) callback.current(text);
      return;
    }
    recognition.current?.stop();
  }, []);

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
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const instance = new Ctor();
    instance.lang = "en-US";
    instance.interimResults = true;
    // Keep recording across pauses: when the browser auto-ends a quiet
    // session we start a fresh one, until the user taps stop.
    instance.continuous = true;
    instance.onresult = (event: SpeechRecognitionEvent) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) finalRef.current += transcript;
        else interimText += transcript;
      }
      sessionInterimRef.current = interimText;
      // Full live transcript: banked segments plus this session's confirmed
      // finals plus the in-progress fragment, so the screen always shows
      // everything said so far and the composer appends after existing text.
      const sessionLive = `${finalRef.current} ${interimText}`.trim();
      const live = accumRef.current ? `${accumRef.current} ${sessionLive}`.trim() : sessionLive;
      interimRef.current = live;
      setInterim(live);
      if (live) {
        heardRef.current = true;
        interimCallback.current?.(live);
      }
    };
    instance.onend = () => {
      recognition.current = null;
      if (manualStopRef.current) {
        setListening(false);
        // Done talking: banked segments plus this session's tail go
        // through once, so a pause mid-sentence never costs words.
        const tail = `${finalRef.current} ${sessionInterimRef.current}`.trim();
        const text = accumRef.current ? `${accumRef.current} ${tail}`.trim() : tail;
        if (text) {
          callback.current(text);
        } else if (!erroredRef.current) {
          setVoiceError("Didn't catch that. Tap the mic and speak, or type instead.");
        }
        return;
      }
      // Auto-end (pause, hiccup): bank this segment, keep the mic open,
      // and keep showing everything heard so far while the user talks.
      const seg = `${finalRef.current} ${sessionInterimRef.current}`.trim();
      if (seg) accumRef.current = accumRef.current ? `${accumRef.current} ${seg}` : seg;
      finalRef.current = "";
      sessionInterimRef.current = "";
      setInterim(accumRef.current);
      const hadSpeech = heardRef.current;
      heardRef.current = false;
      try {
        segmentEndRef.current?.(hadSpeech);
      } catch {
        /* a listener hiccup must never break the mic loop */
      }
      if (!erroredRef.current && !haltedRef.current) restart();
      else setListening(false);
    };
    instance.onerror = (event: { error?: string }) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        erroredRef.current = true;
        setVoiceError("Microphone blocked. Allow mic access in the browser, then try again.");
        manualStopRef.current = true;
      } else if (event.error === "no-speech") {
        // Silence, not failure: stay open and keep waiting for speech.
        return;
      } else if (event.error && event.error !== "aborted") {
        erroredRef.current = true;
        manualStopRef.current = true;
        // "network" means the browser could not reach its own cloud speech
        // servers. Nothing to do with the ShopTalk backend. Run the
        // diagnosis so the message names the actual cause.
        if (event.error === "network" && typeof navigator !== "undefined" && !navigator.onLine) {
          setVoiceError("You are offline, so the mic cannot hear you. Reconnect, then try again. Typing works the same way.");
        } else if (event.error === "network") {
          void diagnoseNetworkError();
        } else {
          setVoiceError(`Voice input failed (${event.error}). Typing works the same way.`);
        }
      }
      recognition.current?.stop();
    };
    recognition.current = instance;
    try {
      instance.start();
    } catch {
      // start() throws if called twice in a row; the live session continues.
    }
    setListening(true);
  }, [diagnoseNetworkError]);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    setVoiceError("");
    cancelSpeech();
    finalRef.current = "";
    interimRef.current = "";
    accumRef.current = "";
    sessionInterimRef.current = "";
    manualStopRef.current = false;
    erroredRef.current = false;
    heardRef.current = false;
    haltedRef.current = false;
    setInterim("");
    launch();
  }, [launch]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  // Stop the mic and keep it stopped: the next auto-end will not restart.
  // The next manual start clears the halt.
  const halt = useCallback(() => {
    haltedRef.current = true;
    recognition.current?.stop();
  }, []);

  return { listening, interim, supported, toggle, start, stop, halt, voiceError };
}
