import { createHash } from "node:crypto";
import { ScenePropertyScripts, type ScriptLayerState } from "./wallpaper-property-scripts";
import type { BrowserScene, SceneForm, SceneLayer } from "./wallpaper-scene-types";

function click(runner: ScenePropertyScripts, control: SceneLayer) {
  const cursor = control.origin as [number, number, number];
  return runner.update(0, 0, [], 0, { cursor, events: (["cursorDown", "cursorUp", "cursorClick"] as const).map(type => ({
    type, ids: [control.id], cursor,
    local: { [control.id]: [control.size[0] / 2, control.size[1] / 2, 0] },
  })) });
}

/** Inspect authored click transitions in the same bounded VM used for playback. */
export async function discoverSceneForms(scene: BrowserScene): Promise<SceneForm[]> {
  const images = scene.layers.filter(layer => !layer.text && !layer.composition);
  const controls = scene.layers.filter(layer => [...(layer.scripts || []), ...layer.passes.flatMap(pass => pass.scripts || [])]
    .some(script => /export\s+function\s+cursor(?:Click|Down|Up)\b/.test(script.source))).slice(0, 32);
  const signature = (visibility: Map<number, boolean>) => images.map(layer => `${layer.id}:${visibility.get(layer.id) ? 1 : 0}`).join(",");
  const capture = (layers: ScriptLayerState[]) => new Map(layers.map(layer => [layer.id, layer.visible]));
  const baseline = new Map(scene.layers.map(layer => [layer.id, layer.visible !== false]));
  const states = new Map<string, { visibility: Map<number, boolean>; label: string }>();
  const changed = new Set<number>();
  const switchingControls = new Set<number>();
  let initialized = false;
  const warn = (error: unknown) => {
    scene.warnings ??= [];
    const detail = error instanceof Error ? error.message.slice(0, 240) : "Unknown script error";
    const warning = `Wallpaper form inspection: ${detail}. Original interaction remains available`;
    if (!scene.warnings.includes(warning)) scene.warnings.push(warning);
  };
  for (const control of controls) {
    let runner: ScenePropertyScripts | undefined;
    try {
      // Fixed time and zero delta isolate click changes from animation frames.
      runner = await ScenePropertyScripts.create(scene, 0, [], true);
      const initial = capture(runner.update(0, 0, [], 0).layers);
      if (!initialized) {
        for (const [id, visible] of initial) baseline.set(id, visible);
        states.set(signature(baseline), { visibility: new Map(baseline), label: "" });
        initialized = true;
      }
      const visited = new Set<string>();
      let previous = signature(initial);
      for (let step = 0; step < 16 && states.size < 32; step++) {
        const visibility = capture(click(runner, control).layers), key = signature(visibility);
        if (key !== previous) switchingControls.add(control.id);
        for (const layer of images) if (visibility.get(layer.id) !== baseline.get(layer.id)) changed.add(layer.id);
        const label = (control.text?.value || control.name).trim().slice(0, 120);
        if (!states.has(key)) states.set(key, { visibility, label: step ? `${label} · ${step + 1}` : label });
        else if (!states.get(key)!.label && !step) states.get(key)!.label = label;
        if (visited.has(key)) break;
        visited.add(key); previous = key;
      }
    } catch (error) { warn(error); }
    finally { runner?.dispose(); }
  }
  // A button selecting the initial form is a no-op until another form is active.
  const alternative = controls.find(control => switchingControls.has(control.id));
  if (alternative) for (const control of controls) {
    if (switchingControls.has(control.id)) continue;
    let runner: ScenePropertyScripts | undefined;
    try {
      runner = await ScenePropertyScripts.create(scene, 0, [], true);
      runner.update(0, 0, [], 0);
      const before = signature(capture(click(runner, alternative).layers));
      if (signature(capture(click(runner, control).layers)) !== before) switchingControls.add(control.id);
    } catch (error) { warn(error); }
    finally { runner?.dispose(); }
  }
  if (!states.size) states.set(signature(baseline), { visibility: baseline, label: "" });
  const forms: SceneForm[] = [];
  for (const [key, state] of states) {
    const xray = images.some(layer => state.visibility.get(layer.id) && layer.passes.some(pass => pass.xray));
    if (states.size === 1 && !xray) continue;
    const visibility: Record<number, boolean> = {};
    for (const id of changed) visibility[id] = state.visibility.get(id) === true;
    // Hide only actual form-switching controls; unrelated interactions stay live.
    for (const id of switchingControls) visibility[id] = false;
    const id = createHash("sha256").update(key).digest("hex").slice(0, 16);
    forms.push({ id: `${id}:base`, label: states.size > 1 ? state.label : "", visibility, xray: 0 });
    if (xray) forms.push({ id: `${id}:xray`, label: states.size > 1 ? state.label : "", visibility, xray: 1 });
  }
  return forms;
}
