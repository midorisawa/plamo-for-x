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
const postModelChoices = new Map();
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
let activeTranslation;
let draining = false;
let expandedPreview;
let glossaryRevision = 0;
let translationModels = [];
let defaultTranslationModel;
let modelCatalogRequest = 0;

async function refreshTranslationModels() {
  const request = ++modelCatalogRequest;
  try {
    const { models, activeModelId } = await chrome.runtime.sendMessage({ type: "get-translation-models" });
    if (request !== modelCatalogRequest) return;
    translationModels = models;
    defaultTranslationModel = activeModelId;
    for (const [postId, modelId] of postModelChoices) {
      if (!models.some(({ id }) => id === modelId)) postModelChoices.delete(postId);
    }
    for (const root of document.querySelectorAll(targetSelector)) {
      const state = states.get(root);
      if (!state?.refreshModelPicker) continue;
      state.modelId = postModelChoices.get(state.post.id);
      state.refreshModelPicker();
    }
  } catch {
    // 拡張機能を再読み込みしたタブではモデル一覧を取得できない
  }
}

function requestTranslation(signal, text, target, glossary, onPartial, modelId, postId, preview, cacheRevision) {
  if (signal.aborted) return Promise.resolve({ stopped: true });
  if (!translationEnabled) return Promise.resolve({ error: "投稿の翻訳は無効です。" });
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    function finish(result) {
      if (signal.aborted && !result.stopped) return;
      if (result.partial !== undefined) {
        onPartial(result.partial);
        return;
      }
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      pending.delete(id);
      resolve(result);
    }
    function stop() {
      chrome.runtime.sendMessage({ type: "stop-post-translation", id })
        .catch(() => {}).then(() => finish({ stopped: true }));
    }
    // Worker側の事前読み込み・再読み込み・翻訳がそれぞれ終わるまで待つ
    const timer = setTimeout(() => finish({ error: "翻訳に時間がかかっています。もう一度お試しください。" }), 10 * 60 * 1000);
    pending.set(id, finish);
    signal.addEventListener("abort", stop, { once: true });
    async function send() {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "translate-post", id, text, target, glossary, postId, preview, cacheRevision, modelId,
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
    while (translationEnabled && autoTranslate && document.visibilityState === "visible" && !activeTranslation && autoQueue.size) {
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
  for (const panel of document.querySelectorAll(".sns-translator")) {
    const root = panel.closest(targetSelector);
    const state = states.get(root);
    if (state?.panel === panel && !state.attempted && !state.prefersNativeDisplay() &&
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
  refreshPostCopies(id, root);
}

function refreshPostCopies(id, root) {
  queueMicrotask(() => {
    for (const other of document.querySelectorAll(`${postSelector}, ${quoteSelector}`)) {
      if (other !== root && (states.get(other)?.post.id ?? readPostId(other)) === id) mount(other);
    }
  });
}

function addModelPicker(toolbar, currentModel, selectModel, isTranslating) {
  const busyMessage = "翻訳の完了後にモデルを変更できます。";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "sns-translator-model-trigger";
  const svgNamespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(svgNamespace, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const outline = document.createElementNS(svgNamespace, "path");
  outline.setAttribute("d", "M10.54 1.75h2.92l1.57 2.36c.11.17.32.25.53.21l2.53-.59 2.17 2.17-.58 2.54c-.05.2.04.41.21.53l2.36 1.57v2.92l-2.36 1.57c-.17.12-.26.33-.21.53l.58 2.54-2.17 2.17-2.53-.59c-.21-.04-.42.04-.53.21l-1.57 2.36h-2.92l-1.58-2.36c-.11-.17-.32-.25-.52-.21l-2.54.59-2.17-2.17.58-2.54c.05-.2-.03-.41-.21-.53l-2.35-1.57v-2.92L4.1 8.97c.18-.12.26-.33.21-.53L3.73 5.9 5.9 3.73l2.54.59c.2.04.41-.04.52-.21l1.58-2.36zm1.07 2l-.98 1.47C10.05 6.08 9 6.5 7.99 6.27l-1.46-.34-.6.6.33 1.46c.24 1.01-.18 2.07-1.05 2.64l-1.46.98v.78l1.46.98c.87.57 1.29 1.63 1.05 2.64l-.33 1.46.6.6 1.46-.34c1.01-.23 2.06.19 2.64 1.05l.98 1.47h.78l.97-1.47c.58-.86 1.63-1.28 2.65-1.05l1.45.34.61-.6-.34-1.46c-.23-1.01.18-2.07 1.05-2.64l1.47-.98v-.78l-1.47-.98c-.87-.57-1.28-1.63-1.05-2.64l.34-1.46-.61-.6-1.45.34c-1.02.23-2.07-.19-2.65-1.05l-.97-1.47h-.78zM12 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5c.82 0 1.5-.67 1.5-1.5s-.68-1.5-1.5-1.5zM8.5 12c0-1.93 1.56-3.5 3.5-3.5 1.93 0 3.5 1.57 3.5 3.5s-1.57 3.5-3.5 3.5c-1.94 0-3.5-1.57-3.5-3.5z");
  icon.append(outline);
  trigger.append(icon);
  trigger.title = "この投稿の翻訳モデルを選ぶ";
  trigger.setAttribute("aria-label", trigger.title);
  trigger.setAttribute("aria-expanded", "false");
  const picker = document.createElement("div");
  picker.className = "sns-translator-model-picker";
  picker.popover = "auto";
  trigger.popoverTargetElement = picker;
  const heading = document.createElement("strong");
  heading.className = "sns-translator-model-heading";
  heading.textContent = "別のモデルで再翻訳";
  const choices = document.createElement("div");
  picker.append(heading, choices);
  picker.addEventListener("click", event => event.stopPropagation());
  picker.addEventListener("toggle", () => {
    const open = picker.matches(":popover-open");
    trigger.setAttribute("aria-expanded", String(open));
    if (open) choices.querySelector("button")?.focus({ preventScroll: true });
  });
  trigger.addEventListener("click", event => {
    event.stopPropagation();
    if (picker.matches(":popover-open")) return;
    const rect = trigger.getBoundingClientRect();
    picker.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 248))}px`;
    picker.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - 186))}px`;
    renderChoices();
  });
  function renderChoices() {
    if (isTranslating()) {
      choices.textContent = busyMessage;
      return;
    }
    choices.replaceChildren(...translationModels.filter(({ id }) => id !== currentModel())
      .map(({ id, label }) => {
        const option = document.createElement("button");
        option.type = "button";
        option.textContent = label;
        option.addEventListener("click", () => {
          if (isTranslating()) {
            choices.textContent = busyMessage;
            trigger.focus({ preventScroll: true });
            return;
          }
          picker.hidePopover();
          trigger.focus({ preventScroll: true });
          selectModel(id);
        });
        return option;
      }));
  }
  toolbar.append(trigger, picker);
  function refresh() {
    trigger.hidden = translationModels.length <= 1;
    if (picker.matches(":popover-open")) {
      if (trigger.hidden) picker.hidePopover();
      else renderChoices();
    }
  }
  refresh();
  return refresh;
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
  const modelId = postModelChoices.get(displayId);
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
      previous.displayChoice === displayChoice() && previous.modelId === modelId &&
      previous.collapsed === collapsed && matches(previous.post, post) && previous.panel.isConnected) return;
  previous?.panel.remove();
  previous?.stopTranslation();
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
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.textContent = "停止";
  stopButton.setAttribute("aria-label", "翻訳を停止");
  stopButton.hidden = true;
  let translationController;
  stopButton.addEventListener("click", event => {
    event.stopPropagation();
    translationController?.abort();
  });
  const output = document.createElement("div");
  output.setAttribute("role", "status");
  output.lang = target;
  output.dir = "auto";
  const references = document.createElement("div");
  references.className = "sns-translator-references";
  toolbar.append(icon, label, button, stopButton);
  panel.append(toolbar, output, references);
  panel.addEventListener("click", event => {
    if (event.target.closest("a")) event.stopPropagation();
  });
  post.body.before(panel);
  post.grokRow?.classList.add("sns-translator-native-row");
  const state = { root, post, panel, target, collapsed, label, output, references,
    modelId, displayChoice: displayChoice(), prefersNativeDisplay, translate: runTranslation,
    stopTranslation: () => translationController?.abort() };
  states.set(root, state);
  if (displayId) {
    state.refreshModelPicker = addModelPicker(toolbar,
      () => state.translatedModelId ?? state.modelId ?? defaultTranslationModel, next => {
        postModelChoices.set(displayId, next);
        if (displayChoice() === "plamo") refreshPostCopies(displayId, root);
        else setPostDisplayChoice(displayId, "plamo", root);
        mount(root);
        states.get(root)?.panel.querySelector(".sns-translator-model-trigger")?.focus({ preventScroll: true });
      }, () => button.disabled);
  }
  warmTranslation();
  button.addEventListener("pointerenter", warmTranslation);
  let translation = null;
  let links = [];
  const expansion = !prefersNativeDisplay() && !collapsed && !isNote && !isProfile &&
    expandedPreview?.id === post.id && expandedPreview?.target === target && expandedPreview?.modelId === modelId
    ? expandedPreview : undefined;
  let keepingPreview = Boolean(expansion);
  if (expansion) {
    state.translatedModelId = expansion.translatedModelId;
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
    if (!automatic && activeTranslation) {
      manualQueue.add(state);
      return;
    }
    activeTranslation = state;
    translationController = new AbortController();
    const { signal } = translationController;
    stopButton.hidden = false;
    try {
      return await translate(automatic, signal);
    } finally {
      translationController = undefined;
      const restoreFocus = document.activeElement === stopButton;
      stopButton.hidden = true;
      button.disabled = false;
      if (signal.aborted && panel.isConnected) {
        keepingPreview = false;
        output.removeAttribute("aria-busy");
        references.replaceChildren();
        panel.querySelector(".sns-translator-grok")?.remove();
        panel.removeAttribute("data-keep-grok");
        showTranslation(false);
        button.textContent = "PLaMoで翻訳";
        if (displayId) {
          state.displayChoice = "original";
          setPostDisplayChoice(displayId, "original", root);
        }
        if (restoreFocus) button.focus({ preventScroll: true });
      }
      state.refreshModelPicker?.();
      activeTranslation = undefined;
      drainManualQueue();
    }
  }

  async function translate(automatic, signal) {
    if (!matches(post, readTarget(root))) return;
    if (translation !== null) return;
    const { modelId } = state;
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
      if (signal.aborted || result.stopped) return;
      const partial = result.partial !== undefined;
      if (!panel.isConnected || !post.body.isConnected || states.get(root) !== state) return;
      // 途中の訳文はDOM監視によるパネルの更新に任せ、確定時に本文を照合する
      if (!partial && !matches(post, readTarget(root))) return;
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
      state.translatedModelId = result.modelId;
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
      if (signal.aborted || !panel.isConnected) return;
      if (error) {
        finish({ error });
        return;
      }
      let text = input.text;
      let prefix = "";
      let cacheRevision;
      let prefixModelId;
      if (collapsed) {
        const segmenter = new Intl.Segmenter(translationLanguage(post.language) || undefined, { granularity: "sentence" });
        const sentences = [...segmenter.segment(text)];
        // 句点を省いて改行で区切る投稿では、最後の行から訳し直す
        const boundary = Math.max(sentences.at(-1)?.index ?? 0, text.lastIndexOf("\n") + 1);
        if (boundary) {
          const source = text.slice(0, boundary);
          const separator = /\n\s*$/.test(source) ? "\n" : /^(ja|zh-)/.test(target) ? "" : " ";
          const first = await requestTranslation(
            signal, source.trimEnd(), target, glossary, partial => finish({ partial }), modelId, post.id, { source, separator },
          );
          if (!first.text || first.truncated) {
            finish(automatic && first.busy ? { retry: true } : first);
            return automatic && first.busy;
          }
          prefix = first.text + separator;
          cacheRevision = first.cacheRevision;
          prefixModelId = first.modelId;
          text = text.slice(boundary).trim();
          if (!panel.isConnected || !matches(post, readTarget(root))) return;
        }
      }
      if (prefix) finish({ partial: prefix });
      const result = text
        ? await requestTranslation(signal, text, target, glossary, partial => finish({ partial: prefix + partial }),
          prefixModelId ?? modelId,
          !collapsed && !isNote && !isProfile ? post.id : undefined, undefined, cacheRevision)
        : { text: prefix.trimEnd(), modelId: prefixModelId };
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
      modelId: state.modelId,
      translatedModelId: state.translatedModelId,
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
  if (translationEnabled) document.querySelectorAll(targetSelector).forEach(mount);
}

let autoTranslatePreference;
let gpuSupport;
function applyAutoTranslatePreference(saved) {
  autoTranslatePreference = saved;
  if (!translationEnabled) return;
  if (typeof saved === "boolean") {
    updateAutoTranslate(saved);
    return;
  }
  if (typeof gpuSupport === "boolean") {
    updateAutoTranslate(gpuSupport);
    return;
  }
  chrome.runtime.sendMessage({ type: "get-gpu-support" }).then(gpu => {
    if (translationEnabled && typeof autoTranslatePreference !== "boolean" && typeof gpuSupport !== "boolean") {
      updateAutoTranslate(gpu === true);
    }
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
  activeTranslation?.stopTranslation();
  document.querySelectorAll(".sns-translator-native-row").forEach(row => row.classList.remove("sns-translator-native-row"));
  for (const finish of pending.values()) finish({ error: "投稿の翻訳は無効です。" });
}

Promise.all([
  chrome.storage.local.get(["enabled", "targetLanguage", "sourceLanguages", "autoTranslate"]),
  Promise.resolve().then(() => chrome.storage.session.get("gpuSupport")).catch(() => ({})),
])
  .then(([settings, session]) => {
    gpuSupport = session.gpuSupport;
    sourceLanguages = Array.isArray(settings.sourceLanguages) ? settings.sourceLanguages : null;
    updateTargetLanguage(settings.targetLanguage);
    applyAutoTranslatePreference(settings.autoTranslate);
    setTranslationEnabled(settings.enabled !== false);
  })
  .catch(() => {
    updateTargetLanguage();
    setTranslationEnabled(true);
  });
refreshTranslationModels();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.gpuSupport) {
    gpuSupport = changes.gpuSupport.newValue;
    if (typeof autoTranslatePreference !== "boolean") applyAutoTranslatePreference(autoTranslatePreference);
    refreshTranslationModels();
  }
  if (area !== "local") return;
  if (changes.selectedModel || changes.modelCatalogVersion || changes.inferenceMode) refreshTranslationModels();
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
let readyQuoteParents = new Set();
document.addEventListener("sns-translator-quote-ready", event => {
  if (!translationEnabled) return;
  const id = event.detail;
  if (typeof id !== "string" || !/^\d+$/.test(id)) return;
  if (!readyQuoteParents.size) queueMicrotask(() => {
    const ids = readyQuoteParents;
    readyQuoteParents = new Set();
    if (!translationEnabled) return;
    for (const article of document.querySelectorAll(postSelector)) {
      if (ids.has(readPostId(article))) article.querySelectorAll(quoteSelector).forEach(mount);
    }
  });
  readyQuoteParents.add(id);
});
const postObserver = new MutationObserver(records => {
  if (activeTranslation && !activeTranslation.root.isConnected) activeTranslation.stopTranslation();
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
