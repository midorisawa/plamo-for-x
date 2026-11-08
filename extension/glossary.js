export const glossaryLimit = 20;
export const withGlossaryLock = action => navigator.locks.request("sns-translator-glossaries", action);

export function glossaryTerms(glossaries, ids) {
  const terms = new Map();
  const reversed = [];
  function addTerm(source, target) {
    if (terms.has(source) && terms.get(source) !== target) {
      throw new Error(`「${source}」に異なる訳語が指定されています。適用する用語集を見直してください。`);
    }
    terms.set(source, target);
  }
  for (const { id, entries } of glossaries) {
    if (!ids.includes(id)) continue;
    for (const { source, target, enabled, bidirectional } of entries) {
      if (enabled === false) continue;
      addTerm(source, target);
      if (bidirectional) reversed.push({ source, target });
    }
  }
  if (terms.size > glossaryLimit) throw new Error(`適用できる用語は合計${glossaryLimit}組までです。`);
  for (const { source, target } of reversed) addTerm(target, source);
  return [...terms].map(([source, target]) => ({ source, target }));
}

export function validGlossaryTerm(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 &&
    !value.includes("<|plamo:") && !value.includes("\0");
}

export function parseGlossaryFile(contents) {
  const presets = JSON.parse(contents);
  if (!Array.isArray(presets) || !presets.length) {
    throw new Error("用語集を1件以上含むJSONファイルを選んでください。");
  }
  return presets.map(preset => {
    const { name, terms } = preset ?? {};
    if (typeof name !== "string" || !name.trim() || name.length > 80 ||
        !Array.isArray(terms) || !terms.length || terms.length > glossaryLimit) {
      throw new Error("用語集の名前と用語数を確認してください。");
    }
    const entries = terms.map(term => {
      const { source, target, enabled = true, bidirectional = false } = term ?? {};
      if (!validGlossaryTerm(source) || !validGlossaryTerm(target) ||
          typeof enabled !== "boolean" || typeof bidirectional !== "boolean") {
        throw new Error(`「${name}」の用語を確認してください。`);
      }
      return { source, target, ...(!enabled && { enabled }), ...(bidirectional && { bidirectional }) };
    });
    return { id: crypto.randomUUID(), name, entries };
  });
}
