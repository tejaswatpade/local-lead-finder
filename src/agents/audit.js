import { id, nowIso } from "../utils/ids.js";
import { firstSentence, truncate } from "../utils/text.js";

export async function runAuditAgent(scrapedItems, context) {
  const { storage, log, runId, onProgress } = context;
  const reports = [];

  for (let index = 0; index < scrapedItems.length; index += 1) {
    const item = scrapedItems[index];
    const { lead, scraped } = item;
    await onProgress?.(index, scrapedItems.length, "Audit Agent");

    try {
      await storage.updateById("Leads", "leadId", lead.leadId, {
        status: "Auditing",
        updatedAt: nowIso(),
      });
      await log("Audit Agent", "info", `Auditing ${lead.businessName}.`, lead.leadId);

      const audit = buildAudit(lead, scraped);
      const record = {
        auditId: id("audit"),
        leadId: lead.leadId,
        runId,
        ...audit,
        status: "Audited",
        createdAt: nowIso(),
      };

      await storage.append("AuditReports", record);
      await storage.updateById("Leads", "leadId", lead.leadId, {
        status: "Audited",
        updatedAt: nowIso(),
      });
      reports.push({ lead, scraped, audit: record });
      await log("Audit Agent", "info", `Audit score ${record.score}/100.`, lead.leadId);
    } catch (error) {
      await storage.updateById("Leads", "leadId", lead.leadId, {
        status: "Failed",
        updatedAt: nowIso(),
        error: truncate(error.message, 400),
      });
      await log("Audit Agent", "error", truncate(error.message, 400), lead.leadId);
    }
  }

  await onProgress?.(scrapedItems.length, scrapedItems.length, "Audit Agent");
  return reports;
}

