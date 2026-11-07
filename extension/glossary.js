export const glossaryLimit = 20;

export function glossaryTerms(glossaries, ids) {
  const terms = new Map();
  for (const { id, entries } of glossaries) {
    if (!ids.includes(id)) continue;
    for (const { source, target } of entries) {
      if (terms.has(source) && terms.get(source) !== target) {
        throw new Error(`「${source}」に異なる訳語が指定されています。適用する用語集を見直してください。`);
      }
      terms.set(source, target);
    }
  }
  if (terms.size > glossaryLimit) throw new Error(`適用できる用語は合計${glossaryLimit}組までです。`);
  return [...terms].map(([source, target]) => ({ source, target }));
}

export function validGlossaryTerm(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100 &&
    !value.includes("<|plamo:") && !value.includes("\0");
}
