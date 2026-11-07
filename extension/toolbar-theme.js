(() => {
  const scheme = matchMedia("(prefers-color-scheme: dark)");

  function syncToolbarTheme() {
    try {
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage({ type: "toolbar-color-scheme", dark: scheme.matches }).catch(() => {});
        return;
      }
    } catch {
      // 拡張機能の再読み込み後は、古いタブからメッセージを送れない
    }
    scheme.removeEventListener("change", syncToolbarTheme);
    document.removeEventListener("visibilitychange", syncWhenVisible);
  }

  function syncWhenVisible() {
    if (!document.hidden) syncToolbarTheme();
  }

  scheme.addEventListener("change", syncToolbarTheme);
  document.addEventListener("visibilitychange", syncWhenVisible);
  syncToolbarTheme();
})();
