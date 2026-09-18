"use client";
import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { PET_CELL, PET_ROWS, petFrame, type PetInfo, type PetState } from "@/lib/pets";

export function PetSprite({ pet, state = "idle", size = 128, look, animate = true, onError }: {
  pet: PetInfo; state?: PetState; size?: number; look?: { row: number; column: number } | null;
  animate?: boolean; onError?: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [frame, setFrame] = useState({ state, row: PET_ROWS[state].row, column: 0 });
  useEffect(() => {
    if (reduced || !animate || look) return;
    let raf = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      const next = petFrame(state, now - start);
      setFrame((previous) => previous.state === state && previous.column === next.column ? previous : { ...next, state });
      raf = requestAnimationFrame(tick);
    };
    const visible = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) { start = null; raf = requestAnimationFrame(tick); }
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => { cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", visible); };
  }, [state, look, reduced, animate]);
  const current = reduced || !animate ? { row: PET_ROWS[state].row, column: 0 } : look ?? (frame.state === state ? frame : { row: PET_ROWS[state].row, column: 0 });
  const height = size * PET_CELL.height / PET_CELL.width;
  return (
    <span role="img" aria-label={pet.displayName} data-pet-row={current.row} data-pet-column={current.column}
      style={{ display: "block", position: "relative", overflow: "hidden", width: size, height, flexShrink: 0, pointerEvents: "none" }}>
      {/* An atlas must bypass image resizing to keep exact cell boundaries. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={pet.assetUrl} alt="" aria-hidden="true" draggable={false} onError={onError}
        style={{ position: "absolute", maxWidth: "none", width: size * 8, height: height * (pet.spriteVersionNumber === 2 ? 11 : 9), left: -current.column * size, top: -current.row * height }} />
    </span>
  );
}
