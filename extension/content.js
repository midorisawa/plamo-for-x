const postSelector = 'article[data-testid="tweet"]';
const textSelector = '[data-testid="tweetText"]';
const noteSelector = '[data-testid="birdwatch-pivot"]';
const targetSelector = `${postSelector}, ${noteSelector}`;
const iconUrl = chrome.runtime.getURL("icons/local-translator.svg");
const states = new WeakMap();
const originalLanguages = new WeakMap();
const pending = new Map();
const autoQueue = new Set();
let lastWarmup = -Infinity;
let targetLanguage = "";
let sourceLanguages = null;
let autoTranslate = false;
let activeTranslations = 0;
let draining = false;

async function drainAutoQueue() {
  if (draining || !autoTranslate || document.visibilityState !== "visible") return;
  draining = true;
  try {
    while (autoTranslate && document.visibilityState === "visible" && !activeTranslations && autoQueue.size) {
      const state = autoQueue.values().next().value;
      if (state.panel.isConnected && !state.attempted && await state.translate(true)) {
        // 別のタブの翻訳が終わるまで、同じ投稿を先頭に残す
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        autoQueue.delete(state);
      }
    }
  } finally {
    draining = false;
  }
}

function updateAutoTranslate(enabled) {
  autoTranslate = enabled === true;
  autoQueue.clear();
  if (!autoTranslate) return;
  for (const root of document.querySelectorAll(targetSelector)) {
    const state = states.get(root);
    if (state && !state.attempted) autoQueue.add(state);
  }
  drainAutoQueue();
}

async function warmTranslation() {
  if (document.visibilityState !== "visible" || performance.now() - lastWarmup < 30000) return;
  lastWarmup = performance.now();
  try {
    await chrome.runtime.sendMessage({ type: "warm-translation" });
  } catch {
    // 拡張機能の再読み込み後は、開いたままのタブから事前読み込みを実行できない
  }
}

function nativeTranslationControl(body, root) {
  for (let block = body; block && block !== root; block = block.parentElement) {
    const row = block.previousElementSibling;
    const candidate = row?.matches(".sns-translator") ? row.previousElementSibling : row;
    if (!candidate || candidate.querySelector(textSelector)) continue;
    const button = [...candidate.querySelectorAll("button")].find(control =>
      /^(原文を表示|Show original|翻訳を表示|Show translation)$/i.test(control.textContent.trim()));
    if (button) return { button, row: candidate, translated: /^(原文を表示|Show original)$/i.test(button.textContent.trim()) };
  }
}

function readTarget(root) {
  const isNote = root.matches(noteSelector);
  const body = isNote ? root.querySelector(":scope > div[dir]") : [...root.querySelectorAll(textSelector)].find(node => {
    const card = node.closest('[role="link"]');
    return node.closest(targetSelector) === root &&
      !(card && root.contains(card) && card.querySelector('[data-testid="User-Name"]'));
  });
  const text = body?.textContent.trim();
  if (!text) return null;
  const native = nativeTranslationControl(body, root);

  const article = root.closest(postSelector);
  const permalink = [...(article?.querySelectorAll('a[href*="/status/"]') ?? [])]
    .find(link => link.querySelector("time") && !article.contains(link.closest('[role="link"]')));
  const id = permalink?.pathname.match(/\/status\/(\d+)/)?.[1];
  const hrefs = [...body.querySelectorAll("a[href]")].map(anchor => anchor.href);
  return { body, text, id, language: body.lang, native, hrefs };
}

function matches(left, right) {
  return right && left.body === right.body && left.text === right.text && left.id === right.id &&
    left.language === right.language && left.native?.translated === right.native?.translated &&
    left.hrefs.length === right.hrefs.length && left.hrefs.every((href, index) => href === right.hrefs[index]);
}

function switchNativeTranslation(root, post, translated) {
  return new Promise(resolve => {
    function finish(original) {
      clearTimeout(timer);
      observer.disconnect();
      resolve(original);
    }
    function check() {
      const current = readTarget(root);
      if (!root.isConnected || (current && current.id !== post.id)) finish(null);
      else if (current && Boolean(current.native?.translated) === translated && current.text !== post.text) finish(current);
    }
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => finish(null), 3000);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["lang", "dir"] });
    post.native.button.click();
    check();
  });
}

