function translationInput(body, isNote) {
  const copy = body.cloneNode(true);
  const links = [];
  const originalText = copy.textContent.toLowerCase();
  let nextNumber = 1;

  for (const anchor of copy.querySelectorAll("a[href]")) {
    if (!/^https?:\/\//i.test(anchor.href)) continue;
    let marker = "";
    if (!isNote) {
      do {
        marker = `XLink${nextNumber++}`;
      } while (originalText.includes(marker.toLowerCase()));
    }
    links.push({
      marker,
      href: anchor.href,
      label: anchor.textContent.trim() || anchor.href,
      newTab: isNote || anchor.target === "_blank",
    });
    anchor.replaceWith(marker ? `[[${marker}]]` : "");
  }
  const text = copy.textContent.trim();
  const hasProse = Boolean(text.replace(/\[\[XLink\d+\]\]/g, "").trim());
  return { text, links, hasProse };
}

function translationLink({ href, label, newTab }) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = label;
  if (newTab) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  return anchor;
}

function renderLinkedTranslation(output, references, text, links, partial = false) {
  if (!links.length) {
    output.textContent = text;
    references.replaceChildren();
    return;
  }

  // ストリーミング中は閉じ括弧まで届いていない識別子を隠す
  const markers = new Map(links.filter(link => link.marker).map(link => [link.marker.toLowerCase(), link]));
  if (partial && markers.size) {
    text = text.replace(/[\[［]{1,2}\s*(?:X|XL|XLi|XLin|XLink\s*\d*)?\s*$/i, "");
  }
  const used = new Set();
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const match of text.matchAll(/[\[［]{1,2}\s*XLink\s*(\d+)\s*[\]］]{1,2}/gi)) {
    const link = markers.get(`xlink${match[1]}`);
    if (!link) continue;
    fragment.append(text.slice(offset, match.index), translationLink(link));
    offset = match.index + match[0].length;
    used.add(link);
  }
  fragment.append(text.slice(offset));
  output.replaceChildren(fragment);

  // モデルが識別子を落とした場合は、元のリンクを訳文の下に残す
  if (!partial) references.replaceChildren(...links.filter(link => !used.has(link)).map(translationLink));
}
