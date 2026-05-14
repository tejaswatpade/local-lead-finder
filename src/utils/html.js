import {
  extractEmails,
  extractPhones,
  stripHtml,
  truncate,
  uniq,
} from "./text.js";

export function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : "";
}

export function extractMetaDescription(html) {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["'][^>]*>/i,
  ];

  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match) return stripHtml(match[1]);
  }

  return "";
}

export function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(String(html || "")))) {
    const href = match[1].trim();
    const text = stripHtml(match[2]);
    const absolute = absoluteUrl(baseUrl, href);
    if (absolute) links.push({ href: absolute, text });
  }

  return links;
}

export function findContactPage(links) {
  return (
    links.find(
      (link) =>
        /contact|get-in-touch|locations?|about/i.test(link.href) ||
        /contact|get in touch|location|about/i.test(link.text),
    )?.href || ""
  );
}

export function findBookingPage(links) {
  return (
    links.find(
      (link) =>
        /book|appointment|schedule|consult|reserve|booking|contact/i.test(
          link.href,
        ) ||
        /book|appointment|schedule|consultation|reserve|get started/i.test(
          link.text,
        ),
    )?.href || ""
  );
}

export function extractCtas(html, links) {
  const buttonTexts = [];
  const buttonRegex = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
  let buttonMatch;

  while ((buttonMatch = buttonRegex.exec(String(html || "")))) {
    buttonTexts.push(stripHtml(buttonMatch[1]));
  }

  const linkTexts = links
    .map((link) => link.text)
    .filter((text) =>
      /book|call|schedule|contact|consult|start|shop|buy|reserve|learn|get/i.test(
        text,
      ),
    );

  return uniq([...buttonTexts, ...linkTexts])
    .filter((text) => text.length >= 2 && text.length <= 60)
    .slice(0, 12);
}

export function extractTrustSignals(html, text) {
  const combined = `${stripHtml(html)} ${text}`.toLowerCase();
  const signals = [];

  const checks = [
    ["reviews", /reviews?|rated|stars?|google rating/],
    ["testimonials", /testimonials?|what clients say|patient stories/],
    ["gallery", /gallery|before and after|portfolio|results/],
    ["credentials", /certified|licensed|award|years? experience|trained/],
    ["social proof", /instagram|facebook|tiktok|followers/],
    ["financing", /financing|payment plan|membership/],
  ];

  for (const [label, pattern] of checks) {
    if (pattern.test(combined)) signals.push(label);
  }

  return uniq(signals);
}

export function extractHomepageText(html) {
  return truncate(stripHtml(html), 5000);
}

export function extractVisibleContact(html) {
  const text = stripHtml(html);
  return {
    emails: extractEmails(`${html} ${text}`),
    phones: extractPhones(text),
  };
}

function absoluteUrl(baseUrl, href) {
  if (!href || href.startsWith("#") || /^mailto:|^tel:|^javascript:/i.test(href)) {
    return "";
  }

  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}
