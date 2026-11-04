// Apply the saved theme before rendering. Keep in sync with src/lib/theme.ts.
(function () {
  try {
    var mode = localStorage.getItem("starlab_theme") || "system";
    var dark = mode === "dark" ||
      (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {}
})();
