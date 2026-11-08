const postSelector = 'article[data-testid="tweet"]';
const textSelector = '[data-testid="tweetText"]';
const noteSelector = '[data-testid="birdwatch-pivot"]';
const bioSelector = '[data-testid="UserDescription"]';
const profileSelector = `main:has(${bioSelector})`;
const quoteSelector = `${postSelector} div[role="link"]:has([data-testid="User-Name"])`;
const showMoreSelector = '[data-testid="tweet-text-show-more-link"]';
const targetSelector = `${postSelector}, ${noteSelector}, ${quoteSelector}, ${profileSelector}`;
const iconUrl = chrome.runtime.getURL("icons/local-translator.svg");
const states = new WeakMap();
const originalLanguages = new WeakMap();
const nativeSelections = new WeakMap();
const postDisplayChoices = new Map();
const nativeDisplayAttempts = new WeakMap();
const nativeRestorations = new WeakMap();
const renamedGrokButtons = new WeakMap();
const grokButtonLabel = "Grok訳を表示";
const pending = new Map();
const autoQueue = new Set();
const manualQueue = new Set();
let lastWarmup = -Infinity;
let targetLanguage = "";
let sourceLanguages = null;
let translationEnabled = false;
let autoTranslate = false;
let activeTranslations = 0;
let draining = false;
let expandedPreview;
let glossaryRevision = 0;

function requestTranslation(text, target, glossary, onPartial, postId, preview, cacheRevision) {
  if (!translationEnabled) return Promise.resolve({ error: "投稿の翻訳は無効です。" });
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    function finish(result) {
      if (result.partial !== undefined) {
        onPartial(result.partial);
        return;
      }
      clearTimeout(timer);
      pending.delete(id);
      resolve(result);
    }
    // Worker側の事前読み込み・再読み込み・翻訳がそれぞれ終わるまで待つ
    const timer = setTimeout(() => finish({ error: "翻訳に時間がかかっています。もう一度お試しください。" }), 10 * 60 * 1000);
    pending.set(id, finish);
    async function send() {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "translate-post", id, text, target, glossary, postId, preview, cacheRevision,
        });
        if (pending.has(id) && !response?.accepted) {
          finish(response ?? { error: "翻訳を開始できませんでした。" });
        }
      } catch {
        if (pending.has(id)) finish({ error: "拡張機能に接続できませんでした。ページを再読み込みしてください。" });
      }
    }
    send();
  });
}

