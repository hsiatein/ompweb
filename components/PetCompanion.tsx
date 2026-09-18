"use client";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Settings2, Sparkles, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { usePetLibrary, usePetPreferences } from "@/hooks/usePets";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { petLookFrame, type PetActivity, type PetInfo, type PetState } from "@/lib/pets";
import { PetSprite } from "./PetSprite";
import { Tooltip } from "./ui/primitives";

export function PetCompanion({ activity, onSettings }: { activity: PetActivity; onSettings: () => void }) {
  const { preferences } = usePetPreferences();
  return preferences.enabled ? <PetLibraryCompanion activity={activity} onSettings={onSettings} /> : null;
}

function PetLibraryCompanion({ activity, onSettings }: { activity: PetActivity; onSettings: () => void }) {
  const { preferences, update } = usePetPreferences();
  const { pets, loading, error } = usePetLibrary();
  const { t } = useI18n();
  const pet = pets.find((item) => item.key === preferences.key);
  if (loading) return null;
  if (!pet || error) return createPortal(<div className="pet-unavailable" role="status">
    <button onClick={onSettings}>{t("pets.unavailable")}</button>
    <button aria-label={t("pets.hide")} onClick={() => update({ enabled: false })}><X size={14} /></button>
  </div>, document.body);
  return <FloatingPet key={pet.key} pet={pet} activity={activity} onSettings={onSettings} />;
}

function FloatingPet({ pet, activity, onSettings }: { pet: PetInfo; activity: PetActivity; onSettings: () => void }) {
  const { preferences, update } = usePetPreferences();
  const { t } = useI18n();
  const reduced = usePrefersReducedMotion();
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [dragState, setDragState] = useState<PetState | null>(null);
  const [greeting, setGreeting] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [look, setLook] = useState<{ row: number; column: number } | null>(null);
  const drag = useRef<{ id: number; dx: number; dy: number; x: number; moved: boolean } | null>(null);
  const positionRef = useRef(position);
  const node = useRef<HTMLDivElement>(null);
  const size = Math.min(preferences.size, Math.max(72, viewport.width - 24));
  const height = size * 208 / 192 + 30;
  const rangeX = Math.max(0, viewport.width - size - 24);
  const rangeY = Math.max(0, viewport.height - height - 24);
  const point = position ?? { x: 12 + preferences.x * rangeX, y: 12 + preferences.y * rangeY };
  const x = Math.max(12, Math.min(12 + rangeX, point.x));
  const y = Math.max(12, Math.min(12 + rangeY, point.y));
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (!greeting) return;
    const timer = setTimeout(() => setGreeting(false), 1300);
    return () => clearTimeout(timer);
  }, [greeting]);
  const state = dragState ?? (greeting ? "waving" : activity.state);
  useEffect(() => {
    if (reduced || !preferences.followPointer || pet.spriteVersionNumber !== 2 || state !== "idle") return;
    let timer: number | undefined;
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || !node.current) return;
      const bounds = node.current.getBoundingClientRect();
      const next = petLookFrame(event.clientX - bounds.left - bounds.width / 2, event.clientY - bounds.top - size * 0.4);
      setLook((old) => old?.row === next?.row && old?.column === next?.column ? old : next);
      clearTimeout(timer);
      timer = window.setTimeout(() => setLook(null), 1600);
    };
    const leave = () => setLook(null);
    window.addEventListener("pointermove", move);
    document.addEventListener("pointerleave", leave);
    return () => { clearTimeout(timer); window.removeEventListener("pointermove", move); document.removeEventListener("pointerleave", leave); };
  }, [pet.spriteVersionNumber, preferences.followPointer, reduced, state, size]);

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const final = positionRef.current;
    if (final) update({ x: rangeX ? (final.x - 12) / rangeX : 0, y: rangeY ? (final.y - 12) / rangeY : 0 });
    if (!current.moved && event.type !== "pointercancel") setGreeting(true);
    drag.current = null;
    positionRef.current = null;
    setPosition(null);
    setDragState(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return createPortal(<div ref={node} className="pet-companion" data-testid="pet-companion" data-pet-state={state} style={{ left: x, top: y, width: size, height }}>
    <button className="pet-body" aria-label={t("pets.move", { name: pet.displayName })}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = { id: event.pointerId, dx: event.clientX - x, dy: event.clientY - y, x: event.clientX, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        const next = { x: Math.max(12, Math.min(12 + rangeX, event.clientX - current.dx)), y: Math.max(12, Math.min(12 + rangeY, event.clientY - current.dy)) };
        if (Math.abs(next.x - x) + Math.abs(next.y - y) > 2) current.moved = true;
        if (current.moved) {
          setDragState(event.clientX >= current.x ? "running-right" : "running-left");
          positionRef.current = next;
          setPosition(next);
          current.x = event.clientX;
        }
      }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onKeyDown={(event) => {
        const delta: Record<string, [number, number]> = { ArrowLeft: [-0.04, 0], ArrowRight: [0.04, 0], ArrowUp: [0, -0.04], ArrowDown: [0, 0.04] };
        const move = delta[event.key];
        if (move) { event.preventDefault(); update({ x: preferences.x + move[0], y: preferences.y + move[1] }); }
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setGreeting(true); }
      }}>
      {imageError ? <span role="alert">{t("pets.imageFailed")}</span> : <PetSprite pet={pet} state={state} size={size} look={state === "idle" && preferences.followPointer ? look : null} onError={() => setImageError(true)} />}
    </button>
    <div className="pet-controls" role="group" aria-label={pet.displayName}>
      <Tooltip content={t(`pets.state.${activity.state}`)}><button aria-label={t("pets.greet")} onClick={() => setGreeting(true)}><Sparkles size={14} /></button></Tooltip>
      <Tooltip content={t("pets.settings")}><button aria-label={t("pets.settings")} onClick={onSettings}><Settings2 size={14} /></button></Tooltip>
      <Tooltip content={t("pets.hide")}><button aria-label={t("pets.hide")} onClick={() => update({ enabled: false })}><X size={14} /></button></Tooltip>
    </div>
  </div>, document.body);
}