function canTranslate(source, target) {
  return Boolean(target) && source !== target &&
    (sourceLanguages === null ||
      (source === null ? sourceLanguages.length > 0 : sourceLanguages.includes(source || "und")));
}

function mount(root) {
  const target = targetLanguage;
  let post = readTarget(root);
  const previous = states.get(root);
  if (previous?.revealing) return;
  const known = originalLanguages.get(root);
  const source = post?.native?.translated
    ? (known?.id === post.id && known?.text === post.text ? known.language : null)
    : translationLanguage(post?.language);
  if (post && canTranslate(source, target) && previous?.target === target &&
      matches(previous.post, post) && previous.panel.isConnected) return;
  previous?.panel.remove();
  autoQueue.delete(previous);
  states.delete(root);
  if (!post || !canTranslate(source, target)) return;

  const panel = document.createElement("div");
  panel.className = "sns-translator";
  const toolbar = document.createElement("div");
  toolbar.className = "sns-translator-toolbar";
  const icon = document.createElement("span");
  icon.className = "sns-translator-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.style.maskImage = `url("${iconUrl}")`;
  const label = document.createElement("span");
  label.hidden = true;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "PLaMoで翻訳";
  const output = document.createElement("div");
  output.setAttribute("role", "status");
  output.lang = target;
  output.dir = "auto";
  const isNote = root.matches(noteSelector);
  const references = document.createElement("div");
  references.className = "sns-translator-references";
  toolbar.append(icon, label, button);
  panel.append(toolbar, output, references);
  panel.addEventListener("click", event => {
    if (event.target.closest("a")) event.stopPropagation();
  });
  post.body.before(panel);
  const state = { post, panel, target, translate: runTranslation };
  states.set(root, state);
  warmTranslation();
  button.addEventListener("pointerenter", warmTranslation);
  let translation = null;
  let links = [];

  function showTranslation(show) {
    label.hidden = !show;
    button.textContent = show ? "原文を表示" : "PLaMo訳を表示";
    if (show) renderLinkedTranslation(output, references, translation, links);
    else output.textContent = "";
    panel.toggleAttribute("data-show-translation", show);
  }

  button.addEventListener("click", event => {
    event.stopPropagation();
    runTranslation(false);
  });
  if (autoTranslate) {
    autoQueue.add(state);
    drainAutoQueue();
  }

  async function runTranslation(automatic) {
    if (button.disabled) return;
    activeTranslations++;
    try {
      return await translate(automatic);
    } finally {
      activeTranslations--;
      drainAutoQueue();
    }
  }

  async function translate(automatic) {
    if (!matches(post, readTarget(root))) return;
    if (translation !== null) {
      showTranslation(!panel.hasAttribute("data-show-translation"));
      return;
    }
    state.attempted = true;
    button.disabled = true;
    output.textContent = "";
    if (post.native?.translated) {
      const grok = post.body.cloneNode(true);
      grok.removeAttribute("data-testid");
      grok.removeAttribute("id");
      for (const element of grok.querySelectorAll("[id]")) element.removeAttribute("id");
      grok.classList.add("sns-translator-grok");
      panel.append(grok);
      panel.setAttribute("data-keep-grok", "");
      state.revealing = true;
      const original = await switchNativeTranslation(root, post, false);
      if (!original) {
        state.revealing = false;
        grok.remove();
        panel.removeAttribute("data-keep-grok");
        button.disabled = false;
        output.textContent = "原文を取得できませんでした。";
        if (target !== targetLanguage || !matches(post, readTarget(root)) || !panel.isConnected) mount(root);
        return;
      }
      const language = translationLanguage(original.language);
      originalLanguages.set(root, { id: post.id, text: post.text, language });
      post = state.post = original;
      post.body.before(panel);
      if (!canTranslate(language, target) || target !== targetLanguage) {
        if (original.native?.button) await switchNativeTranslation(root, original, true);
        state.revealing = false;
        mount(root);
        return;
      }
      state.revealing = false;
      if (!automatic) button.focus({ preventScroll: true });
    }
    if (post.native?.row === panel.previousElementSibling) {
      post.native.row.classList.add("sns-translator-native-row");
    }
    const id = crypto.randomUUID();
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });
    function formatTranslation() {
      const style = getComputedStyle(post.body);
      output.style.font = style.font;
      output.style.color = style.color;
      const language = new Intl.DisplayNames(["ja"], { type: "language", fallback: "none" });
      let source;
      try {
        if (post.language && post.language !== "und") source = language.of(post.language);
      } catch {
        // 言語タグが不正な場合はモデル名だけを表示する
      }
      label.textContent = source ? `${source}からの翻訳 · PLaMo` : "PLaMoによる翻訳";
    }
    function finish(result) {
      const partial = result.partial !== undefined;
      if (!partial) {
        clearTimeout(timer);
        pending.delete(id);
        complete(result.retry === true);
      }
      if (!panel.isConnected || !matches(post, readTarget(root))) return;
      if (result.retry) {
        state.attempted = false;
        button.disabled = false;
        return;
      }
      if (!result.error && panel.hasAttribute("data-keep-grok")) {
        panel.querySelector(".sns-translator-grok")?.remove();
        panel.removeAttribute("data-keep-grok");
      }
      if (partial) {
        if (!panel.hasAttribute("data-show-translation")) {
          formatTranslation();
          label.hidden = false;
          button.textContent = "原文を表示";
          output.setAttribute("aria-busy", "true");
          panel.setAttribute("data-show-translation", "");
        }
        renderLinkedTranslation(output, references, result.partial, links, true);
        return;
      }
      button.disabled = false;
      output.removeAttribute("aria-busy");
      if (result.error) {
        panel.removeAttribute("data-show-translation");
        label.hidden = true;
        button.textContent = "PLaMoで翻訳";
        output.textContent = result.error;
        return;
      }
      if (!panel.hasAttribute("data-show-translation")) formatTranslation();
      translation = result.text + (result.truncated ? "\n（訳文は途中まで）" : "");
      showTranslation(true);
    }
    const timer = setTimeout(() => finish({ error: "翻訳に時間がかかっています。もう一度お試しください。" }), 180000);
    pending.set(id, finish);
    try {
      const input = translationInput(post.body, isNote);
      links = input.links;
      references.replaceChildren();
      if (links.length && !input.hasProse) {
        finish({ text: input.text });
      } else {
        chrome.runtime.sendMessage({ type: "translate-post", id, text: input.text, target })
          .then(response => {
            if (!pending.has(id) || response?.accepted) return;
            if (automatic && response?.busy) finish({ retry: true });
            else finish({ error: response?.error ?? "翻訳を開始できませんでした。" });
          })
          .catch(() => {
            if (pending.has(id)) finish({ error: "拡張機能に接続できませんでした。ページを再読み込みしてください。" });
          });
      }
    } catch {
      finish({ error: "拡張機能に接続できませんでした。ページを再読み込みしてください。" });
    }
    return completed;
  }
}

