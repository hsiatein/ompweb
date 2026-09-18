"use client";
import { Image as ImageIcon, PanelsTopLeft, Square, Blend, Play, Pause, Volume2, VolumeX, AudioLines } from "lucide-react";
import { useSyncExternalStore } from "react";
import { serverWallpaperAudioState, subscribeWallpaperAudio, wallpaperAudioState, toggleWallpaperAudioCapture } from "@/lib/wallpaper-audio";
import { toast } from "./ui/toast";
import { useWallpaperPreferences } from "@/hooks/useWallpaper";
import { useI18n } from "@/lib/i18n";
import { Tooltip } from "./ui/primitives";
export function WallpaperControls({ onOpen }: { onOpen?: () => void }) {
  const { preferences, update } = useWallpaperPreferences();
  const { locale } = useI18n();
  const zh = locale.startsWith("zh");
  const audio = useSyncExternalStore(subscribeWallpaperAudio, wallpaperAudioState, serverWallpaperAudioState);
  return <div className="wallpaper-controls" role="group" aria-label={zh ? "壁纸与玻璃" : "Wallpaper and glass"}>
    {onOpen && <Tooltip content={zh ? "壁纸" : "Wallpapers"}><button type="button" aria-label={zh ? "壁纸" : "Wallpapers"} onClick={onOpen}><ImageIcon size={16} /></button></Tooltip>}
    {([
      ["default", PanelsTopLeft, zh ? "默认：局部毛玻璃" : "Default: local glass"],
      ["clear", Square, zh ? "全透明玻璃" : "Clear glass"],
      ["frosted", Blend, zh ? "全毛玻璃" : "Frosted glass"],
    ] as const).map(([mode, Icon, title]) => <Tooltip key={mode} content={title}><button type="button" aria-label={title} aria-pressed={preferences.glass === mode} disabled={!preferences.id} onClick={() => update({ glass: mode })}><Icon size={15} /></button></Tooltip>)}
    {preferences.id && preferences.kind !== "image" && <Tooltip content={preferences.paused ? (zh ? "播放壁纸" : "Play wallpaper") : (zh ? "暂停壁纸" : "Pause wallpaper")}><button type="button" aria-label={preferences.paused ? (zh ? "播放壁纸" : "Play wallpaper") : (zh ? "暂停壁纸" : "Pause wallpaper")} onClick={() => update({ paused: !preferences.paused })}>{preferences.paused ? <Play size={15} /> : <Pause size={15} />}</button></Tooltip>}
    {preferences.id && preferences.kind !== "image" && <>
      <Tooltip content={audio.error || (audio.blocked ? (zh ? "点击启用壁纸声音" : "Click to enable wallpaper audio") : preferences.muted ? (zh ? "取消静音" : "Unmute") : (zh ? "壁纸静音" : "Mute wallpaper"))}><button type="button" aria-label={preferences.muted ? (zh ? "取消静音" : "Unmute") : (zh ? "壁纸静音" : "Mute wallpaper")} aria-pressed={preferences.muted} onClick={() => { if (!audio.blocked) update({ muted: !preferences.muted }); }}>{preferences.muted || preferences.volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}</button></Tooltip>
      <input className="wallpaper-volume" type="range" min="0" max="100" aria-label={zh ? "壁纸音量" : "Wallpaper volume"} title={`${preferences.volume}%`} value={preferences.volume} onChange={e => update({ volume: Number(e.target.value), muted: false })} />
      {preferences.kind === "scene" && <Tooltip content={audio.capturing ? (zh ? "停止系统音频响应" : "Stop system audio response") : (zh ? "授权系统音频响应" : "Share system audio for effects")}><button type="button" aria-label={zh ? "系统音频响应" : "System audio response"} aria-pressed={audio.capturing} onClick={() => void toggleWallpaperAudioCapture().catch(e => toast.error(e.message))}><AudioLines size={15} /></button></Tooltip>}
    </>}
  </div>;
}
