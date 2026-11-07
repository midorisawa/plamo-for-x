(() => {
  function isGraphQL(url) {
    return /^https:\/\/x\.com\/i\/api\/graphql\//.test(url);
  }

  function publish(payload) {
    const remaining = [payload?.data];
    while (remaining.length) {
      const node = remaining.pop();
      if (!node || typeof node !== "object") continue;
      const result = node.quoted_status_result?.result;
      const quote = result?.tweet ?? result;
      const note = quote?.note_tweet?.note_tweet_results?.result;
      const preview = quote?.legacy?.full_text;
      const hasPreview = typeof preview === "string" && Boolean(preview.trim());
      const text = hasPreview ? preview : note?.text;
      const shortened = hasPreview && (quote.legacy.truncated === true ||
        (typeof note?.text === "string" && note.text.trim().length > preview.trim().length));
      if (/^\d+$/.test(node.rest_id) && /^\d+$/.test(quote?.rest_id) &&
          typeof text === "string" && typeof quote.legacy?.lang === "string") {
        const entities = hasPreview ? quote.legacy.entities : note?.entity_set;
        const urls = (entities?.urls ?? []).map(({ url, expanded_url, display_url }) =>
          ({ url, href: expanded_url, label: display_url }));
        window.dispatchEvent(new CustomEvent("sns-translator-quote-source", {
          detail: { parentId: node.rest_id, id: quote.rest_id, text, language: quote.legacy.lang, urls, shortened },
        }));
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") remaining.push(value);
      }
    }
  }

  const fetch = window.fetch;
  window.fetch = function (...args) {
    const request = Reflect.apply(fetch, this, args);
    request.then(response => {
      if (response.ok && isGraphQL(response.url)) {
        response.clone().json().then(publish).catch(() => {});
      }
    }).catch(() => {});
    return request;
  };

  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      if (!isGraphQL(this.responseURL)) return;
      try {
        if (this.responseType === "json") publish(this.response);
        else if (!this.responseType || this.responseType === "text") publish(JSON.parse(this.responseText));
      } catch {
        // Xの通常の通信処理には影響させない
      }
    }, { once: true });
    return Reflect.apply(send, this, args);
  };
})();
