import { fetchText, delay } from "../utils/http.js";
import {
  extractCtas,
  extractHomepageText,
  extractLinks,
  extractMetaDescription,
  extractTitle,
  extractTrustSignals,
  extractVisibleContact,
  findBookingPage,
  findContactPage,
} from "../utils/html.js";
import { id, nowIso } from "../utils/ids.js";
import { truncate, uniq } from "../utils/text.js";

export async function runScrapeAgent(leads, context) {
  const { storage, log, runId, onProgress, contactPreference = "any" } = context;
  const scraped = [];

  for (let index = 0; index < leads.length; index += 1) {
    const lead = leads[index];
    await onProgress?.(index, leads.length, "Scrape Agent");

    try {
      await storage.updateById("Leads", "leadId", lead.leadId, {
        status: "Scraping",
        updatedAt: nowIso(),
        error: "",
      });

      if (!lead.websiteUrl) {
        const record = {
          scrapedId: id("scrape"),
          leadId: lead.leadId,
          runId,
          title: lead.businessName,
          metaDescription: "",
          homepageText: [
            lead.businessName,
            lead.address || lead.location,
            lead.phone,
            lead.googleRating && `${lead.googleRating} rating`,
            lead.reviewCount && `${lead.reviewCount} reviews`,
            lead.acceptedReason,
            lead.websiteStatus,
          ]
            .filter(Boolean)
            .join(". "),
          contactPageUrl: "",
          bookingPageUrl: "",
          visibleEmail: lead.email || "",
          visiblePhone: lead.phone || "",
          ctaButtons: "",
          trustSignals: lead.googleRating ? "google rating" : "",
          status: "Scraped",
          createdAt: nowIso(),
        };

        await storage.append("ScrapedData", record);
        const updatedLead = await finishScrapedLead({
          storage,
          log,
          lead,
          record,
          contactPreference,
        });
        if (updatedLead) scraped.push({ lead: updatedLead, scraped: record });
        await log("Scrape Agent", "info", `Skipped website scrape for ${lead.businessName}: no official website found.`, lead.leadId);
        continue;
      }

      await log("Scrape Agent", "info", `Scraping ${lead.websiteUrl}.`, lead.leadId);

      const homepage = await fetchText(lead.websiteUrl, { timeoutMs: 8000 });
      if (!homepage.ok) {
        const record = fallbackScrapeRecord(
          lead,
          `Website could not be scraped because the homepage returned HTTP ${homepage.status}.`,
        );
        await storage.append("ScrapedData", record);
        const updatedLead = await finishScrapedLead({
          storage,
          log,
          lead,
          record,
          error: `Homepage returned HTTP ${homepage.status}`,
          contactPreference,
        });
        if (updatedLead) scraped.push({ lead: updatedLead, scraped: record });
        await log(
          "Scrape Agent",
          "warn",
          `Used limited Google-profile scrape for ${lead.businessName}: homepage returned HTTP ${homepage.status}.`,
          lead.leadId,
        );
        continue;
      }

      const links = extractLinks(homepage.text, homepage.url);
      const contactPageUrl = findContactPage(links);
      const bookingPageUrl = findBookingPage(links);
      const homeContact = extractVisibleContact(homepage.text);
      let contactEmails = [];
      let contactPhones = [];

      if (contactPageUrl && contactPageUrl !== homepage.url) {
        try {
          await delay(300);
          const contactPage = await fetchText(contactPageUrl, { timeoutMs: 8000 });
          if (contactPage.ok) {
            const contact = extractVisibleContact(contactPage.text);
            contactEmails = contact.emails;
            contactPhones = contact.phones;
          }
        } catch (error) {
          await log("Scrape Agent", "warn", `Contact page fetch failed: ${truncate(error.message, 160)}`, lead.leadId);
        }
      }

      const homepageText = extractHomepageText(homepage.text);
      const record = {
        scrapedId: id("scrape"),
        leadId: lead.leadId,
        runId,
        title: extractTitle(homepage.text),
        metaDescription: extractMetaDescription(homepage.text),
        homepageText,
        contactPageUrl,
        bookingPageUrl,
        visibleEmail: uniq([...homeContact.emails, ...contactEmails]).join(", "),
        visiblePhone: uniq([...homeContact.phones, ...contactPhones]).join(", "),
        ctaButtons: extractCtas(homepage.text, links).join(" | "),
        trustSignals: extractTrustSignals(homepage.text, homepageText).join(" | "),
        status: "Scraped",
        createdAt: nowIso(),
      };

      await storage.append("ScrapedData", record);
      const updatedLead = await finishScrapedLead({
        storage,
        log,
        lead,
        record,
        contactPreference,
      });
      if (updatedLead) scraped.push({ lead: updatedLead, scraped: record });
      await log("Scrape Agent", "info", `Scraped ${lead.businessName}.`, lead.leadId);
    } catch (error) {
      if (lead.websiteUrl) {
        const record = fallbackScrapeRecord(
          lead,
          `Website could not be scraped because the homepage request failed: ${truncate(error.message, 220)}.`,
        );
        await storage.append("ScrapedData", record);
        const updatedLead = await finishScrapedLead({
          storage,
          log,
          lead,
          record,
          error: truncate(error.message, 400),
          contactPreference,
        });
        if (updatedLead) scraped.push({ lead: updatedLead, scraped: record });
        await log(
          "Scrape Agent",
          "warn",
          `Used limited Google-profile scrape for ${lead.businessName}: ${truncate(error.message, 220)}.`,
          lead.leadId,
        );
        continue;
      }

      await storage.updateById("Leads", "leadId", lead.leadId, {
        status: "Failed",
        updatedAt: nowIso(),
        error: truncate(error.message, 400),
      });
      await log("Scrape Agent", "error", truncate(error.message, 400), lead.leadId);
    }
  }

  await onProgress?.(leads.length, leads.length, "Scrape Agent");
  return scraped;
}

