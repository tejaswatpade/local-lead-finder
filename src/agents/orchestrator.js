import { runLeadDiscoveryAgent } from "./discovery.js";
import { id, nowIso } from "../utils/ids.js";

const MAX_LEADS_PER_CAMPAIGN = 100;
const DISCOVERY_BATCH_SIZE = MAX_LEADS_PER_CAMPAIGN;

export class OutreachOrchestrator {
  constructor(storage) {
    this.storage = storage;
    this.activeRuns = new Map();
    this.stopRequests = new Set();
    this.stopCheckCache = new Map();
  }

  getActiveRuns() {
    return [...this.activeRuns.values()];
  }

  async startCampaign(input, options = {}) {
    const campaign = validateCampaign(input);
    const run = {
      runId: id("run"),
      userEmail: campaign.userEmail,
      niche: campaign.niche,
      location: campaign.location,
      locationLat: campaign.locationLat,
      locationLng: campaign.locationLng,
      leadCount: campaign.leadCount,
      radiusKm: campaign.radiusKm,
      reviewFilterEnabled: campaign.reviewFilterEnabled,
      minReviews: campaign.minReviews,
      maxReviews: campaign.maxReviews,
      searchDepth: campaign.searchDepth,
      websiteFilter: campaign.websiteFilter,
      visibilityFilter: campaign.visibilityFilter,
      opportunityFilter: campaign.opportunityFilter,
      contactPreference: campaign.contactPreference,
      notes: campaign.notes,
      status: "Running",
      currentStep: "Queued",
      progressDone: 0,
      progressTotal: campaign.leadCount,
      rawResultsFound: 0,
      duplicatesRemoved: 0,
      irrelevantRejected: 0,
      qualifiedLeads: 0,
      removedByReviewFilter: 0,
      removedByRelevanceFilter: 0,
      removedByVisibilityFilter: 0,
      removedByWebsiteFilter: 0,
      removedByOpportunityFilter: 0,
      removedAsDuplicate: 0,
      enrichedWithPlaceDetails: 0,
      finalQualifiedLeads: 0,
      discoveryMessage: "Discovery has not started yet.",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    await this.storage.append("AgentRuns", run);
    this.activeRuns.set(run.runId, run);

    const runTask = this.runCampaign(run, campaign).catch(async (error) => {
        await this.failRun(run.runId, error);
    });
    if (typeof options.waitUntil === "function") {
      options.waitUntil(runTask);
    } else {
      queueMicrotask(() => runTask);
    }

    return run;
  }

  async continueCampaign(runId, options = {}) {
    const run = await this.storage.findById("AgentRuns", "runId", runId);
    if (!run) throw new Error("Campaign run not found.");
    if (isTruthy(run.stopRequested)) return run;

    const active = this.activeRuns.get(runId);
    if (active) return active;

    const summary = await this.leadSummary(runId);
    const requestedTotal = Number(run.leadCount || 0);
    if (summary.usable >= requestedTotal) {
      return this.completeRun(run, summary, requestedTotal);
    }

    const updated = await this.updateRun(runId, {
      status: "Running",
      currentStep: "Continuing search",
      progressDone: summary.usable,
      progressTotal: requestedTotal,
      discoveryMessage: `Continuing search from ${summary.usable}/${requestedTotal} qualified leads.`,
    });

    const campaign = campaignFromRun(updated || run);
    const runTask = this.runCampaign(updated || run, campaign, {
      continuation: true,
    }).catch(async (error) => {
      await this.failRun(runId, error);
    });

    if (typeof options.waitUntil === "function") {
      options.waitUntil(runTask);
    } else {
      queueMicrotask(() => runTask);
    }

    return updated || run;
  }

  async stopCampaign(runId, userEmail = "") {
    const run = await this.storage.findById("AgentRuns", "runId", runId);
    if (!run) throw new Error("Campaign run not found.");
    if (userEmail && normalizeEmail(run.userEmail) !== normalizeEmail(userEmail)) {
      throw new Error("Campaign run not found.");
    }

    this.stopRequests.add(runId);
    this.stopCheckCache.set(runId, { checkedAt: Date.now(), value: true });
    const summary = await this.leadSummary(runId);
    const requestedTotal = Number(run.leadCount || run.progressTotal || 0);
    const updated = await this.updateRun(runId, {
      status: "Stopped",
      currentStep: "Stopped by user",
      stopRequested: true,
      progressDone: summary.usable,
      progressTotal: Math.max(requestedTotal, summary.usable),
      qualifiedLeads: summary.usable,
      finalQualifiedLeads: summary.usable,
      discoveryMessage: `Search stopped by user at ${summary.usable}/${Math.max(requestedTotal, summary.usable)} qualified leads.`,
    });
    await this.log(
      runId,
      "System",
      "warn",
      `Search stopped by user at ${summary.usable}/${Math.max(requestedTotal, summary.usable)} qualified leads.`,
    );
    this.activeRuns.delete(runId);
    return updated || run;
  }

  async runCampaign(run, campaign, options = {}) {
    await this.log(
      run.runId,
      "System",
      "info",
      options.continuation ? "Continuing campaign search." : "Campaign started.",
    );
    const usage = createUsageBuffer();
    const requestedTotal = Number(run.leadCount || campaign.leadCount);
    const beforeSummary = await this.leadSummary(run.runId);
    const remaining = Math.max(0, requestedTotal - beforeSummary.usable);

    if (!remaining) {
      await this.completeRun(run, beforeSummary, requestedTotal);
      return;
    }

    if (await this.isStopRequested(run.runId)) {
      await this.applyStoppedRun(run, beforeSummary, requestedTotal);
      return;
    }

    const batchLeadCount = Math.min(remaining, DISCOVERY_BATCH_SIZE);
    const baseCounters = {
      rawResultsFound: Number(run.rawResultsFound || 0),
      duplicatesRemoved: Number(run.duplicatesRemoved || 0),
      irrelevantRejected: Number(run.irrelevantRejected || 0),
      removedByReviewFilter: Number(run.removedByReviewFilter || 0),
      removedByRelevanceFilter: Number(run.removedByRelevanceFilter || 0),
      removedByVisibilityFilter: Number(run.removedByVisibilityFilter || 0),
      removedByWebsiteFilter: Number(run.removedByWebsiteFilter || 0),
      removedByOpportunityFilter: Number(run.removedByOpportunityFilter || 0),
      removedAsDuplicate: Number(run.removedAsDuplicate || 0),
      enrichedWithPlaceDetails: Number(run.enrichedWithPlaceDetails || 0),
    };

    const context = {
      storage: this.storage,
      runId: run.runId,
      userEmail: campaign.userEmail,
      log: (agent, level, message, leadId = "") =>
        this.log(run.runId, agent, level, message, leadId),
      updateRun: (runId, patch) =>
        this.updateRun(runId, aggregateRunPatch(patch, beforeSummary.usable, requestedTotal, baseCounters)),
      contactPreference: campaign.contactPreference,
      shouldStop: () => this.isStopRequested(run.runId),
      trackUsage: (type, count = 1, metadata = {}) =>
        usage.track(type, count, metadata),
      onProgress: (done, total, step) =>
        this.updateRun(run.runId, {
          currentStep: displayStep(step),
          progressDone: beforeSummary.usable + done,
          progressTotal: requestedTotal || total,
        }),
    };

    try {
      await this.updateRun(run.runId, {
        status: "Running",
        currentStep: "Finding leads",
        progressDone: beforeSummary.usable,
        progressTotal: requestedTotal,
        discoveryMessage: `Searching batch of ${batchLeadCount}. ${beforeSummary.usable}/${requestedTotal} qualified leads saved so far.`,
      });
      const leads = await runLeadDiscoveryAgent({ ...campaign, leadCount: batchLeadCount }, context);
      const afterSummary = await this.leadSummary(run.runId);
      const newLeadCount = Math.max(0, afterSummary.usable - beforeSummary.usable);

      if (await this.isStopRequested(run.runId)) {
        await this.applyStoppedRun(run, afterSummary, requestedTotal);
      } else if (afterSummary.usable >= requestedTotal) {
        await this.completeRun(run, afterSummary, requestedTotal);
      } else if (!leads.length || !newLeadCount) {
        await this.updateRun(run.runId, {
          status: "Completed With Filters",
          currentStep: "No more qualified leads",
          progressDone: afterSummary.usable,
          progressTotal: requestedTotal,
          qualifiedLeads: afterSummary.usable,
          finalQualifiedLeads: afterSummary.usable,
          discoveryMessage: `Found ${afterSummary.usable} qualified leads after exhausting the available search results.`,
        });
        await this.log(
          run.runId,
          "System",
          "info",
          `Search exhausted at ${afterSummary.usable}/${requestedTotal} qualified leads.`,
        );
        this.activeRuns.delete(run.runId);
      } else {
        await this.updateRun(run.runId, {
          status: "Continuing",
          currentStep: "Next batch ready",
          progressDone: afterSummary.usable,
          progressTotal: requestedTotal,
          qualifiedLeads: afterSummary.usable,
          finalQualifiedLeads: afterSummary.usable,
          discoveryMessage: `Found ${afterSummary.usable}/${requestedTotal}. Continuing automatically for the next batch.`,
        });
        await this.log(
          run.runId,
          "System",
          "info",
          `Batch complete. ${afterSummary.usable}/${requestedTotal} qualified leads saved; next batch will continue automatically.`,
        );
        this.activeRuns.delete(run.runId);
      }
    } finally {
      try {
        await this.flushUsage(run.runId, campaign.userEmail, usage);
      } catch (error) {
        console.error("Usage tracking failed:", error.message);
      }
    }
  }

  async completeRun(run, summary, requestedTotal) {
    const status = summary.failed ? "Completed With Failures" : "Completed";
    const currentStep = summary.usable ? "Complete" : "No qualified leads";
    const updated = await this.updateRun(run.runId, {
      status,
      currentStep,
      progressDone: summary.usable,
      progressTotal: Math.max(requestedTotal, summary.usable),
      qualifiedLeads: summary.usable,
      finalQualifiedLeads: summary.usable,
      discoveryMessage: summary.usable >= requestedTotal
        ? `Found ${summary.usable} qualified leads.`
        : `Found ${summary.usable} qualified leads after filtering irrelevant results.`,
    });
    await this.log(
      run.runId,
      "System",
      "info",
      `Campaign complete. ${summary.emailReady} email-ready leads, ${summary.phoneOnly} phone-only leads, and ${summary.failed} rejected or failed leads.`,
    );
    this.activeRuns.delete(run.runId);
    return updated || run;
  }

  async applyStoppedRun(run, summary, requestedTotal) {
    const updated = await this.updateRun(run.runId, {
      status: "Stopped",
      currentStep: "Stopped by user",
      stopRequested: true,
      progressDone: summary.usable,
      progressTotal: Math.max(requestedTotal, summary.usable),
      qualifiedLeads: summary.usable,
      finalQualifiedLeads: summary.usable,
      discoveryMessage: `Search stopped by user at ${summary.usable}/${Math.max(requestedTotal, summary.usable)} qualified leads.`,
    });
    this.activeRuns.delete(run.runId);
    return updated || run;
  }

  async leadSummary(runId) {
    const runLeads = (await this.storage.list("Leads")).filter((lead) => lead.runId === runId);
    const failed = runLeads.filter((lead) => ["Rejected", "Failed"].includes(lead.status)).length;
    return {
      total: runLeads.length,
      usable: runLeads.length - failed,
      failed,
      phoneOnly: runLeads.filter((lead) => lead.status === "Phone Only").length,
      emailReady: runLeads.filter((lead) => lead.status === "Pending Approval").length,
    };
  }

  async updateRun(runId, patch) {
    const updated = await this.storage.updateById("AgentRuns", "runId", runId, {
      ...patch,
      updatedAt: nowIso(),
    });

    if (updated) this.activeRuns.set(runId, updated);
    return updated;
  }

  async isStopRequested(runId) {
    if (this.stopRequests.has(runId)) return true;
    const active = this.activeRuns.get(runId);
    if (isTruthy(active?.stopRequested)) return true;

    const cached = this.stopCheckCache.get(runId);
    if (cached && Date.now() - cached.checkedAt < 1500) return cached.value;

    const stored = await this.storage.findById("AgentRuns", "runId", runId);
    if (isTruthy(stored?.stopRequested)) {
      this.stopRequests.add(runId);
      this.stopCheckCache.set(runId, { checkedAt: Date.now(), value: true });
      return true;
    }
    this.stopCheckCache.set(runId, { checkedAt: Date.now(), value: false });
    return false;
  }

  async failRun(runId, error) {
    await this.updateRun(runId, {
      status: "Failed",
      currentStep: "Failed",
      discoveryMessage: error.message || String(error),
    });
    await this.log(runId, "System", "error", error.message || String(error));
    this.activeRuns.delete(runId);
  }

  async log(runId, agent, level, message, leadId = "") {
    const record = {
      logId: id("log"),
      runId,
      agent,
      level,
      message,
      leadId,
      createdAt: nowIso(),
    };
    await this.storage.append("AgentLogs", record);
    return record;
  }

  async flushUsage(runId, userEmail, usage) {
    const entries = usage.entries();
    if (!entries.length) return;

    for (const entry of entries) {
      await this.storage.append("UsageEvents", {
        eventId: id("usage"),
        runId,
        userEmail: userEmail || "",
        type: entry.type,
        provider: entry.provider,
        count: entry.count,
        metadata: entry.metadata,
        createdAt: nowIso(),
      });
    }
  }
}

function displayStep(step) {
  const map = {
    "Lead Discovery Agent": "Finding leads",
    "Searching places": "Searching places",
    "Filtering leads": "Filtering leads",
    "Enriching contacts": "Enriching contacts",
    "Scanning websites": "Scanning websites",
    "Scrape Agent": "Checking websites and contacts",
    "Audit Agent": "Reviewing websites",
    "Outreach Draft Agent": "Preparing emails",
  };
  return map[step] || step || "Working";
}

function validateCampaign(input) {
  const niche = String(input.niche || "").trim();
  const location = String(input.location || "").trim();
  const leadCount = Number(input.leadCount || input.numberOfLeads || 0);
  const radiusKm = Number(input.radiusKm || input.radius || 15);
  const reviewFilterEnabled = boolInput(
    input.reviewFilterEnabled ?? input.review_filter_enabled,
    false,
  );
  const minReviews = Number(input.minReviews ?? input.min_reviews ?? 0);
  const maxReviews = Number(input.maxReviews ?? input.max_reviews ?? 1000000);
  const locationLat = optionalCoordinate(input.locationLat ?? input.location_lat);
  const locationLng = optionalCoordinate(input.locationLng ?? input.location_lng);
  const contactPreference = normalizeContactPreference(
    input.contactPreference ?? input.contact_preference ?? "any",
  );
  const searchDepth = normalizeSearchDepth(input.searchDepth ?? input.search_depth ?? "smart");
  const websiteFilter = normalizeWebsiteFilter(input.websiteFilter ?? input.website_filter ?? "any");
  const visibilityFilter = normalizeVisibilityFilter(input.visibilityFilter ?? input.visibility_filter ?? "any");
  const opportunityFilter = normalizeOpportunityFilter(input.opportunityFilter ?? input.opportunity_filter ?? "any");
  const notes = String(input.notes || "").trim();
  const userEmail = String(input.userEmail || input.user_email || "").trim().toLowerCase();

  if (!niche) throw new Error("Niche is required.");
  if (!location) throw new Error("Location is required.");
  if (!Number.isInteger(leadCount) || leadCount < 1 || leadCount > MAX_LEADS_PER_CAMPAIGN) {
    throw new Error(`Lead count must be an integer from 1 to ${MAX_LEADS_PER_CAMPAIGN}.`);
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 50) {
    throw new Error("Radius must be greater than 0 and no more than 50 km.");
  }
  if (reviewFilterEnabled && (!Number.isInteger(minReviews) || minReviews < 0)) {
    throw new Error("Min reviews must be a non-negative integer.");
  }
  if (reviewFilterEnabled && (!Number.isInteger(maxReviews) || maxReviews < minReviews)) {
    throw new Error("Max reviews must be an integer greater than or equal to min reviews.");
  }
  if ((locationLat === null) !== (locationLng === null)) {
    throw new Error("Map pin must include both latitude and longitude.");
  }

  return {
    niche,
    location,
    locationLat,
    locationLng,
    leadCount,
    radiusKm,
    reviewFilterEnabled,
    minReviews,
    maxReviews,
    searchDepth,
    websiteFilter,
    visibilityFilter,
    opportunityFilter,
    contactPreference,
    notes,
    userEmail,
  };
}

function campaignFromRun(run) {
  return {
    userEmail: run.userEmail || "",
    niche: run.niche || "",
    location: run.location || "",
    locationLat: run.locationLat,
    locationLng: run.locationLng,
    leadCount: Number(run.leadCount || 0),
    radiusKm: Number(run.radiusKm || 15),
    reviewFilterEnabled: boolInput(run.reviewFilterEnabled, false),
    minReviews: Number(run.minReviews || 0),
    maxReviews: Number(run.maxReviews || 1000000),
    searchDepth: normalizeSearchDepth(run.searchDepth || "smart"),
    websiteFilter: normalizeWebsiteFilter(run.websiteFilter || "any"),
    visibilityFilter: normalizeVisibilityFilter(run.visibilityFilter || "any"),
    opportunityFilter: normalizeOpportunityFilter(run.opportunityFilter || "any"),
    contactPreference: normalizeContactPreference(run.contactPreference || "any"),
    notes: run.notes || "",
  };
}

function aggregateRunPatch(patch, existingQualifiedCount, requestedTotal, baseCounters) {
  const adjusted = { ...patch };
  if ("progressDone" in adjusted) {
    adjusted.progressDone = existingQualifiedCount + Number(adjusted.progressDone || 0);
  }
  if ("progressTotal" in adjusted) {
    adjusted.progressTotal = requestedTotal || adjusted.progressTotal;
  }
  if ("qualifiedLeads" in adjusted) {
    adjusted.qualifiedLeads = existingQualifiedCount + Number(adjusted.qualifiedLeads || 0);
  }
  if ("finalQualifiedLeads" in adjusted) {
    adjusted.finalQualifiedLeads = existingQualifiedCount + Number(adjusted.finalQualifiedLeads || 0);
  }
  for (const key of [
    "rawResultsFound",
    "duplicatesRemoved",
    "irrelevantRejected",
    "removedByReviewFilter",
    "removedByRelevanceFilter",
    "removedByVisibilityFilter",
    "removedByWebsiteFilter",
    "removedByOpportunityFilter",
    "removedAsDuplicate",
    "enrichedWithPlaceDetails",
  ]) {
    if (key in adjusted) adjusted[key] = Number(baseCounters[key] || 0) + Number(adjusted[key] || 0);
  }
  return adjusted;
}

function boolInput(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function optionalCoordinate(value) {
  if (value === "" || value === undefined || value === null) return null;
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate)) throw new Error("Map pin coordinates are invalid.");
  return coordinate;
}

