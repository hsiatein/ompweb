const BOXES = ".wallpaper-user, .wallpaper-assistant, .chat-input-shell, .wallpaper-surface, .wallpaper-inset, .sidebar-project-header, .session-item-row, .sidebar-settings-row, .shell-topbar, .wallpaper-panel-toggle";
const CONTROLS = "button, input, textarea, select";

export function contrastRegion(target: HTMLElement, root: HTMLElement, backgroundAlpha: (element: HTMLElement) => number): HTMLElement {
  let control: HTMLElement | undefined;
  for (let element: HTMLElement | null = target; element; element = element.parentElement) {
    // A solid inner surface hides the wallpaper, even inside a named glass region.
    // Low-alpha table/row tints must still share the enclosing message's ink.
    if (backgroundAlpha(element) >= 250 || element.matches(BOXES)) return element;
    if (!control && element.matches(CONTROLS)) control = element;
    if (element === root) break;
  }
  return control ?? root;
}