async function finishScrapedLead({
  storage,
  log,
  lead,
  record,
  error = "",
  contactPreference = "any",
}) {
  const phone = lead.phone || record.visiblePhone || "";
  const email = lead.email || record.visibleEmail || "";
  const patch = {
    status: "Scraped",
    phone,
    email,
    contactPageUrl: lead.contactPageUrl || record.contactPageUrl,
    bookingPageUrl: lead.bookingPageUrl || record.bookingPageUrl,
    updatedAt: nowIso(),
    error,
  };

  const contactCheck = contactPreferenceCheck({ email, phone }, contactPreference);
  if (!contactCheck.ok) {
    await storage.updateById("Leads", "leadId", lead.leadId, {
      ...patch,
      status: "Rejected",
      error: contactCheck.message,
    });
    await log(
      "Scrape Agent",
      "warn",
      `Rejected ${lead.businessName}: ${contactCheck.message}`,
      lead.leadId,
    );
    return null;
  }

  const updated = await storage.updateById("Leads", "leadId", lead.leadId, patch);
  return updated || { ...lead, ...patch };
}

function hasContactMethod({ email, phone }) {
  return Boolean(String(email || "").trim() || String(phone || "").trim());
}

function contactPreferenceCheck(contact, preference) {
  const email = String(contact.email || "").trim();
  const phone = String(contact.phone || "").trim();
  const normalized = String(preference || "any").toLowerCase();

  if (normalized === "email") {
    return email
      ? { ok: true, message: "" }
      : { ok: false, message: "Campaign requires email, but no email address was found." };
  }

  if (normalized === "email_phone") {
    return email && phone
      ? { ok: true, message: "" }
      : {
          ok: false,
          message: "Campaign requires email + phone, but both contact methods were not found.",
        };
  }

  return hasContactMethod(contact)
    ? { ok: true, message: "" }
    : {
        ok: false,
        message: "No email or phone found after checking Google profile and website.",
      };
}

function fallbackScrapeRecord(lead, reason) {
  return {
    scrapedId: id("scrape"),
    leadId: lead.leadId,
    runId: lead.runId,
    title: lead.businessName,
    metaDescription: "",
    homepageText: [
      lead.businessName,
      lead.address || lead.location,
      lead.phone,
      lead.googleRating && `${lead.googleRating} Google rating`,
      lead.reviewCount && `${lead.reviewCount} Google reviews`,
      lead.acceptedReason,
      reason,
    ]
      .filter(Boolean)
      .join(". "),
    contactPageUrl: lead.contactPageUrl || "",
    bookingPageUrl: lead.bookingPageUrl || "",
    visibleEmail: lead.email || "",
    visiblePhone: lead.phone || "",
    ctaButtons: "",
    trustSignals: lead.googleRating ? "google rating" : "",
    status: "Scraped",
    createdAt: nowIso(),
  };
}
