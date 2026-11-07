(() => {
  const scheme = matchMedia("(prefers-color-scheme: dark)");

  function syncToolbarTheme() {
    chrome.runtime.sendMessage({ type: "toolbar-color-scheme", dark: scheme.matches }).catch(() => {});
  }

  scheme.addEventListener("change", syncToolbarTheme);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncToolbarTheme();
  });
  syncToolbarTheme();
})();
