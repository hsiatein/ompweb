"use client";

import { useState, useRef, useCallback, useEffect } from "react";

/** Completion: two rising notes. */
const DONE_NOTES = [523.25, 659.25];
/** Something needs you (dialog, sudo, agent notification): three quicker, higher notes. */
const ATTENTION_NOTES = [783.99, 987.77, 1174.66];

function playTone(ctx: AudioContext, freqs: number[] = DONE_NOTES, spacing = 0.18) {
  const now = ctx.currentTime;
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = now + i * spacing;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.start(t);
    osc.stop(t + 0.45);
    // Connected WebAudio nodes are not garbage-collected; detach them once the
    // tone finishes so each completion sound does not leak 4 graph nodes.
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  });
}

// One AudioContext per browser tab, shared by every hook instance. ChatWindow
// is keyed per session, so a per-hook context would be re-created on every
// session switch and Chrome caps live contexts (~6) — after which
// new AudioContext() throws and the completion sound dies permanently.
let sharedCtx: AudioContext | null = null;
function getSharedCtx(): AudioContext | null {
  if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
  try {
    sharedCtx = new AudioContext();
  } catch {
    return null;
  }
  return sharedCtx;
}

function soundPreferenceEnabled(): boolean {
  try {
    return localStorage.getItem("omp-sound-enabled") !== "false";
  } catch {
    return true;
  }
}

/**
 * Chime for things that need the user (new dialogs, sudo prompts, agent notifications).
 * Callable outside React; follows the same sound preference as the completion tone. Browsers
 * only play it once the page has had a user gesture (ChatInput unlocks the shared context).
 */
export function playAttentionSound(): void {
  if (typeof window === "undefined" || !soundPreferenceEnabled()) return;
  const ctx = getSharedCtx();
  if (!ctx) return;
  const play = () => {
    try {
      playTone(ctx, ATTENTION_NOTES, 0.12);
    } catch {
      // AudioContext not available
    }
  };
  if (ctx.state === "suspended") ctx.resume().then(play).catch(() => {});
  else play();
}

export function useAudio() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("omp-sound-enabled");
    return stored === null ? true : stored === "true";
  });

  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // The settings dialog toggles the same preference; keep the live state in
  // sync when it changes there.
  useEffect(() => {
    const onPrefChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      if (typeof detail !== "boolean") return;
      enabledRef.current = detail;
      setEnabled(detail);
    };
    window.addEventListener("omp-sound-pref-change", onPrefChange);
    return () => window.removeEventListener("omp-sound-pref-change", onPrefChange);
  }, []);

  const unlockAudio = useCallback((force = false) => {
    if (!force && !enabledRef.current) return;
    const ctx = getSharedCtx();
    if (!ctx || ctx.state !== "suspended") return;
    ctx.resume().catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    const next = !enabledRef.current;
    if (next) unlockAudio(true);
    try {
      localStorage.setItem("omp-sound-enabled", String(next));
    } catch {
      // Storage may be unavailable (private mode, quota); the in-memory
      // preference still applies for this session.
    }
    setEnabled(next);
  }, [unlockAudio]);

  const playDone = useCallback(() => {
    if (!enabledRef.current) return;
    const ctx = getSharedCtx();
    if (!ctx) return;
    const play = () => {
      try {
        playTone(ctx);
      } catch {
        // AudioContext not available
      }
    };
    if (ctx.state === "suspended") {
      ctx.resume().then(play).catch(() => {});
      return;
    }
    play();
  }, []);

  return { soundEnabled: enabled, onSoundToggle: toggle, playDoneSound: playDone, unlockAudio, soundEnabledRef: enabledRef };
}
