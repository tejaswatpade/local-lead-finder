export function truncate(value, length = 4000) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

export function uniq(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()))];
}

export function normalizeUrl(value) {
  if (!value) return "";

  let url = String(value).trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "/");
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

export function domainFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractEmails(text) {
  return uniq(
    String(text || "").match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ||
      [],
  ).filter((email) => !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(email));
}

export function extractPhones(text) {
  const matches =
    String(text || "").match(
      /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g,
    ) || [];
  return uniq(matches.map((phone) => phone.replace(/\s+/g, " ").trim()));
}

export function firstSentence(value, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  const sentence = text.match(/^(.{20,180}?[.!?])\s/);
  return sentence ? sentence[1] : text.slice(0, 160);
}
