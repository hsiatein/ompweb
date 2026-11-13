// omp-web plugin page helper. Include first in <head>:
//   <script src="/plugin-sdk.js"></script>
// Mirrors omp-web's theme (CSS custom properties as seen where the plugin is
// embedded, light/dark, wallpaper glass mode, font) onto the plugin page and
// exposes window.ompWeb. Contract: docs/PLUGINS.md.
(function () {
  "use strict";
  var match = /^\/api\/web-plugins\/([a-z0-9][a-z0-9-]{0,39})\//.exec(location.pathname);
  var pluginId = match ? match[1] : null;
  var root = document.documentElement;
  var host = null;
  try {
    // Same origin: the embedded page can read the app's document.
    if (window.parent !== window && window.parent.document) host = window.parent.document;
  } catch {
    host = null;
  }

  function syncTheme() {
    if (!host) return;
    var hostRoot = host.documentElement;
    // Variables come from the <iframe> element itself, so panel-level
    // overrides (e.g. the right panel's see-through fills over a wallpaper) apply.
    var frame = window.frameElement || hostRoot;
    var styles = getComputedStyle(frame);
    for (var i = 0; i < styles.length; i++) {
      var name = styles[i];
      if (name.indexOf("--") === 0) root.style.setProperty(name, styles.getPropertyValue(name));
    }
    // App themes have their own names (omp, ember, …); plugins get light/dark
    // from the app's color-scheme, plus the theme name for finer styling.
    var scheme = getComputedStyle(hostRoot).colorScheme || "";
    var dark = /dark/.test(scheme) && !/^light/.test(scheme);
    root.setAttribute("data-theme", dark ? "dark" : "light");
    var themeName = hostRoot.getAttribute("data-theme");
    if (themeName) root.setAttribute("data-omp-theme", themeName);
    // Wallpaper on: the page sits on the app's frosted glass; keep fills translucent.
    var wallpaper = hostRoot.getAttribute("data-wallpaper") === "on";
    root.setAttribute("data-wallpaper", wallpaper ? "on" : "off");
    var glass = hostRoot.getAttribute("data-glass");
    if (wallpaper && glass) root.setAttribute("data-glass", glass);
    else root.removeAttribute("data-glass");
    // Matching color-scheme keeps the transparent iframe from painting an opaque canvas.
    root.style.colorScheme = dark ? "dark" : "light";
    if (document.body && host.body) document.body.style.fontFamily = getComputedStyle(host.body).fontFamily;
  }

  syncTheme();
  if (!document.body) document.addEventListener("DOMContentLoaded", syncTheme, { once: true });
  if (host) {
    new MutationObserver(function () {
      syncTheme();
      // Theme switches animate variables over a frame or two.
      requestAnimationFrame(syncTheme);
      setTimeout(syncTheme, 400);
    }).observe(host.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style", "data-wallpaper", "data-glass"] });
  }

  window.ompWeb = {
    pluginId: pluginId,
    /** fetch() against this plugin's server: api("state") → /api/web-plugins/<id>/api/state */
    api: function (path, init) {
      if (!pluginId) return Promise.reject(new Error("not inside an omp-web plugin"));
      return fetch("/api/web-plugins/" + pluginId + "/api/" + String(path).replace(/^\/+/, ""), init);
    },
  };
})();