function normalizeContactPreference(value) {
  const normalized = String(value || "any").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (["email", "email_only"].includes(normalized)) return "email";
  if (["email_phone", "email_and_phone", "email_plus_phone", "both"].includes(normalized)) {
    return "email_phone";
  }
  return "any";
}

function normalizeSearchDepth(value) {
  const normalized = String(value || "smart").trim().toLowerCase();
  if (normalized === "fast") return "fast";
  if (["deep", "exhaustive"].includes(normalized)) return "deep";
  return "smart";
}

function normalizeWebsiteFilter(value) {
  const normalized = String(value || "any").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (["has_website", "official_website"].includes(normalized)) return "has_website";
  if (["no_website", "google_profile_only"].includes(normalized)) return "no_website";
  if (["weak_website", "bad_website"].includes(normalized)) return "weak_website";
  return "any";
}

function normalizeVisibilityFilter(value) {
  const normalized = String(value || "any").trim().toLowerCase();
  if (["low", "medium", "high"].includes(normalized)) return normalized;
  return "any";
}

function normalizeOpportunityFilter(value) {
  const normalized = String(value || "any").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (["high_rating_low_reviews", "rating_review_gap"].includes(normalized)) return "high_rating_low_reviews";
  if (["no_booking", "no_booking_page"].includes(normalized)) return "no_booking";
  if (["no_contact", "no_contact_page"].includes(normalized)) return "no_contact";
  if (["no_website", "google_profile_only"].includes(normalized)) return "no_website";
  return "any";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isTruthy(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function createUsageBuffer() {
  const usage = new Map();
  return {
    track(type, count = 1, metadata = {}) {
      const normalizedType = String(type || "unknown").trim() || "unknown";
      const current = usage.get(normalizedType) || {
        type: normalizedType,
        provider: usageProvider(normalizedType),
        count: 0,
        metadata: {},
      };
      current.count += Number(count) || 1;
      current.metadata = { ...current.metadata, ...metadata };
      usage.set(normalizedType, current);
    },
    entries() {
      return [...usage.values()].filter((entry) => entry.count > 0);
    },
  };
}

function usageProvider(type) {
  if (type.startsWith("google_")) return "Google";
  if (type.includes("cache")) return "Cache";
  return "System";
}
