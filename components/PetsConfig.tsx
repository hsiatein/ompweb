"use client";
import { useRef, useState } from "react";
import { Check, RefreshCw, RotateCcw, Trash2, Upload } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { notifyPetLibraryChanged, usePetLibrary, usePetPreferences } from "@/hooks/usePets";
import { PET_ROWS, type PetInfo, type PetState } from "@/lib/pets";
import { PetSprite } from "./PetSprite";
import { Tooltip } from "./ui/primitives";

export function PetsConfig() {
  const { t } = useI18n();
  const { preferences, update } = usePetPreferences();
  const { pets, loading, error, skipped, refresh } = usePetLibrary();
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PetState>("idle");
  const input = useRef<HTMLInputElement>(null);
  const selected = pets.find((pet) => pet.key === preferences.key);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setImportError(null);
    try {
      const manifest = Array.from(files).find((file) => file.name === "pet.json");
      if (!manifest || files.length !== 2) throw new Error(t("pets.chooseFiles"));
      const image = Array.from(files).find((file) => file !== manifest)!;
      const form = new FormData();
      form.append("manifest", manifest);
      form.append("image", image);
      const response = await fetch("/api/pets", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || t("pets.importFailed"));
      update({ key: result.pet.key, enabled: true });
      notifyPetLibraryChanged();
    } catch (reason) { setImportError(reason instanceof Error ? reason.message : t("pets.importFailed")); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  const remove = async (pet: PetInfo) => {
    if (!window.confirm(t("pets.confirmDelete", { name: pet.displayName }))) return;
    setBusy(true);
    setImportError(null);
    try {
      const response = await fetch(`/api/pets?key=${encodeURIComponent(pet.key)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(t("pets.deleteFailed"));
      if (preferences.key === pet.key) update({ key: "", enabled: false });
      notifyPetLibraryChanged();
    } catch (reason) { setImportError(String((reason as Error).message)); }
    finally { setBusy(false); }
  };
  return (
    <section role="tabpanel" id="settings-panel-pets" aria-labelledby="settings-tab-pets" className="settings-panel-inner pet-settings">
      <header className="pet-settings-header">
        <h2>{t("pets.title")}</h2>
        <div className="pet-settings-actions">
          <Tooltip content={t("pets.refresh")}><button className="shell-toolbar-btn" aria-label={t("pets.refresh")} onClick={refresh} disabled={loading}><RefreshCw size={16} /></button></Tooltip>
          <button className="pet-import-button" onClick={() => input.current?.click()} disabled={busy}><Upload size={16} />{t("pets.import")}</button>
          <input ref={input} type="file" multiple accept=".json,.png,.webp" hidden onChange={(event) => void upload(event.target.files)} />
        </div>
      </header>
      {(error || importError) && <p role="alert" className="pet-error">{importError || t("pets.loadFailed")}</p>}
      {loading && <p role="status">{t("pets.loading")}</p>}
      {!loading && !pets.length && !error && <p>{t("pets.empty")}</p>}
      {skipped > 0 && <p role="status">{t("pets.skipped", { count: skipped })}</p>}
      <div className="pet-library" aria-label={t("pets.title")}>
        {pets.map((pet) => <div key={pet.key} className={`pet-library-item${pet.key === preferences.key ? " selected" : ""}`}>
          <button className="pet-select" onClick={() => update({ key: pet.key, enabled: true })} aria-pressed={pet.key === preferences.key} aria-label={pet.displayName}>
            <PetSprite pet={pet} size={80} animate={false} />
            <span className="pet-name">{pet.displayName}</span>
            <span className="pet-source">{t(pet.source === "codex" ? "pets.local" : "pets.imported")} · v{pet.spriteVersionNumber}</span>
            {pet.key === preferences.key && <Check className="pet-selected-check" size={14} />}
          </button>
          {pet.source === "imported" && <Tooltip content={t("pets.delete")}><button className="pet-delete shell-toolbar-btn" aria-label={`${t("pets.delete")} ${pet.displayName}`} disabled={busy} onClick={() => void remove(pet)}><Trash2 size={14} /></button></Tooltip>}
        </div>)}
      </div>
      <div className="pet-options">
        <label><span>{t("pets.enabled")}</span><input type="checkbox" checked={preferences.enabled} disabled={!selected} onChange={(event) => update({ enabled: event.target.checked })} /></label>
        <label><span>{t("pets.follow")}</span><input type="checkbox" checked={preferences.followPointer} disabled={selected?.spriteVersionNumber !== 2} onChange={(event) => update({ followPointer: event.target.checked })} /></label>
        <label><span>{t("pets.size")} <output>{preferences.size}px</output></span><input aria-label={t("pets.size")} type="range" min={72} max={240} step={8} value={preferences.size} onChange={(event) => update({ size: Number(event.target.value) })} /></label>
        <div className="pet-option-row"><span>{t("pets.position")}</span><Tooltip content={t("pets.reset")}><button className="shell-toolbar-btn" aria-label={t("pets.reset")} onClick={() => update({ x: 0.96, y: 0.65 })}><RotateCcw size={16} /></button></Tooltip></div>
      </div>
      {selected && <div className="pet-preview">
        <label>{t("pets.preview")}<select aria-label={t("pets.preview")} value={preview} onChange={(event) => setPreview(event.target.value as PetState)}>
          {(Object.keys(PET_ROWS) as PetState[]).map((state) => <option key={state} value={state}>{t(`pets.state.${state}`)}</option>)}
        </select></label>
        <PetSprite key={selected.key} pet={selected} size={preferences.size} state={preview} />
      </div>}
    </section>
  );
}