function buildAudit(lead, scraped) {
  const text = `${scraped.title} ${scraped.metaDescription} ${scraped.homepageText}`.toLowerCase();
  const hasBooking = Boolean(scraped.bookingPageUrl);
  const hasContact = Boolean(scraped.contactPageUrl || scraped.visibleEmail || scraped.visiblePhone);
  const hasCtas = Boolean(scraped.ctaButtons);
  const hasTrust = Boolean(scraped.trustSignals);
  const hasMeta = Boolean(scraped.metaDescription && scraped.metaDescription.length > 50);
  const hasOffer = /service|treatment|pricing|membership|consultation|package|special|offer|med spa|facial|botox|laser|skin/i.test(
    text,
  );
  const hasRetention = /membership|loyalty|subscribe|follow-up|maintenance|package|rebook|series/i.test(
    text,
  );
  const hasReviews = /review|testimonial|rated|stars|before and after|gallery/i.test(text);
  const scrapeLimited = /could not be scraped|homepage returned http|homepage request failed|blocked automated fetch/i.test(
    text,
  );
  const hasUrgentTechnicalIssue = !scraped.title || scraped.homepageText.length < 400;

  const pros = [
    hasContact && "Visible contact path makes it easier for prospects to reach the business.",
    hasBooking && "There appears to be a booking or appointment path from the homepage.",
    hasTrust && `Trust signals are present: ${scraped.trustSignals}.`,
    hasMeta && "The page has a useful meta description for search and previews.",
    hasCtas && `The site uses action-oriented CTAs such as ${scraped.ctaButtons.split(" | ")[0]}.`,
  ].filter(Boolean);

  if (!pros.length) {
    pros.push(
      firstSentence(scraped.homepageText, "The website has enough public content to begin a practical conversion review."),
    );
  }

  const cons = [
    !hasBooking && "The booking path is not obvious from the homepage.",
    !hasContact && "Contact information is hard to detect from public page content.",
    !hasTrust && "Social proof is not prominent enough to quickly build trust.",
    !hasOffer && "The offer and service hierarchy could be clearer for first-time visitors.",
    !hasMeta && "The meta description is missing or too thin for a polished search preview.",
  ].filter(Boolean);

  const conversionIssues = [
    !hasCtas && "Primary next step is unclear because strong CTA buttons were not detected.",
    !hasBooking && "Interested visitors may need to hunt before they can schedule.",
    !hasOffer && "Visitors may not quickly understand which service or outcome to choose.",
  ].filter(Boolean);

  const ctaIssues = [
    !hasCtas && "Add one consistent primary CTA above the fold.",
    hasCtas && !/book|schedule|appointment|consult/i.test(scraped.ctaButtons) && "Existing CTAs do not strongly point toward booking or consultation.",
  ].filter(Boolean);

  const uxIssues = [
    scraped.homepageText.length > 4500 && "Homepage copy may be dense; key offers should be easier to scan.",
    scraped.homepageText.length < 700 && "Homepage content looks thin, which can make the business feel under-explained.",
    !hasContact && "Contact and location details should be easier to find without scrolling or guessing.",
  ].filter(Boolean);

  const trustIssues = [
    !hasReviews && "Reviews, testimonials, or result proof are not clearly visible.",
    !hasTrust && "Add recognizable trust proof near services and booking CTAs.",
  ].filter(Boolean);

  const offerClarity = hasOffer
    ? "The site mentions services or treatments, but the best entry offer should still be made obvious."
    : "The service menu or core offer is not clear enough from the homepage text.";

  const bookingFlowProblems = hasBooking
    ? "Booking exists, but it should be checked for friction, step count, mobile usability, and confirmation clarity."
    : "No clear booking page was detected, which likely creates avoidable scheduling friction.";

  const followUpRebookingOpportunity = hasRetention
    ? "There are signs of packages, memberships, or repeat-care language that can support rebooking."
    : "The site could do more to capture follow-up, rebooking, memberships, or maintenance plans.";

  const retentionRevenueLeaks = [
    !hasRetention && "Repeat-visit revenue is not clearly supported by memberships, packages, or rebooking prompts.",
    !/email|sms|newsletter|vip|membership/i.test(text) && "There is no obvious owned-list capture for leads who are not ready to book today.",
  ].filter(Boolean);

  const technicalIssues = [
    scrapeLimited && "The public website blocked or failed automated page access, so the audit used limited Google-profile data.",
    hasUrgentTechnicalIssue && "Public homepage content appears thin or title data could not be read.",
    !hasMeta && "Missing or weak meta description.",
  ].filter(Boolean);

  const score = clamp(
    35 +
      (hasBooking ? 15 : 0) +
      (hasContact ? 12 : 0) +
      (hasCtas ? 12 : 0) +
      (hasTrust ? 10 : 0) +
      (hasOffer ? 8 : 0) +
      (hasMeta ? 5 : 0) +
      (hasRetention ? 3 : 0),
    20,
    100,
  );

  const top5QuickFixes = [
    !hasCtas && "Add a single primary 'Book Consultation' CTA in the top navigation and hero.",
    !hasBooking && "Create or expose a direct booking page from every key service section.",
    !hasTrust && "Move reviews, testimonials, gallery, or credentials closer to the first booking CTA.",
    !hasOffer && "Clarify the main offer with outcome-focused service categories and one starter recommendation.",
    !hasRetention && "Add rebooking, package, or membership prompts after the first conversion step.",
    !hasMeta && "Rewrite the meta description around niche, location, and primary outcome.",
  ]
    .filter(Boolean)
    .slice(0, 5);

  while (top5QuickFixes.length < 5) {
    top5QuickFixes.push("Tighten above-the-fold copy so visitors understand who it is for, what to book, and why now.");
  }

  const recommendedServiceOffer = chooseRecommendedOffer({
    hasBooking,
    hasCtas,
    hasTrust,
    hasRetention,
  });

  return {
    pros: pros.join(" | "),
    cons: cons.join(" | "),
    conversionIssues: conversionIssues.join(" | "),
    ctaIssues: ctaIssues.join(" | "),
    uxIssues: uxIssues.join(" | "),
    trustIssues: trustIssues.join(" | "),
    offerClarity,
    bookingFlowProblems,
    followUpRebookingOpportunity,
    retentionRevenueLeaks: retentionRevenueLeaks.join(" | "),
    technicalIssues: technicalIssues.join(" | "),
    score,
    top5QuickFixes: top5QuickFixes.join(" | "),
    recommendedServiceOffer,
  };
}

function chooseRecommendedOffer(signals) {
  if (!signals.hasBooking || !signals.hasCtas) {
    return "Booking flow and conversion CTA cleanup";
  }
  if (!signals.hasTrust) {
    return "Trust proof and results-section upgrade";
  }
  if (!signals.hasRetention) {
    return "Retention, rebooking, and membership revenue lift";
  }
  return "Homepage conversion polish and follow-up capture";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
