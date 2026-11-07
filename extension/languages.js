// PLaMo 3 Translateの対応言語
const translationLanguages = [
  "ja", "en", "zh-hans", "zh-hant", "ko", "ar", "az", "be", "bg", "bn", "ca",
  "ceb", "de", "es", "et", "eu", "fa", "fr", "gu", "he", "hi", "hr", "hu",
  "hy", "id", "it", "jv", "ka", "kk", "km", "lt", "lv", "ml", "mr", "ms",
  "my", "ne", "nl", "pa", "pl", "ru", "si", "sk", "sl", "sr", "sw", "ta",
  "te", "th", "tl", "ur", "uz", "vi",
];

function translationLanguage(tag) {
  if (!tag) return "";
  try {
    const locale = new Intl.Locale(tag);
    const code = locale.language === "zh"
      ? `zh-${locale.maximize().script.toLowerCase()}`
      : locale.language === "fil" ? "tl" : locale.language;
    return translationLanguages.includes(code) ? code : "";
  } catch {
    return "";
  }
}

function preferredTranslationLanguage(saved) {
  return translationLanguage(saved) ||
    navigator.languages.map(translationLanguage).find(Boolean) || "";
}