async function drainAutoQueue() {
  if (draining || !translationEnabled || !autoTranslate || document.visibilityState !== "visible") return;
  draining = true;
  try {
    while (translationEnabled && autoTranslate && document.visibilityState === "visible" && !activeTranslations && autoQueue.size) {
      const state = nextAutoTranslation();
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

function nextAutoTranslation() {
  for (const state of autoQueue) {
    if (!state.panel.isConnected) continue;
    const rect = state.panel.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
    const parent = state.root.matches(quoteSelector) && states.get(state.root.closest(postSelector));
    return autoQueue.has(parent) ? parent : state;
  }
  return autoQueue.values().next().value;
}

function drainManualQueue() {
  for (const state of manualQueue) {
    manualQueue.delete(state);
    if (state.panel.isConnected) {
      state.translate(false);
      return;
    }
  }
  drainAutoQueue();
}

function updateAutoTranslate(enabled) {
  autoTranslate = enabled === true;
  autoQueue.clear();
  if (!autoTranslate) return;
  for (const root of document.querySelectorAll(targetSelector)) {
    const state = states.get(root);
    if (state && !state.attempted && !state.prefersNativeDisplay() &&
        nativeSelections.get(root) !== (state.post.id ?? null)) {
      autoQueue.add(state);
    }
  }
  drainAutoQueue();
}

async function warmTranslation() {
  if (!translationEnabled || document.visibilityState !== "visible" || performance.now() - lastWarmup < 30000) return;
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
    if (!candidate || candidate.querySelector(`${textSelector}, ${bioSelector}`)) continue;
    const button = [...candidate.querySelectorAll("button")].find(control =>
      /^(原文を表示|Show original|翻訳を表示|Show translation|Grok訳を表示)$/i.test(control.textContent.trim()));
    if (button) return { button, row: candidate, translated: /^(原文を表示|Show original)$/i.test(button.textContent.trim()) };
  }
}

function readPostId(root) {
  const permalink = [...(root?.querySelectorAll('a[href*="/status/"]') ?? [])]
    .find(link => link.querySelector("time") && link.closest(targetSelector) === root);
  return permalink?.pathname.match(/\/status\/(\d+)/)?.[1];
}

function readTarget(root) {
  const isNote = root.matches(noteSelector);
  const isProfile = root.matches(profileSelector);
  const body = isProfile ? root.querySelector(bioSelector)
    : isNote ? root.querySelector(":scope > div[dir]") : [...root.querySelectorAll(textSelector)]
    .find(node => node.closest(targetSelector) === root);
  const text = body?.textContent.trim();
  if (!text) return null;
  const native = nativeTranslationControl(body, isProfile ? body.parentElement.parentElement : root);

  const article = root.closest(postSelector);
  const isQuote = root.matches(quoteSelector);
  const source = isQuote && root.parentElement.closest(quoteSelector) === null
    ? quoteSources.get(readPostId(article))
    : undefined;
  const previous = body.previousElementSibling;
  const row = previous?.matches(".sns-translator") ? previous.previousElementSibling : previous;
  const grokRow = isQuote && !native && row?.querySelector('svg[viewBox="0 0 33 32"] + span') ? row : null;
  if (grokRow && !source) return null;
  const id = isProfile ? location.pathname : source?.id ?? readPostId(isNote ? article : root);
  const hrefs = [...body.querySelectorAll("a[href]")].map(anchor => anchor.href);
  const original = grokRow ? source.body : null;
  return { body, text, id, language: original?.lang ?? body.lang, native, hrefs, grokRow, original,
    shortened: source?.shortened };
}

function matchesContent(left, right) {
  return right && left.text === right.text && left.id === right.id &&
    left.language === right.language && left.original === right.original &&
    left.native?.translated === right.native?.translated &&
    left.hrefs.length === right.hrefs.length && left.hrefs.every((href, index) => href === right.hrefs[index]);
}

function matches(left, right) {
  return left.body === right?.body && matchesContent(left, right);
}

function switchNativeTranslation(root, post, translated) {
  return new Promise(resolve => {
    function finish(original) {
      clearTimeout(timer);
      observer.disconnect();
      resolve(original);
    }
    function check(deadline = false) {
      const current = readTarget(root);
      if (!root.isConnected || (current && current.id !== post.id)) finish(null);
      else if (current && (current.native
        ? current.native.translated === translated && (current.text !== post.text || deadline)
        : !translated && current.text !== post.text)) finish(current);
      else if (deadline) finish(null);
    }
    const observer = new MutationObserver(() => check());
    // ボタンだけ先に変わる場合に備え、同じ本文は待機期限まで保留する
    const timer = setTimeout(() => check(true), 3000);
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

function renameGrokButton(button) {
  if (button?.textContent.trim() !== "翻訳を表示") return;
  const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.data.trim() !== "翻訳を表示") continue;
    const ariaLabel = button.getAttribute("aria-label");
    renamedGrokButtons.set(button, { node, text: node.data, ariaLabel });
    node.data = grokButtonLabel;
    if (ariaLabel === "翻訳を表示") button.setAttribute("aria-label", grokButtonLabel);
    break;
  }
}

function setPostDisplayChoice(id, choice, root) {
  if (!id || postDisplayChoices.get(id)?.mode === choice) return;
  postDisplayChoices.set(id, { mode: choice });
  queueMicrotask(() => {
    for (const other of document.querySelectorAll(`${postSelector}, ${quoteSelector}`)) {
      if (other !== root && (states.get(other)?.post.id ?? readPostId(other)) === id) mount(other);
    }
  });
}

function mount(root) {
  if (!translationEnabled) return;
  const target = targetLanguage;
  let post = readTarget(root);
  const previous = states.get(root);
  if (previous?.revealing && (previous.panel.isConnected || (post && root.matches(profileSelector) &&
      previous.post.id === post.id))) return;
  const attempt = nativeDisplayAttempts.get(root);
  if (attempt?.pending) return;
  renameGrokButton(post?.native?.button);
  const isNote = root.matches(noteSelector);
  const isProfile = root.matches(profileSelector);
  const displayId = !isNote && !isProfile ? post?.id : undefined;
  const selection = postDisplayChoices.get(displayId);
  const displayChoice = () => postDisplayChoices.get(displayId)?.mode;
  const prefersNativeDisplay = () => displayChoice() === "original" || displayChoice() === "grok";
  const showGrok = displayChoice() === "grok";
  const restoreNative = prefersNativeDisplay() && post?.native && post.native.translated !== showGrok &&
    !(attempt?.selection === selection && attempt?.post.native.button === post.native.button && matches(attempt.post, post));
  const collapsed = !isNote && !isProfile && (post?.shortened || [...root.querySelectorAll(showMoreSelector)]
    .some(control => control.closest(targetSelector) === root));
  const known = originalLanguages.get(root);
  const source = post && (post.native?.translated || (isProfile && !post.language))
    ? (known?.id === post.id && known?.text === post.text ? known.language : null)
    : translationLanguage(post?.language);
  if (!restoreNative && post && canTranslate(source, target) && previous?.target === target &&
      previous.displayChoice === displayChoice() &&
      previous.collapsed === collapsed && matches(previous.post, post) && previous.panel.isConnected) return;
  previous?.panel.remove();
  autoQueue.delete(previous);
  manualQueue.delete(previous);
  states.delete(root);
  if (restoreNative) {
    const attempt = { post, selection, pending: true };
    nativeDisplayAttempts.set(root, attempt);
    switchNativeTranslation(root, post, showGrok).then(current => {
      attempt.pending = false;
      if (!translationEnabled) {
        if (current?.native?.button) switchNativeTranslation(root, current, !showGrok);
        return;
      }
      if (current && !showGrok && current.native?.button) nativeRestorations.set(root, current);
      if (root.isConnected) mount(root);
    });
    return;
  }
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
  const references = document.createElement("div");
  references.className = "sns-translator-references";
  toolbar.append(icon, label, button);
  panel.append(toolbar, output, references);
  panel.addEventListener("click", event => {
    if (event.target.closest("a")) event.stopPropagation();
  });
  post.body.before(panel);
  post.grokRow?.classList.add("sns-translator-native-row");
  const state = { root, post, panel, target, collapsed, label, output, references,
    displayChoice: displayChoice(), prefersNativeDisplay, translate: runTranslation };
  states.set(root, state);
  warmTranslation();
  button.addEventListener("pointerenter", warmTranslation);
  let translation = null;
  let links = [];
  const expansion = !prefersNativeDisplay() && !collapsed && !isNote && !isProfile &&
    expandedPreview?.id === post.id && expandedPreview?.target === target
    ? expandedPreview : undefined;
  let keepingPreview = Boolean(expansion);
  if (expansion) {
    output.append(...expansion.output.cloneNode(true).childNodes);
    output.style.cssText = expansion.output.style.cssText;
    references.append(...expansion.references.cloneNode(true).childNodes);
    label.textContent = expansion.label;
    label.hidden = false;
    button.textContent = "原文を表示";
    output.setAttribute("aria-busy", "true");
    panel.setAttribute("data-show-translation", "");
  }

  function showTranslation(show) {
    label.hidden = !show;
    button.textContent = show ? "原文を表示" : "PLaMo訳を表示";
    output.lang = !show && post.original ? post.language : target;
    if (show) renderLinkedTranslation(output, references, translation, links);
    else if (post.original) output.replaceChildren(...post.original.cloneNode(true).childNodes);
    else output.textContent = "";
    panel.toggleAttribute("data-show-translation", show);
    panel.toggleAttribute("data-show-quote-original", !show && Boolean(post.original));
  }

  button.addEventListener("click", event => {
    event.stopPropagation();
    if (displayId) {
      state.displayChoice = translation !== null && panel.hasAttribute("data-show-translation") ? "original" : "plamo";
      setPostDisplayChoice(displayId, state.displayChoice, root);
    }
    runTranslation(false);
  });
  if (prefersNativeDisplay()) {
    if (!showGrok) showTranslation(false);
  } else if (expansion || displayChoice() === "plamo") {
    runTranslation(false);
  } else if (autoTranslate && nativeSelections.get(root) !== (post.id ?? null)) {
    autoQueue.add(state);
    queueMicrotask(drainAutoQueue);
  }

  async function runTranslation(automatic) {
    if (!translationEnabled || !panel.isConnected || button.disabled) return;
    if (automatic && prefersNativeDisplay()) return;
    if (!automatic && translation !== null) {
      const show = !panel.hasAttribute("data-show-translation");
      showTranslation(show);
      return;
    }
    if (!automatic && activeTranslations) {
      manualQueue.add(state);
      return;
    }
    activeTranslations++;
    try {
      return await translate(automatic);
    } finally {
      activeTranslations--;
      if (!activeTranslations) drainManualQueue();
    }
  }

  async function translate(automatic) {
    if (!matches(post, readTarget(root))) return;
    if (translation !== null) return;
    state.attempted = true;
    state.glossaryRevision = glossaryRevision;
    button.disabled = true;
    let profileLanguage = "";
    async function detectProfileLanguage(original) {
      if (original.language) return translationLanguage(original.language);
      const detected = await chrome.i18n.detectLanguage(original.text).catch(() => null);
      return translationLanguage(detected?.languages[0]?.language);
    }
    if (!keepingPreview) output.textContent = "";
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
      if (original?.native?.button) nativeRestorations.set(root, original);
      if (isProfile && original?.body.isConnected && translationEnabled && states.get(root) === state) {
        original.body.before(panel);
      }
      if (!panel.isConnected) {
        if (!translationEnabled && original?.native?.button) {
          nativeRestorations.delete(root);
          await switchNativeTranslation(root, original, true);
        }
        state.revealing = false;
        if (isProfile && root.isConnected) mount(root);
        return;
      }
      if (!original) {
        state.revealing = false;
        grok.remove();
        panel.removeAttribute("data-keep-grok");
        button.disabled = false;
        output.textContent = "原文を取得できませんでした。";
        if (state.displayChoice !== displayChoice() || target !== targetLanguage ||
            !matches(post, readTarget(root)) || !panel.isConnected) mount(root);
        return;
      }
      state.post = original;
      const language = isProfile ? await detectProfileLanguage(original) : translationLanguage(original.language);
      if (!panel.isConnected || (isProfile && !matches(original, readTarget(root)))) {
        state.revealing = false;
        if (isProfile && root.isConnected) mount(root);
        return;
      }
      if (isProfile) profileLanguage = language;
      originalLanguages.set(root, { id: post.id, text: post.text, language });
      post = state.post = original;
      post.body.before(panel);
      renameGrokButton(post.native?.button);
      if (!canTranslate(language, target) || target !== targetLanguage) {
        nativeRestorations.delete(root);
        if (original.native?.button) await switchNativeTranslation(root, original, true);
        state.revealing = false;
        mount(root);
        return;
      }
      state.revealing = false;
      if (state.displayChoice !== displayChoice()) {
        mount(root);
        return;
      }
      if (!automatic) button.focus({ preventScroll: true });
    } else if (isProfile) {
      profileLanguage = await detectProfileLanguage(post);
      if (!panel.isConnected || !matches(post, readTarget(root))) return;
      originalLanguages.set(root, { id: post.id, text: post.text, language: profileLanguage });
      if (!canTranslate(profileLanguage, target)) {
        mount(root);
        return;
      }
    }
    if (post.native && (isProfile || post.native.row === panel.previousElementSibling)) {
      post.native.row.classList.add("sns-translator-native-row");
    }
    function formatTranslation() {
      const style = getComputedStyle(post.body);
      output.style.font = style.font;
      output.style.color = style.color;
      const language = new Intl.DisplayNames(["ja"], { type: "language", fallback: "none" });
      let source;
      try {
        const tag = profileLanguage || post.language;
        if (tag && tag !== "und") source = language.of(tag);
      } catch {
        // 言語タグが不正な場合はモデル名だけを表示する
      }
      label.textContent = source ? `PLaMoによる${source}からの翻訳` : "PLaMoによる翻訳";
    }
    function finish(result) {
      const partial = result.partial !== undefined;
      if (!panel.isConnected || !matches(post, readTarget(root))) return;
      if (state.displayChoice !== displayChoice()) {
        mount(root);
        return;
      }
      if (result.retry) {
        state.attempted = false;
        button.disabled = false;
        return;
      }
      if (keepingPreview) {
        keepingPreview = false;
        references.replaceChildren();
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
    try {
      const input = translationInput(post.original ?? post.body, isNote);
      links = input.links;
      if (!keepingPreview) references.replaceChildren();
      if (links.length && !input.hasProse) {
        finish({ text: input.text });
        return;
      }

      const { terms: glossary, error } = await chrome.runtime.sendMessage({ type: "get-glossary-terms" });
      if (!panel.isConnected) return;
      if (error) {
        finish({ error });
        return;
      }
      let text = input.text;
      let prefix = "";
      let cacheRevision;
      if (collapsed) {
        const segmenter = new Intl.Segmenter(translationLanguage(post.language) || undefined, { granularity: "sentence" });
        const sentences = [...segmenter.segment(text)];
        // 句点を省いて改行で区切る投稿では、最後の行から訳し直す
        const boundary = Math.max(sentences.at(-1)?.index ?? 0, text.lastIndexOf("\n") + 1);
        if (boundary) {
          const source = text.slice(0, boundary);
          const separator = /\n\s*$/.test(source) ? "\n" : /^(ja|zh-)/.test(target) ? "" : " ";
          const first = await requestTranslation(
            source.trimEnd(), target, glossary, partial => finish({ partial }), post.id, { source, separator },
          );
          if (!first.text || first.truncated) {
            finish(automatic && first.busy ? { retry: true } : first);
            return automatic && first.busy;
          }
          prefix = first.text + separator;
          cacheRevision = first.cacheRevision;
          text = text.slice(boundary).trim();
          if (!panel.isConnected || !matches(post, readTarget(root))) return;
        }
      }
      if (prefix) finish({ partial: prefix });
      const result = text
        ? await requestTranslation(text, target, glossary, partial => finish({ partial: prefix + partial }),
          !collapsed && !isNote && !isProfile ? post.id : undefined, undefined, cacheRevision)
        : { text: prefix.trimEnd() };
      if (automatic && result.busy) {
        finish({ retry: true });
        return true;
      }
      if (text && result.text) result.text = prefix + result.text;
      if (!collapsed && result.text && expandedPreview?.id === post.id) expandedPreview = undefined;
      finish(result);
    } catch {
      finish({ error: "拡張機能に接続できませんでした。ページを再読み込みしてください。" });
    }
  }
}

document.addEventListener("click", event => {
  // 原文の取得に使う拡張機能自身のクリックと、利用者による操作を区別する
  if (!translationEnabled || !event.isTrusted) return;
  const showMore = event.target.closest(showMoreSelector);
  if (showMore) {
    const state = states.get(showMore.closest(targetSelector));
    expandedPreview = state?.post.id && state.glossaryRevision === glossaryRevision &&
      state.panel.hasAttribute("data-show-translation") ? {
      id: state.post.id,
      target: state.target,
      output: state.output.cloneNode(true),
      references: state.references.cloneNode(true),
      label: state.label.textContent,
    } : undefined;
    return;
  }
  const button = event.target.closest("button");
  const root = button?.closest(targetSelector);
  if (!root) return;
  const post = readTarget(root);
  if (post?.native?.button !== button) return;
  if (root.matches(postSelector) && post.id) {
    setPostDisplayChoice(post.id, post.native.translated ? "original" : "grok", root);
  }
  nativeRestorations.delete(root);
  nativeSelections.set(root, post.id ?? null);
  autoQueue.delete(states.get(root));
}, true);

chrome.runtime.onMessage.addListener(message => {
  if (message.type === "translation-result") pending.get(message.id)?.(message.result);
});

function updateTargetLanguage(saved) {
  const target = preferredTranslationLanguage(saved);
  if (target === targetLanguage) return;
  targetLanguage = target;
  document.querySelectorAll(targetSelector).forEach(mount);
}

let autoTranslatePreference;
function applyAutoTranslatePreference(saved) {
  autoTranslatePreference = saved;
  if (!translationEnabled) return;
  if (typeof saved === "boolean") {
    updateAutoTranslate(saved);
    return;
  }
  chrome.runtime.sendMessage({ type: "get-gpu-support" }).then(gpu => {
    if (translationEnabled && typeof autoTranslatePreference !== "boolean") updateAutoTranslate(gpu === true);
  }).catch(() => {});
}

function setTranslationEnabled(enabled) {
  if (translationEnabled === enabled) return;
  translationEnabled = enabled;
  if (enabled) {
    lastWarmup = -Infinity;
    postObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["lang", "href", "dir"],
    });
    applyAutoTranslatePreference(autoTranslatePreference);
    document.querySelectorAll(targetSelector).forEach(mount);
    return;
  }
  postObserver.disconnect();
  updateAutoTranslate(false);
  manualQueue.clear();
  expandedPreview = undefined;
  for (const root of document.querySelectorAll(targetSelector)) {
    const original = nativeRestorations.get(root);
    nativeRestorations.delete(root);
    const current = readTarget(root);
    const button = current?.native?.button;
    const renamed = button && renamedGrokButtons.get(button);
    if (renamed?.node.data === grokButtonLabel) renamed.node.data = renamed.text;
    if (renamed && button.getAttribute("aria-label") === grokButtonLabel) {
      button.setAttribute("aria-label", renamed.ariaLabel);
    }
    if (original && button && matchesContent(original, current)) {
      switchNativeTranslation(root, current, true);
    }
  }
  document.querySelectorAll(".sns-translator").forEach(panel => panel.remove());
  document.querySelectorAll(".sns-translator-native-row").forEach(row => row.classList.remove("sns-translator-native-row"));
  for (const finish of pending.values()) finish({ error: "投稿の翻訳は無効です。" });
}

chrome.storage.local.get(["enabled", "targetLanguage", "sourceLanguages", "autoTranslate"])
  .then(settings => {
    sourceLanguages = Array.isArray(settings.sourceLanguages) ? settings.sourceLanguages : null;
    updateTargetLanguage(settings.targetLanguage);
    applyAutoTranslatePreference(settings.autoTranslate);
    setTranslationEnabled(settings.enabled !== false);
  })
  .catch(() => {
    updateTargetLanguage();
    setTranslationEnabled(true);
  });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled?.newValue === false) setTranslationEnabled(false);
  if (changes.glossaries || changes.selectedGlossaryIds) {
    glossaryRevision++;
    expandedPreview = undefined;
  }
  if (changes.sourceLanguages) {
    const saved = changes.sourceLanguages.newValue;
    sourceLanguages = Array.isArray(saved) ? saved : null;
    document.querySelectorAll(targetSelector).forEach(mount);
  }
  if (changes.targetLanguage) updateTargetLanguage(changes.targetLanguage.newValue);
  if (changes.autoTranslate) applyAutoTranslatePreference(changes.autoTranslate.newValue);
  if (changes.enabled && changes.enabled.newValue !== false) setTranslationEnabled(true);
});
document.addEventListener("visibilitychange", () => {
  if (document.querySelector(".sns-translator")) warmTranslation();
  drainAutoQueue();
});
document.addEventListener("sns-translator-quote-ready", event => {
  if (!translationEnabled) return;
  const id = event.detail;
  if (typeof id !== "string" || !/^\d+$/.test(id)) return;
  for (const article of document.querySelectorAll(`${postSelector}:has(a[href$="/status/${id}"] time)`)) {
    article.querySelectorAll(quoteSelector).forEach(mount);
  }
});
const postObserver = new MutationObserver(records => {
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
});
