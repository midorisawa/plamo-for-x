const quoteSources = new Map();

window.addEventListener("sns-translator-quote-source", event => {
  const { parentId, id, text, language, urls, shortened } = event.detail ?? {};
  if (typeof parentId !== "string" || !/^\d+$/.test(parentId) ||
      typeof id !== "string" || !/^\d+$/.test(id) ||
      typeof text !== "string" || typeof language !== "string" || !Array.isArray(urls)) return;
  const previous = quoteSources.get(parentId);
  const isShortened = shortened === true;
  if (previous?.id === id && previous.text === text && previous.language === language &&
      (previous.shortened || !isShortened)) return;
  const body = document.createElement("div");
  body.lang = language;
  const decoded = text.replace(/&(amp|lt|gt);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">" })[entity]);
  const links = new Map(urls.filter(link => typeof link?.url === "string").map(link => [link.url, link]));
  let offset = 0;
  for (const match of decoded.matchAll(/https?:\/\/[^\s]+|@[A-Za-z0-9_]+|#[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    const link = links.get(token);
    const href = token.startsWith("@") ? `https://x.com/${token.slice(1)}`
      : token.startsWith("#") ? `https://x.com/hashtag/${encodeURIComponent(token.slice(1))}`
      : link?.href ?? token;
    if (typeof href !== "string" || !/^https?:\/\//i.test(href)) continue;
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.textContent = typeof link?.label === "string" ? link.label : token;
    body.append(decoded.slice(offset, match.index), anchor);
    offset = match.index + token.length;
  }
  body.append(decoded.slice(offset));
  quoteSources.delete(parentId);
  quoteSources.set(parentId, { id, text, language, body, shortened: isShortened });
  if (quoteSources.size > 500) quoteSources.delete(quoteSources.keys().next().value);
  document.dispatchEvent(new CustomEvent("sns-translator-quote-ready", { detail: parentId }));
});
