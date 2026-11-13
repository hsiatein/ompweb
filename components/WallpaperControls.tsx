"use client";
import { PanelsTopLeft, Square, Blend, Play, Pause, Volume2, VolumeX, AudioLines } from "lucide-react";
import { useSyncExternalStore } from "react";
import { serverWallpaperAudioState, subscribeWallpaperAudio, wallpaperAudioState, toggleWallpaperAudioCapture } from "@/lib/wallpaper-audio";
import { toast } from "./ui/toast";
import { useWallpaperPreferences } from "@/hooks/useWallpaper";
import { useI18n } from "@/lib/i18n";
import { Tooltip } from "./ui/primitives";
export function WallpaperControls() {
  const { preferences, update } = useWallpaperPreferences();
  const { t } = useI18n();
  const audio = useSyncExternalStore(subscribeWallpaperAudio, wallpaperAudioState, serverWallpaperAudioState);
  const hasAudio = preferences.kind !== "image" || !!preferences.bgmId;
  return <div className="wallpaper-controls" role="group" aria-label={t("wallpaper.wallpaperAndGlass")}>
    {([
      ["default", PanelsTopLeft, t("wallpaper.defaultLocalGlass")],
      ["clear", Square, t("wallpaper.clearGlass")],
      ["frosted", Blend, t("wallpaper.frostedGlass")],
    ] as const).map(([mode, Icon, title]) => <Tooltip key={mode} content={title}><button type="button" aria-label={title} aria-pressed={preferences.glass === mode} disabled={!preferences.id} onClick={() => update({ glass: mode })}><Icon size={15} /></button></Tooltip>)}
    {preferences.id && hasAudio && <Tooltip content={preferences.paused ? t("wallpaper.playWallpaper") : t("wallpaper.pauseWallpaper")}><button type="button" aria-label={preferences.paused ? t("wallpaper.playWallpaper") : t("wallpaper.pauseWallpaper")} onClick={() => update({ paused: !preferences.paused })}>{preferences.paused ? <Play size={15} /> : <Pause size={15} />}</button></Tooltip>}
    {preferences.id && hasAudio && <>
      <Tooltip content={audio.error || (audio.blocked ? t("wallpaper.clickToEnableWallpaperAudio") : preferences.muted ? t("wallpaper.unmute") : t("wallpaper.muteWallpaper"))}><button type="button" aria-label={preferences.muted ? t("wallpaper.unmute") : t("wallpaper.muteWallpaper")} aria-pressed={preferences.muted} onClick={() => { if (!audio.blocked) update({ muted: !preferences.muted }); }}>{preferences.muted || preferences.volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}</button></Tooltip>
      <input className="wallpaper-volume" type="range" min="0" max="100" aria-label={t("wallpaper.wallpaperVolume")} title={`${preferences.volume}%`} value={preferences.volume} onChange={e => update({ volume: Number(e.target.value), muted: false })} />
      {preferences.kind === "scene" && <Tooltip content={audio.capturing ? t("wallpaper.stopSystemAudioResponse") : t("wallpaper.shareSystemAudioForEffects")}><button type="button" aria-label={t("wallpaper.systemAudioResponse")} aria-pressed={audio.capturing} onClick={() => void toggleWallpaperAudioCapture().catch(e => toast.error(e.message))}><AudioLines size={15} /></button></Tooltip>}
    </>}
  </div>;
}