chrome.runtime.onMessage.addListener(message => {
  if (message.type === "translation-result") pending.get(message.id)?.(message.result);
});

function updateTargetLanguage(saved) {
  const target = preferredTranslationLanguage(saved);
  if (target === targetLanguage) return;
  targetLanguage = target;
  document.querySelectorAll(targetSelector).forEach(mount);
}

chrome.storage.local.get(["targetLanguage", "sourceLanguages", "autoTranslate"])
  .then(settings => {
    sourceLanguages = Array.isArray(settings.sourceLanguages) ? settings.sourceLanguages : null;
    updateTargetLanguage(settings.targetLanguage);
    updateAutoTranslate(settings.autoTranslate);
  })
  .catch(() => updateTargetLanguage());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.sourceLanguages) {
    const saved = changes.sourceLanguages.newValue;
    sourceLanguages = Array.isArray(saved) ? saved : null;
    document.querySelectorAll(targetSelector).forEach(mount);
  }
  if (changes.targetLanguage) updateTargetLanguage(changes.targetLanguage.newValue);
  if (changes.autoTranslate) updateAutoTranslate(changes.autoTranslate.newValue);
});
document.addEventListener("visibilitychange", () => {
  if (document.querySelector(".sns-translator")) warmTranslation();
  drainAutoQueue();
});
new MutationObserver(records => {
  const targets = new Set();
  for (const { target, addedNodes } of records) {
    const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    if (element?.closest(".sns-translator")) continue;
    const root = element?.closest(targetSelector);
    if (root) targets.add(root);
    for (const node of addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches(targetSelector)) targets.add(node);
      node.querySelectorAll(targetSelector).forEach(target => targets.add(target));
    }
  }
  for (const root of targets) {
    if (root.isConnected) mount(root);
  }
}).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["lang", "href", "dir"] });
