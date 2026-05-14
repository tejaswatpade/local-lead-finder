import { id, nowIso } from "../utils/ids.js";
import { truncate } from "../utils/text.js";

export async function runOutreachDraftAgent(audits, context) {
  const { storage, log, runId, onProgress } = context;
  const drafts = [];

  for (let index = 0; index < audits.length; index += 1) {
    const item = audits[index];
    const { lead, audit } = item;
    await onProgress?.(index, audits.length, "Outreach Draft Agent");

    try {
      if (!hasEmail(lead) && !hasPhone(lead)) {
        await storage.updateById("Leads", "leadId", lead.leadId, {
          status: "Rejected",
          updatedAt: nowIso(),
          error: "No email or phone found for outreach.",
        });
        await log(
          "Outreach Draft Agent",
          "info",
          `Rejected ${lead.businessName}: no contact method found.`,
          lead.leadId,
        );
        continue;
      }

      await storage.updateById("Leads", "leadId", lead.leadId, {
        status: "Drafting Email",
        updatedAt: nowIso(),
      });
      await log("Outreach Draft Agent", "info", `Drafting email for ${lead.businessName}.`, lead.leadId);

      const draft = buildDraft(lead, audit);
      const phoneOnly = !hasEmail(lead) && hasPhone(lead);
      const record = {
        draftId: id("draft"),
        leadId: lead.leadId,
        runId,
        subject: draft.subject,
        body: draft.body,
        followUp: draft.followUp,
        status: phoneOnly ? "Phone Only" : "Pending Approval",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      await storage.append("EmailDrafts", record);
      await storage.updateById("Leads", "leadId", lead.leadId, {
        status: phoneOnly ? "Phone Only" : "Pending Approval",
        updatedAt: nowIso(),
        error: phoneOnly
          ? "Phone number found, but no email address was found for email approval."
          : "",
      });
      drafts.push({ lead, audit, draft: record });
      await log(
        "Outreach Draft Agent",
        "info",
        phoneOnly ? "Phone outreach copy ready." : "Draft ready for approval.",
        lead.leadId,
      );
    } catch (error) {
      await storage.updateById("Leads", "leadId", lead.leadId, {
        status: "Failed",
        updatedAt: nowIso(),
        error: truncate(error.message, 400),
      });
      await log("Outreach Draft Agent", "error", truncate(error.message, 400), lead.leadId);
    }
  }

  await onProgress?.(audits.length, audits.length, "Outreach Draft Agent");
  return drafts;
}

function hasEmail(lead) {
  return Boolean(String(lead.email || "").trim());
}

function hasPhone(lead) {
  return Boolean(String(lead.phone || "").trim());
}

function buildDraft(lead, audit) {
  const positive = firstListItem(audit.pros) || "your site makes the business easy to recognize";
  const issue =
    firstListItem(audit.conversionIssues) ||
    firstListItem(audit.ctaIssues) ||
    "the next step could be clearer for visitors";
  const fix =
    firstListItem(audit.top5QuickFixes) ||
    "tightening the booking CTA and first screen";

  const subject = `Quick idea for ${lead.businessName}`;
  const body = enforceWordLimit(
    `Hi ${lead.businessName} team, I liked that ${lowercaseFirst(
      positive,
    )} One thing I noticed: ${lowercaseFirst(
      issue,
    )} A focused update around ${lowercaseFirst(
      fix,
    )} could make the site easier for new visitors to act on. Want me to show what I'd change?`,
    120,
  );
  const followUp = enforceWordLimit(
    `Just wanted to bump this in case useful. I had one quick fix in mind for ${lead.businessName}'s booking path. Worth sending over the quick fix?`,
    120,
  );

  return { subject, body, followUp };
}

function firstListItem(value) {
  return String(value || "")
    .split("|")
    .map((item) => item.trim())
    .find(Boolean);
}

function lowercaseFirst(value) {
  const text = String(value || "").trim();
  return text ? `${text[0].toLowerCase()}${text.slice(1)}` : text;
}

function enforceWordLimit(value, maxWords) {
  const words = String(value || "").replace(/\s+/g, " ").trim().split(" ");
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ");
}
