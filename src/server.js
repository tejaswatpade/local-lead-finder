import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { runAuditAgent } from "./agents/audit.js";
import { runOutreachDraftAgent } from "./agents/draft.js";
import { OutreachOrchestrator } from "./agents/orchestrator.js";
import { runScrapeAgent } from "./agents/scrape.js";
import { createStorage } from "./storage/index.js";
import { id, nowIso } from "./utils/ids.js";
import { normalizeUrl, truncate } from "./utils/text.js";

const storage = createStorage();
const orchestrator = new OutreachOrchestrator(storage);
const PUBLIC_DIR = path.join(config.rootDir, "public");
const SESSION_COOKIE = "openclaw_admin";
const OAUTH_STATE_COOKIE = "openclaw_oauth_state";
const DEV_SESSION_COOKIE = "local_lead_dev";
const STALE_RUNNING_RUN_MS = 7 * 60 * 1000;
const MAX_LEADS_PER_CAMPAIGN = 100;
let storageReady;

const CREDIT_PRICING = {
  discoverySearch: 50,
  unlockLead: 25,
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function main() {
  if (!config.googleOAuth.clientId || !config.googleOAuth.clientSecret) {
    console.warn(
      "Google sign-in is not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET before using the dashboard.",
    );
  }

  await ensureStorage();
  await markInterruptedRuns();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error(error);
      const status = Number(error.status || 500);
      sendJson(res, status, {
        error: status === 500 ? "Internal server error" : error.message,
        detail: error.message,
      });
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(
      `Local Lead Finder running at http://${config.host}:${config.port}/dashboard`,
    );
  });
}

async function ensureStorage() {
  storageReady ||= storage.ensure();
  return storageReady;
}

async function markInterruptedRuns() {
  const runs = await storage.list("AgentRuns");
  const running = runs.filter((run) => run.status === "Running");
  if (!running.length) return;

  const updatedAt = nowIso();
  for (const run of running) {
    await storage.updateById("AgentRuns", "runId", run.runId, {
      status: "Failed",
      currentStep: "Interrupted",
      discoveryMessage:
        "This run stopped when the local server restarted. Start a new campaign to run discovery again.",
      updatedAt,
    });
    await storage.append("AgentLogs", {
      logId: id("log"),
      runId: run.runId,
      agent: "System",
      level: "error",
      message:
        "Marked stale running campaign as failed because the local server restarted before the agent completed.",
      leadId: "",
      createdAt: updatedAt,
    });
  }
}

async function markStaleHostedRuns(userEmail = "") {
  const runs = await storage.list("AgentRuns");
  const email = normalizeEmail(userEmail);
  const cutoff = Date.now() - STALE_RUNNING_RUN_MS;
  const running = runs.filter((run) => {
    if (run.status !== "Running") return false;
    if (email && normalizeEmail(run.userEmail) !== email) return false;
    const lastUpdate = Date.parse(run.updatedAt || run.createdAt || "");
    return Number.isFinite(lastUpdate) && lastUpdate < cutoff;
  });
  if (!running.length) return;

  const activeIds = new Set(orchestrator.getActiveRuns().map((run) => run.runId));
  const leads = await storage.list("Leads");
  const updatedAt = nowIso();

  for (const run of running) {
    if (activeIds.has(run.runId)) continue;

    const runLeads = leads.filter((lead) => lead.runId === run.runId);
    const usableLeads = runLeads.filter((lead) => !["Rejected", "Failed"].includes(lead.status));
    const failedCount = runLeads.length - usableLeads.length;
    const requestedTotal = Math.max(numberValue(run.leadCount), runLeads.length);
    const reachedTarget = requestedTotal > 0 && usableLeads.length >= requestedTotal;
    const status = reachedTarget ? "Completed" : "Stopped";
    const message = reachedTarget
      ? `Found ${usableLeads.length} qualified leads.`
      : usableLeads.length
        ? "The hosted worker paused before the requested count was reached. Keep the dashboard open and it will continue automatically."
        : "The hosted worker paused before finding usable leads. Keep the dashboard open to retry, or widen filters if it stops again.";

    await storage.updateById("AgentRuns", "runId", run.runId, {
      status,
      currentStep: reachedTarget ? "Complete" : usableLeads.length ? "Stopped early" : "Stopped with no leads",
      progressDone: usableLeads.length,
      progressTotal: requestedTotal,
      qualifiedLeads: usableLeads.length,
      finalQualifiedLeads: usableLeads.length,
      discoveryMessage: message,
      updatedAt,
    });
    await storage.append("AgentLogs", {
      logId: id("log"),
      runId: run.runId,
      agent: "System",
      level: failedCount ? "warn" : "error",
      message,
      leadId: "",
      createdAt: updatedAt,
    });
  }
}

export async function handleRequest(req, res, options = {}) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/") {
    return serveFile(res, path.join(PUBLIC_DIR, "index.html"));
  }

  const publicPage = publicPageFile(url.pathname);
  if (req.method === "GET" && publicPage) {
    return serveFile(res, path.join(PUBLIC_DIR, publicPage));
  }

  if (req.method === "GET" && url.pathname === "/login") {
    if (isAuthed(req)) return redirect(res, "/dashboard");
    return serveFile(res, path.join(PUBLIC_DIR, "login.html"));
  }

  if (req.method === "GET" && url.pathname === "/dev") {
    const file = isDevAuthed(req) ? "dev.html" : "dev-login.html";
    return serveFile(res, path.join(PUBLIC_DIR, file));
  }

  if (req.method === "POST" && url.pathname === "/api/dev/login") {
    return handleDevLogin(req, res);
  }

  if (url.pathname.startsWith("/api/dev/")) {
    if (!isDevAuthed(req)) return sendJson(res, 401, { error: "Unauthorized" });
    await ensureStorage();
    return handleDevApi(req, res, url);
  }

  if (req.method === "GET" && url.pathname === "/api/auth/google") {
    return startGoogleAuth(req, res);
  }

  if (req.method === "GET" && url.pathname === "/api/auth/google/callback") {
    return finishGoogleAuth(req, res, url);
  }

  if (req.method === "GET" && url.pathname === "/dashboard") {
    if (!isAuthed(req)) return redirect(res, "/login");
    return serveFile(res, path.join(PUBLIC_DIR, "dashboard.html"));
  }

  if (req.method === "GET" && isPublicAsset(url.pathname)) {
    return servePublicAsset(res, url.pathname);
  }

  if (url.pathname.startsWith("/api/")) {
    if (!isAuthed(req)) return sendJson(res, 401, { error: "Unauthorized" });
    await ensureStorage();
    return handleApi(req, res, url, options);
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function handleDevLogin(req, res) {
  const body = await readJson(req);
  const password = String(body.password || "");

  if (!config.devDashboardPassword) {
    return sendJson(res, 503, {
      error: "DEV_DASHBOARD_PASSWORD is not configured.",
    });
  }

  if (!timingSafeEqual(password, config.devDashboardPassword)) {
    return sendJson(res, 401, { error: "Wrong password." });
  }

  res.setHeader(
    "set-cookie",
    `${DEV_SESSION_COOKIE}=${createDevSessionToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800`,
  );
  return sendJson(res, 200, { ok: true });
}

async function handleDevApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/dev/logout") {
    clearDevSession(res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/dev/state") {
    await markStaleHostedRuns();
    return sendJson(res, 200, await buildDevState(url.searchParams));
  }

  return sendJson(res, 404, { error: "Dev API route not found" });
}

async function handleApi(req, res, url, options = {}) {
  if (req.method === "POST" && url.pathname === "/api/logout") {
    clearSession(res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/export/pending-approval.csv") {
    const session = currentSession(req) || {};
    const account = await ensureUserAccount(session);
    const [leads, auditReports, emailDrafts] = await Promise.all([
      storage.list("Leads"),
      storage.list("AuditReports"),
      storage.list("EmailDrafts"),
    ]);
    const unlocks = await storage.list("LeadUnlocks");
    const userLeadIds = await accessibleLeadIdsForUser(account.email);
    const access = unlockAccessMap(unlocks, account.email);
    const owner = isOwnerEmail(account.email);

    const leadsById = new Map(leads.map((lead) => [lead.leadId, lead]));
    const auditsByLeadId = new Map(
      auditReports.map((audit) => [audit.leadId, audit]),
    );
    const pendingDrafts = emailDrafts.filter((draft) => {
      const lead = leadsById.get(draft.leadId) || {};
      const leadAccess = accessForLead(access, draft.leadId, owner);
      return (
        userLeadIds.has(draft.leadId) &&
        draft.status === "Pending Approval" &&
        hasEmailAccess(leadAccess) &&
        String(lead.email || "").trim()
      );
    });

    const rows = pendingDrafts.map((draft) => {
      const lead = leadsById.get(draft.leadId) || {};
      const audit = auditsByLeadId.get(draft.leadId) || {};
      const leadAccess = accessForLead(access, draft.leadId, owner);
      return {
        leadId: lead.leadId || draft.leadId,
        businessName: lead.businessName || "",
        websiteUrl: lead.websiteUrl || "",
        phone: hasPhoneAccess(leadAccess) ? lead.phone || "" : "",
        email: hasEmailAccess(leadAccess) ? lead.email || "" : "",
        address: lead.address || lead.location || "",
        googleRating: lead.googleRating || "",
        reviewCount: lead.reviewCount || "",
        googleMapsUrl: lead.googleMapsUrl || "",
        googlePlaceId: lead.googlePlaceId || "",
        relevanceScore: lead.relevanceScore || "",
        visibilityScore: lead.visibilityScore || "",
        visibilityTier: lead.visibilityTier || "",
        opportunityFlags: lead.opportunityFlags || "",
        leadStatus: lead.status || "",
        niche: lead.niche || "",
        notes: lead.notes || "",
        auditScore: hasAuditAccess(leadAccess) ? audit.score || "" : "",
        recommendedServiceOffer: hasAuditAccess(leadAccess) ? audit.recommendedServiceOffer || "" : "",
        subject: hasCopyAccess(leadAccess) ? draft.subject || "" : "",
        emailBody: hasCopyAccess(leadAccess) ? draft.body || "" : "",
        followUp: hasCopyAccess(leadAccess) ? draft.followUp || "" : "",
        draftStatus: draft.status || "",
        draftCreatedAt: draft.createdAt || "",
        leadCreatedAt: lead.createdAt || "",
      };
    });

    return sendCsv(res, `local-lead-finder-pending-approvals-${dateStamp()}.csv`, rows);
  }

  if (req.method === "GET" && url.pathname === "/api/export/contact-leads.csv") {
    const session = currentSession(req) || {};
    const account = await ensureUserAccount(session);
    const [leads, auditReports, emailDrafts] = await Promise.all([
      storage.list("Leads"),
      storage.list("AuditReports"),
      storage.list("EmailDrafts"),
    ]);
    const unlocks = await storage.list("LeadUnlocks");
    const userLeadIds = await accessibleLeadIdsForUser(account.email);
    const access = unlockAccessMap(unlocks, account.email);
    const owner = isOwnerEmail(account.email);
    const auditsByLeadId = new Map(auditReports.map((audit) => [audit.leadId, audit]));
    const draftsByLeadId = new Map(emailDrafts.map((draft) => [draft.leadId, draft]));
    const rows = leads
      .filter((lead) => {
        const leadAccess = accessForLead(access, lead.leadId, owner);
        const unlockedEmail = hasEmailAccess(leadAccess) && String(lead.email || "").trim();
        const unlockedPhone = hasPhoneAccess(leadAccess) && String(lead.phone || "").trim();
        const hasContact = unlockedEmail || unlockedPhone;
        return userLeadIds.has(lead.leadId) && hasContact && !["Rejected", "Failed"].includes(lead.status);
      })
      .map((lead) => {
        const audit = auditsByLeadId.get(lead.leadId) || {};
        const draft = draftsByLeadId.get(lead.leadId) || {};
        const leadAccess = accessForLead(access, lead.leadId, owner);
        return {
          leadId: lead.leadId || "",
          businessName: lead.businessName || "",
          websiteUrl: lead.websiteUrl || "",
          email: hasEmailAccess(leadAccess) ? lead.email || "" : "",
          phone: hasPhoneAccess(leadAccess) ? lead.phone || "" : "",
          contactType: contactType({
            email: hasEmailAccess(leadAccess) ? lead.email : "",
            phone: hasPhoneAccess(leadAccess) ? lead.phone : "",
          }),
          address: lead.address || lead.location || "",
          googleRating: lead.googleRating || "",
          reviewCount: lead.reviewCount || "",
          googleMapsUrl: lead.googleMapsUrl || "",
          googlePlaceId: lead.googlePlaceId || "",
          relevanceScore: lead.relevanceScore || "",
          visibilityScore: lead.visibilityScore || "",
          visibilityTier: lead.visibilityTier || "",
          opportunityFlags: lead.opportunityFlags || "",
          leadStatus: lead.status || "",
          niche: lead.niche || "",
          notes: lead.notes || "",
          auditScore: hasAuditAccess(leadAccess) ? audit.score || "" : "",
          recommendedServiceOffer: hasAuditAccess(leadAccess) ? audit.recommendedServiceOffer || "" : "",
          subject: hasCopyAccess(leadAccess) ? draft.subject || "" : "",
          emailBody: hasCopyAccess(leadAccess) ? draft.body || "" : "",
          followUp: hasCopyAccess(leadAccess) ? draft.followUp || "" : "",
          leadCreatedAt: lead.createdAt || "",
        };
      });

    return sendCsv(res, `local-lead-finder-contact-leads-${dateStamp()}.csv`, rows);
  }

  if (req.method === "GET" && url.pathname === "/api/maps/config") {
    return sendJson(res, 200, {
      googleMapsBrowserKey: config.maps.browserKey,
      enabled: Boolean(config.maps.browserKey),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const session = currentSession(req) || {};
    const account = await ensureUserAccount(session);
    await markStaleHostedRuns(account.email);
    const [leads, auditReports, emailDrafts, agentRuns, agentLogs, unlocks] =
      await Promise.all([
        storage.list("Leads"),
        storage.list("AuditReports"),
        storage.list("EmailDrafts"),
        storage.list("AgentRuns"),
        storage.list("AgentLogs"),
        storage.list("LeadUnlocks"),
      ]);
    const userRuns = agentRuns.filter((run) => normalizeEmail(run.userEmail) === account.email);
    const activeStoredRuns = userRuns.filter((run) => run.status === "Running");
    const activeMemoryRuns = orchestrator
      .getActiveRuns()
      .filter((run) => normalizeEmail(run.userEmail) === account.email);
    const activeRunsById = new Map(
      [...activeStoredRuns, ...activeMemoryRuns].map((run) => [run.runId, run]),
    );
    const runIds = new Set(userRuns.map((run) => run.runId));
    const userLeads = leads.filter((lead) => runIds.has(lead.runId));
    const leadIds = new Set(userLeads.map((lead) => lead.leadId));
    const access = unlockAccessMap(unlocks, account.email);
    const owner = isOwnerEmail(account.email);

    return sendJson(res, 200, {
      activeRuns: [...activeRunsById.values()].sort(
        (a, b) => Date.parse(a.updatedAt || a.createdAt || 0) - Date.parse(b.updatedAt || b.createdAt || 0),
      ),
      credits: {
        balance: numberValue(account.creditsBalance),
        pricing: CREDIT_PRICING,
        owner,
      },
      leads: userLeads.map((lead) => sanitizeLeadForUser(lead, accessForLead(access, lead.leadId, owner))),
      scrapedData: [],
      auditReports: auditReports
        .filter((audit) => leadIds.has(audit.leadId))
        .map((audit) => sanitizeAuditForUser(audit, accessForLead(access, audit.leadId, owner))),
      emailDrafts: emailDrafts
        .filter((draft) => leadIds.has(draft.leadId))
        .map((draft) => sanitizeDraftForUser(draft, accessForLead(access, draft.leadId, owner))),
      agentRuns: userRuns,
      agentLogs: [],
    });
  }

  if (req.method === "POST" && url.pathname === "/api/campaigns") {
    const body = await readJson(req);
    const session = currentSession(req) || {};
    const account = await ensureUserAccount(session);
    const requestedLeadCount = Number(body.leadCount || body.numberOfLeads || 0);
    const preflightError = campaignPreflightError(body, requestedLeadCount);
    if (preflightError) return sendJson(res, 400, { error: preflightError });
    if (!config.search.googlePlacesApiKey || !config.search.googleGeocodingApiKey) {
      return sendJson(res, 503, {
        error: "Lead discovery is not configured. No credits were charged.",
      });
    }
    const discoveryCost = discoveryCreditCost(requestedLeadCount);
    const owner = isOwnerEmail(account.email);
    const spend = owner
      ? null
      : await spendCredits(account.email, discoveryCost, {
          type: "discovery",
          reason: `${requestedLeadCount} requested leads`,
        });
    try {
      const run = await orchestrator.startCampaign({
        ...body,
        userEmail: account.email,
      }, {
        waitUntil: options.waitUntil,
      });
      if (spend?.transactionId) {
        await storage.updateById("CreditTransactions", "transactionId", spend.transactionId, {
          runId: run.runId,
        });
      }
      return sendJson(res, 202, { run });
    } catch (error) {
      if (!owner) {
        await refundCredits(account.email, discoveryCost, {
          type: "discovery_refund",
          reason: `Campaign did not start: ${error.message}`,
        });
      }
      throw error;
    }
  }

  const continueRunAction = url.pathname.match(/^\/api\/runs\/([^/]+)\/continue$/);
  if (req.method === "POST" && continueRunAction) {
    const [, runId] = continueRunAction;
    const session = currentSession(req) || {};
    const account = await ensureUserAccount(session);
    const run = await storage.findById("AgentRuns", "runId", runId);
    if (!run || normalizeEmail(run.userEmail) !== account.email) {
      return sendJson(res, 404, { error: "Campaign run not found." });
    }

    const continuedRun = await orchestrator.continueCampaign(runId, {
      waitUntil: options.waitUntil,
    });
    return sendJson(res, 202, { run: continuedRun });
  }

  const stopRunAction = url.pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
  if (req.method === "POST" && stopRunAction) {
    const [, runId] = stopRunAction;
    const session = currentSession(req) || {};
    const account = await ensureUserAccount(session);
    const run = await storage.findById("AgentRuns", "runId", runId);
    if (!run || normalizeEmail(run.userEmail) !== account.email) {
      return sendJson(res, 404, { error: "Campaign run not found." });
    }

    const stoppedRun = await orchestrator.stopCampaign(runId, account.email);
    return sendJson(res, 200, { run: stoppedRun });
  }

  const unlockAction = url.pathname.match(/^\/api\/leads\/([^/]+)\/unlock$/);
  if (req.method === "POST" && unlockAction) {
    const [, leadId] = unlockAction;
    const body = await readJson(req);
    const feature = normalizeUnlockFeature(body.feature);
    if (!feature) return sendJson(res, 400, { error: "Unknown unlock feature." });

    const session = currentSession(req) || {};
    const account = await ensureUserAccount(session);
    if (feature === "audit") await ensureAuditForLead(account.email, leadId);
    if (feature === "copy") await ensureDraftForLead(account.email, leadId);
    const result = await unlockLeadFeature(account.email, leadId, feature);
    return sendJson(res, 200, result);
  }

  const leadContacted = url.pathname.match(/^\/api\/leads\/([^/]+)\/contacted$/);
  if (req.method === "POST" && leadContacted) {
    const [, leadId] = leadContacted;
    const lead = await storage.findById("Leads", "leadId", leadId);
    if (!lead) return sendJson(res, 404, { error: "Lead not found." });

    const updated = await storage.updateById("Leads", "leadId", leadId, {
      status: "Contacted",
      updatedAt: nowIso(),
    });
    return sendJson(res, 200, { lead: updated });
  }

  if (req.method === "POST" && url.pathname === "/api/leads/manual") {
    const body = await readJson(req);
    const websiteUrl = normalizeUrl(body.websiteUrl);
    const businessName = String(body.businessName || "").trim();
    if (!businessName || !websiteUrl) {
      return sendJson(res, 400, { error: "Business name and website URL are required." });
    }

    const lead = {
      leadId: id("lead"),
      runId: "manual",
      businessName,
      websiteUrl,
      location: String(body.location || "").trim(),
      address: String(body.address || body.location || "").trim(),
      phone: String(body.phone || "").trim(),
      email: String(body.email || "").trim(),
      googleRating: String(body.googleRating || "").trim(),
      reviewCount: String(body.reviewCount || "").trim(),
      googlePlaceId: String(body.googlePlaceId || "").trim(),
      googleMapsUrl: String(body.googleMapsUrl || "").trim(),
      contactPageUrl: String(body.contactPageUrl || "").trim(),
      bookingPageUrl: String(body.bookingPageUrl || "").trim(),
      relevanceScore: String(body.relevanceScore || "").trim(),
      acceptedReason: String(body.acceptedReason || "Manual fallback").trim(),
      websiteStatus: String(body.websiteStatus || "Manual fallback").trim(),
      visibilityScore: String(body.visibilityScore || "").trim(),
      visibilityTier: String(body.visibilityTier || "").trim(),
      searchPoint: String(body.searchPoint || "").trim(),
      searchRank: String(body.searchRank || "").trim(),
      opportunityFlags: String(body.opportunityFlags || "").trim(),
      sourceUrl: String(body.sourceUrl || websiteUrl).trim(),
      status: "New",
      niche: String(body.niche || "").trim(),
      notes: String(body.notes || "Manual fallback").trim(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      error: "",
    };

    await storage.append("Leads", lead);
    return sendJson(res, 201, { lead });
  }

  if (req.method === "POST" && url.pathname === "/api/leads/import") {
    const body = await readJson(req);
    const rows = parseLeadImport(String(body.csv || ""));
    const created = [];

    for (const row of rows) {
      const websiteUrl = normalizeUrl(row.websiteUrl);
      const businessName = String(row.businessName || "").trim();
      if (!businessName || !websiteUrl) continue;

      const lead = {
        leadId: id("lead"),
        runId: "manual-import",
        businessName,
        websiteUrl,
        location: String(row.location || "").trim(),
        address: String(row.address || row.location || "").trim(),
        phone: String(row.phone || "").trim(),
        email: String(row.email || "").trim(),
        googleRating: String(row.googleRating || "").trim(),
        reviewCount: String(row.reviewCount || "").trim(),
        googlePlaceId: String(row.googlePlaceId || "").trim(),
        googleMapsUrl: String(row.googleMapsUrl || "").trim(),
        contactPageUrl: String(row.contactPageUrl || "").trim(),
        bookingPageUrl: String(row.bookingPageUrl || "").trim(),
        relevanceScore: String(row.relevanceScore || "").trim(),
        acceptedReason: String(row.acceptedReason || "Imported fallback").trim(),
        websiteStatus: String(row.websiteStatus || "Imported fallback").trim(),
        visibilityScore: String(row.visibilityScore || "").trim(),
        visibilityTier: String(row.visibilityTier || "").trim(),
        searchPoint: String(row.searchPoint || "").trim(),
        searchRank: String(row.searchRank || "").trim(),
        opportunityFlags: String(row.opportunityFlags || "").trim(),
        sourceUrl: String(row.sourceUrl || websiteUrl).trim(),
        status: "New",
        niche: String(row.niche || "").trim(),
        notes: "Imported fallback",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        error: "",
      };
      await storage.append("Leads", lead);
      created.push(lead);
    }

    return sendJson(res, 201, { imported: created.length, leads: created });
  }

  if (req.method === "POST" && url.pathname === "/api/drafts/clear-pending") {
    const drafts = await storage.list("EmailDrafts");
    const pending = drafts.filter((draft) => draft.status === "Pending Approval");
    const updatedAt = nowIso();

    for (const draft of pending) {
      await storage.updateById("EmailDrafts", "draftId", draft.draftId, {
        status: "Rejected",
        updatedAt,
      });
      await storage.updateById("Leads", "leadId", draft.leadId, {
        status: "Rejected",
        updatedAt,
      });
    }

    return sendJson(res, 200, { cleared: pending.length });
  }

  const draftAction = url.pathname.match(/^\/api\/drafts\/([^/]+)\/(approve|reject)$/);
  if (req.method === "POST" && draftAction) {
    const [, draftId, action] = draftAction;
    const draft = await storage.findById("EmailDrafts", "draftId", draftId);
    if (!draft) return sendJson(res, 404, { error: "Draft not found." });

    const status = action === "approve" ? "Approved" : "Rejected";
    const updatedDraft = await storage.updateById("EmailDrafts", "draftId", draftId, {
      status,
      updatedAt: nowIso(),
    });
    await storage.updateById("Leads", "leadId", draft.leadId, {
      status,
      updatedAt: nowIso(),
    });
    return sendJson(res, 200, { draft: updatedDraft });
  }

  const draftEdit = url.pathname.match(/^\/api\/drafts\/([^/]+)$/);
  if (req.method === "PATCH" && draftEdit) {
    const [, draftId] = draftEdit;
    const draft = await storage.findById("EmailDrafts", "draftId", draftId);
    if (!draft) return sendJson(res, 404, { error: "Draft not found." });

    const body = await readJson(req);
    const patch = {
      subject: truncate(body.subject, 180),
      body: truncate(body.body, 1200),
      followUp: truncate(body.followUp, 1200),
      status: "Pending Approval",
      updatedAt: nowIso(),
    };
    const updatedDraft = await storage.updateById(
      "EmailDrafts",
      "draftId",
      draftId,
      patch,
    );
    await storage.updateById("Leads", "leadId", draft.leadId, {
      status: "Pending Approval",
      updatedAt: nowIso(),
    });
    return sendJson(res, 200, { draft: updatedDraft });
  }

  return sendJson(res, 404, { error: "API route not found" });
}

async function buildDevState(params = new URLSearchParams()) {
  const [users, runs, leads, usageEvents, placeCache, creditTransactions] = await Promise.all([
    storage.list("Users"),
    storage.list("AgentRuns"),
    storage.list("Leads"),
    storage.list("UsageEvents"),
    storage.list("PlaceCache"),
    storage.list("CreditTransactions"),
  ]);

  const usersByEmail = new Map(users.map((user) => [normalizeEmail(user.email), user]));
  const usersRange = normalizeDateRange(params.get("usersRange"));
  const apiRange = normalizeDateRange(params.get("apiRange"));
  const runsRange = normalizeDateRange(params.get("runsRange"));
  const runsUser = normalizeEmail(params.get("runsUser"));
  const usersStart = dateRangeStart(usersRange);
  const apiStart = dateRangeStart(apiRange);
  const runsStart = dateRangeStart(runsRange);
  const runsForUsers = runs.filter((run) => isWithinRange(run.updatedAt || run.createdAt, usersStart));
  const usageForUsers = usageEvents.filter((event) => isWithinRange(event.createdAt, usersStart));
  const apiUsageEvents = usageEvents.filter((event) => isWithinRange(event.createdAt, apiStart));
  const emails = new Set();
  for (const user of users) {
    const email = normalizeEmail(user.email);
    if (email && isWithinRange(user.lastSeenAt || user.lastLoginAt || user.firstSeenAt, usersStart)) {
      emails.add(email);
    }
  }
  for (const run of runsForUsers) if (normalizeEmail(run.userEmail)) emails.add(normalizeEmail(run.userEmail));
  for (const event of usageForUsers) if (normalizeEmail(event.userEmail)) emails.add(normalizeEmail(event.userEmail));

  const userRows = [...emails].sort().map((email) => {
    const user = usersByEmail.get(email) || {};
    const userRuns = runsForUsers.filter((run) => normalizeEmail(run.userEmail) === email);
    const runIds = new Set(userRuns.map((run) => run.runId));
    const userLeads = leads.filter((lead) => runIds.has(lead.runId));
    const userEvents = usageForUsers.filter((event) => normalizeEmail(event.userEmail) === email);
    return {
      email,
      name: user.name || "",
      status: user.status || "Active",
      creditsBalance: numberValue(user.creditsBalance),
      lifetimeCreditsUsed: numberValue(user.lifetimeCreditsUsed),
      loginCount: numberValue(user.loginCount),
      campaigns: userRuns.length,
      leads: userLeads.length,
      qualifiedLeads: userLeads.filter((lead) => !["Rejected", "Failed"].includes(lead.status)).length,
      googleApiCalls: googleApiCallCount(userEvents),
      cacheHits: usageCount(userEvents, "google_place_details_cache_hit"),
      lastSeenAt: latestDate([
        user.lastSeenAt,
        user.lastLoginAt,
        ...userRuns.map((run) => run.updatedAt || run.createdAt),
      ]),
    };
  });

  const apiByType = aggregateUsageByType(apiUsageEvents);
  const recentRuns = [...runs]
    .filter((run) => isWithinRange(run.updatedAt || run.createdAt, runsStart))
    .filter((run) => !runsUser || normalizeEmail(run.userEmail) === runsUser)
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
    .slice(0, 30)
    .map((run) => ({
      runId: run.runId,
      userEmail: run.userEmail || "",
      niche: run.niche || "",
      location: run.location || "",
      status: run.status || "",
      currentStep: run.currentStep || "",
      leadCount: numberValue(run.leadCount),
      qualifiedLeads: numberValue(run.qualifiedLeads || run.finalQualifiedLeads),
      rawResultsFound: numberValue(run.rawResultsFound),
      createdAt: run.createdAt || "",
      updatedAt: run.updatedAt || "",
    }));

  return {
    generatedAt: nowIso(),
    totals: {
      users: userRows.length,
      campaigns: runs.length,
      leads: leads.length,
      qualifiedLeads: leads.filter((lead) => !["Rejected", "Failed"].includes(lead.status)).length,
      googleApiCalls: googleApiCallCount(usageEvents),
      cacheHits: usageCount(usageEvents, "google_place_details_cache_hit"),
      cachedPlaces: placeCache.length,
      creditsInCirculation: users.reduce((sum, user) => sum + numberValue(user.creditsBalance), 0),
      creditsSpent: creditTransactions
        .filter((transaction) => numberValue(transaction.credits) < 0)
        .reduce((sum, transaction) => sum + Math.abs(numberValue(transaction.credits)), 0),
    },
    users: userRows,
    availableUsers: [...new Set([
      ...users.map((user) => normalizeEmail(user.email)),
      ...runs.map((run) => normalizeEmail(run.userEmail)),
      ...usageEvents.map((event) => normalizeEmail(event.userEmail)),
    ])].filter(Boolean).sort(),
    apiByType,
    recentRuns,
    filters: {
      usersRange,
      apiRange,
      runsRange,
      runsUser,
    },
  };
}

function startGoogleAuth(req, res) {
  if (!config.googleOAuth.clientId || !config.googleOAuth.clientSecret) {
    return redirect(res, "/login?error=google-not-configured");
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", config.googleOAuth.clientId);
  authUrl.searchParams.set("redirect_uri", googleRedirectUri(req));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");

  return redirect(res, authUrl.toString(), {
    "set-cookie": `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600`,
  });
}

async function finishGoogleAuth(req, res, url) {
  const error = url.searchParams.get("error");
  if (error) return redirectLoginError(res, "google-cancelled");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const savedState = parseCookies(req.headers.cookie || "")[OAUTH_STATE_COOKIE];
  if (!code || !state || !savedState || state !== savedState) {
    return redirectLoginError(res, "invalid-state");
  }

  try {
    const token = await exchangeGoogleCode(code, googleRedirectUri(req));
    const profile = await fetchGoogleProfile(token.access_token);
    const email = String(profile.email || "").trim().toLowerCase();

    if (!email || profile.email_verified !== true) {
      return redirectLoginError(res, "email-not-verified");
    }

    const allowed = config.googleOAuth.allowedEmails;
    if (allowed.length && !allowed.includes(email)) {
      return redirectLoginError(res, "not-allowed");
    }

    await recordUserLogin({
      email,
      name: String(profile.name || "").trim(),
      picture: String(profile.picture || "").trim(),
    });

    res.setHeader(
      "set-cookie",
      [
        `${SESSION_COOKIE}=${createSessionToken({
          email,
          name: String(profile.name || "").trim(),
          picture: String(profile.picture || "").trim(),
        })}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800`,
        `${OAUTH_STATE_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
      ],
    );
    return redirect(res, "/dashboard");
  } catch (authError) {
    console.error("Google sign-in failed:", authError.message);
    return redirectLoginError(res, "google-failed");
  }
}

async function exchangeGoogleCode(code, redirectUri) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleOAuth.clientId,
      client_secret: config.googleOAuth.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google token exchange failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function fetchGoogleProfile(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google profile fetch failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function recordUserLogin(user) {
  await ensureStorage();
  const email = normalizeEmail(user.email);
  if (!email) return;

  const timestamp = nowIso();
  const existing = await storage.findById("Users", "email", email);
  const defaultCredits = defaultCreditGrant();
  const hasCreditBalance =
    existing && existing.creditsBalance !== undefined && existing.creditsBalance !== "";
  const record = {
    email,
    name: user.name || existing?.name || "",
    picture: user.picture || existing?.picture || "",
    status: "Active",
    creditsBalance: hasCreditBalance ? numberValue(existing.creditsBalance) : defaultCredits,
    lifetimeCreditsUsed: numberValue(existing?.lifetimeCreditsUsed),
    lifetimeCreditsAdded: hasCreditBalance
      ? numberValue(existing?.lifetimeCreditsAdded)
      : numberValue(existing?.lifetimeCreditsAdded) + defaultCredits,
    firstSeenAt: existing?.firstSeenAt || timestamp,
    lastSeenAt: timestamp,
    lastLoginAt: timestamp,
    loginCount: numberValue(existing?.loginCount) + 1,
  };

  if (existing) {
    await storage.updateById("Users", "email", email, record);
    if (!hasCreditBalance && defaultCredits > 0) {
      await storage.append("CreditTransactions", {
        transactionId: id("credit"),
        userEmail: email,
        type: "grant",
        credits: defaultCredits,
        balanceAfter: defaultCredits,
        leadId: "",
        runId: "",
        reason: "User credit balance initialized",
        createdAt: timestamp,
      });
    }
  } else {
    await storage.append("Users", record);
    if (defaultCredits > 0) {
      await storage.append("CreditTransactions", {
        transactionId: id("credit"),
        userEmail: email,
        type: "grant",
        credits: defaultCredits,
        balanceAfter: defaultCredits,
        leadId: "",
        runId: "",
        reason: "New user credit grant",
        createdAt: timestamp,
      });
    }
  }
}

async function ensureUserAccount(session = {}) {
  await ensureStorage();
  const email = normalizeEmail(session.email);
  if (!email) {
    const error = new Error("Signed-in user email is missing.");
    error.status = 401;
    throw error;
  }

  const timestamp = nowIso();
  const existing = await storage.findById("Users", "email", email);
  if (existing && existing.creditsBalance !== undefined && existing.creditsBalance !== "") {
    return existing;
  }

  const defaultCredits = defaultCreditGrant();
  const record = {
    email,
    name: session.name || existing?.name || "",
    picture: session.picture || existing?.picture || "",
    status: existing?.status || "Active",
    creditsBalance: existing ? defaultCredits : defaultCredits,
    lifetimeCreditsUsed: numberValue(existing?.lifetimeCreditsUsed),
    lifetimeCreditsAdded: numberValue(existing?.lifetimeCreditsAdded) + defaultCredits,
    firstSeenAt: existing?.firstSeenAt || timestamp,
    lastSeenAt: timestamp,
    lastLoginAt: existing?.lastLoginAt || timestamp,
    loginCount: numberValue(existing?.loginCount),
  };

  if (existing) {
    await storage.updateById("Users", "email", email, record);
  } else {
    await storage.append("Users", record);
  }

  if (defaultCredits > 0) {
    await storage.append("CreditTransactions", {
      transactionId: id("credit"),
      userEmail: email,
      type: "grant",
      credits: defaultCredits,
      balanceAfter: defaultCredits,
      leadId: "",
      runId: "",
      reason: existing ? "User credit balance initialized" : "New user credit grant",
      createdAt: timestamp,
    });
  }

  return record;
}

async function spendCredits(userEmail, credits, details = {}) {
  const email = normalizeEmail(userEmail);
  const amount = Math.max(0, Number(credits) || 0);
  const account = await storage.findById("Users", "email", email);
  const balance = numberValue(account?.creditsBalance);
  if (!account) {
    const error = new Error("User account not found.");
    error.status = 401;
    throw error;
  }
  if (amount > balance) {
    const error = new Error(`Not enough credits. You need ${amount} credits and have ${balance}.`);
    error.status = 402;
    throw error;
  }

  const nextBalance = balance - amount;
  await storage.updateById("Users", "email", email, {
    creditsBalance: nextBalance,
    lifetimeCreditsUsed: numberValue(account.lifetimeCreditsUsed) + amount,
    updatedAt: nowIso(),
  });

  const transaction = {
    transactionId: id("credit"),
    userEmail: email,
    type: details.type || "spend",
    credits: -amount,
    balanceAfter: nextBalance,
    leadId: details.leadId || "",
    runId: details.runId || "",
    reason: details.reason || "",
    createdAt: nowIso(),
  };
  await storage.append("CreditTransactions", transaction);
  return transaction;
}

async function refundCredits(userEmail, credits, details = {}) {
  const email = normalizeEmail(userEmail);
  const amount = Math.max(0, Number(credits) || 0);
  if (!amount) return null;

  const account = await storage.findById("Users", "email", email);
  if (!account) return null;

  const nextBalance = numberValue(account.creditsBalance) + amount;
  await storage.updateById("Users", "email", email, {
    creditsBalance: nextBalance,
    lifetimeCreditsAdded: numberValue(account.lifetimeCreditsAdded) + amount,
    updatedAt: nowIso(),
  });

  const transaction = {
    transactionId: id("credit"),
    userEmail: email,
    type: details.type || "refund",
    credits: amount,
    balanceAfter: nextBalance,
    leadId: details.leadId || "",
    runId: details.runId || "",
    reason: details.reason || "",
    createdAt: nowIso(),
  };
  await storage.append("CreditTransactions", transaction);
  return transaction;
}

async function ensureAuditForLead(userEmail, leadId) {
  const lead = await leadForUserOrThrow(userEmail, leadId);
  const existingAudits = await storage.list("AuditReports");
  const existing = latestByCreatedAt(existingAudits.filter((audit) => audit.leadId === leadId));
  if (existing) return existing;

  const context = singleLeadContext(lead.runId, userEmail);
  const scrapedItems = await ensureScrapedForLead(lead, context);
  const audits = await runAuditAgent(scrapedItems, context);
  const created = audits[0]?.audit;
  if (created) return created;

  const refreshedAudits = await storage.list("AuditReports");
  const fallback = latestByCreatedAt(refreshedAudits.filter((audit) => audit.leadId === leadId));
  if (fallback) return fallback;

  const error = new Error("Audit could not be generated for this lead.");
  error.status = 500;
  throw error;
}

async function ensureDraftForLead(userEmail, leadId) {
  const existingDrafts = await storage.list("EmailDrafts");
  const existing = latestByCreatedAt(existingDrafts.filter((draft) => draft.leadId === leadId && draft.body));
  if (existing) return existing;

  const audit = await ensureAuditForLead(userEmail, leadId);
  const lead = await leadForUserOrThrow(userEmail, leadId);
  const context = singleLeadContext(lead.runId, userEmail);
  const drafts = await runOutreachDraftAgent([{ lead, audit }], context);
  const created = drafts[0]?.draft;
  if (created) return created;

  const refreshedDrafts = await storage.list("EmailDrafts");
  const fallback = latestByCreatedAt(refreshedDrafts.filter((draft) => draft.leadId === leadId && draft.body));
  if (fallback) return fallback;

  const error = new Error("Outreach copy could not be generated for this lead.");
  error.status = 500;
  throw error;
}

async function ensureScrapedForLead(lead, context) {
  const existingScrapes = await storage.list("ScrapedData");
  const existing = latestByCreatedAt(existingScrapes.filter((scrape) => scrape.leadId === lead.leadId));
  if (existing) return [{ lead, scraped: existing }];

  const scraped = await runScrapeAgent([lead], context);
  if (scraped.length) return scraped;

  const refreshedLead = (await storage.findById("Leads", "leadId", lead.leadId)) || lead;
  const fallback = {
    scrapedId: id("scrape"),
    leadId: refreshedLead.leadId,
    runId: refreshedLead.runId,
    title: refreshedLead.businessName || "",
    metaDescription: "",
    homepageText: [
      refreshedLead.businessName,
      refreshedLead.address || refreshedLead.location,
      refreshedLead.websiteUrl,
      refreshedLead.phone,
      refreshedLead.email,
      refreshedLead.googleRating && `${refreshedLead.googleRating} Google rating`,
      refreshedLead.reviewCount && `${refreshedLead.reviewCount} Google reviews`,
      refreshedLead.acceptedReason,
      refreshedLead.websiteStatus,
      "Website audit generated from saved lead data because the background campaign stopped early.",
    ]
      .filter(Boolean)
      .join(". "),
    contactPageUrl: refreshedLead.contactPageUrl || "",
    bookingPageUrl: refreshedLead.bookingPageUrl || "",
    visibleEmail: refreshedLead.email || "",
    visiblePhone: refreshedLead.phone || "",
    ctaButtons: "",
    trustSignals: refreshedLead.googleRating ? "google rating" : "",
    status: "Scraped",
    createdAt: nowIso(),
  };
  await storage.append("ScrapedData", fallback);
  await storage.updateById("Leads", "leadId", refreshedLead.leadId, {
    status: "Scraped",
    updatedAt: nowIso(),
    error: "",
  });
  return [{ lead: refreshedLead, scraped: fallback }];
}

async function leadForUserOrThrow(userEmail, leadId) {
  const lead = await storage.findById("Leads", "leadId", leadId);
  if (!lead) {
    const error = new Error("Lead not found.");
    error.status = 404;
    throw error;
  }

  const userLeadIds = await accessibleLeadIdsForUser(userEmail);
  if (!userLeadIds.has(leadId)) {
    const error = new Error("Lead does not belong to this user.");
    error.status = 404;
    throw error;
  }
  return lead;
}

function singleLeadContext(runId, userEmail) {
  return {
    storage,
    runId,
    userEmail,
    contactPreference: "any",
    log: async (agent, level, message, leadId = "") => {
      await storage.append("AgentLogs", {
        logId: id("log"),
        runId,
        agent,
        level,
        message: truncate(message, 400),
        leadId,
        createdAt: nowIso(),
      });
    },
    onProgress: async () => {},
    updateRun: async () => {},
    trackUsage: () => {},
  };
}

async function unlockLeadFeature(userEmail, leadId, feature) {
  const email = normalizeEmail(userEmail);
  const owner = isOwnerEmail(email);
  const lead = await storage.findById("Leads", "leadId", leadId);
  if (!lead) {
    const error = new Error("Lead not found.");
    error.status = 404;
    throw error;
  }

  const userLeadIds = await accessibleLeadIdsForUser(email);
  if (!userLeadIds.has(leadId)) {
    const error = new Error("Lead does not belong to this user.");
    error.status = 404;
    throw error;
  }

  const [unlocks, audits, drafts] = await Promise.all([
    storage.list("LeadUnlocks"),
    storage.list("AuditReports"),
    storage.list("EmailDrafts"),
  ]);
  const accessMap = unlockAccessMap(unlocks, email);
  const access = accessForLead(accessMap, leadId, owner);
  if (feature === "copy") {
    const hasEmailContact = String(lead.email || "").trim();
    const hasPhoneContact = String(lead.phone || "").trim();
    const canUseEmail = hasEmailContact && hasEmailAccess(access);
    const canUsePhone = hasPhoneContact && hasPhoneAccess(access);
    if (!canUseEmail && !canUsePhone) {
      const error = new Error("Unlock Lead before generating copy.");
      error.status = 400;
      throw error;
    }
  }
  validateUnlockAvailability(feature, lead, audits, drafts);
  const cost = unlockCreditCost(feature, access);

  if (cost > 0 && !owner) {
    await spendCredits(email, cost, {
      type: "unlock_lead",
      leadId,
      runId: lead.runId || "",
      reason: unlockLabel(feature),
    });
    await storage.append("LeadUnlocks", {
      unlockId: `${email}:${leadId}:lead`,
      userEmail: email,
      leadId,
      feature: "lead",
      creditsCharged: cost,
      createdAt: nowIso(),
    });
    access.add("lead");
  }

  const account = await storage.findById("Users", "email", email);
  const audit = latestByCreatedAt(audits.filter((item) => item.leadId === leadId));
  const draft = latestByCreatedAt(drafts.filter((item) => item.leadId === leadId));
  return {
    credits: {
      balance: numberValue(account?.creditsBalance),
      charged: owner ? 0 : cost,
      owner,
    },
    lead: sanitizeLeadForUser(lead, access),
    audit: audit ? sanitizeAuditForUser(audit, access) : null,
    draft: draft ? sanitizeDraftForUser(draft, access) : null,
  };
}

function validateUnlockAvailability(feature, lead, audits, drafts) {
  if (feature === "email" && !String(lead.email || "").trim()) {
    const error = new Error("No email is available for this lead.");
    error.status = 400;
    throw error;
  }
  if (
    feature === "lead" &&
    !String(lead.email || lead.websiteUrl || lead.googleMapsUrl || lead.phone || lead.businessName || "").trim()
  ) {
    const error = new Error("No lead details are available for this record.");
    error.status = 400;
    throw error;
  }
  if (feature === "phone" && !String(lead.phone || "").trim()) {
    const error = new Error("No phone number is available for this lead.");
    error.status = 400;
    throw error;
  }
  if (feature === "audit" && !audits.some((audit) => audit.leadId === lead.leadId)) {
    const error = new Error("No audit is available for this lead yet.");
    error.status = 400;
    throw error;
  }
  if (feature === "copy" && !drafts.some((draft) => draft.leadId === lead.leadId && draft.body)) {
    const error = new Error("No email copy is available for this lead yet.");
    error.status = 400;
    throw error;
  }
}

function unlockCreditCost(feature, access) {
  return hasFullLeadAccess(access) ? 0 : CREDIT_PRICING.unlockLead;
}

function normalizeUnlockFeature(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (["email", "unlock_email"].includes(normalized)) return "email";
  if (["lead", "unlock_lead", "details"].includes(normalized)) return "lead";
  if (["phone", "reveal_phone"].includes(normalized)) return "phone";
  if (["audit", "view_audit"].includes(normalized)) return "audit";
  if (["copy", "email_copy", "generate_email_copy"].includes(normalized)) return "copy";
  return "";
}

function unlockLabel(feature) {
  return "Unlock Lead";
}

function discoveryCreditCost(leadCount) {
  return CREDIT_PRICING.discoverySearch;
}

function campaignPreflightError(body, requestedLeadCount) {
  const niche = String(body.niche || "").trim();
  const location = String(body.location || "").trim();
  const radiusKm = Number(body.radiusKm || body.radius || 15);
  const reviewFilterEnabled = boolInput(body.reviewFilterEnabled ?? body.review_filter_enabled, false);
  const minReviews = Number(body.minReviews ?? body.min_reviews ?? 0);
  const maxReviews = Number(body.maxReviews ?? body.max_reviews ?? 1000000);
  const locationLat = body.locationLat ?? body.location_lat;
  const locationLng = body.locationLng ?? body.location_lng;
  if (!niche) return "Niche is required.";
  if (!location) return "Location is required.";
  if (
    !Number.isInteger(requestedLeadCount) ||
    requestedLeadCount < 1 ||
    requestedLeadCount > MAX_LEADS_PER_CAMPAIGN
  ) {
    return `Lead count must be an integer from 1 to ${MAX_LEADS_PER_CAMPAIGN}.`;
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 50) {
    return "Radius must be greater than 0 and no more than 50 km.";
  }
  if (reviewFilterEnabled && (!Number.isInteger(minReviews) || minReviews < 0)) {
    return "Min reviews must be a non-negative integer.";
  }
  if (reviewFilterEnabled && (!Number.isInteger(maxReviews) || maxReviews < minReviews)) {
    return "Max reviews must be an integer greater than or equal to min reviews.";
  }
  const hasLat = locationLat !== "" && locationLat !== undefined && locationLat !== null;
  const hasLng = locationLng !== "" && locationLng !== undefined && locationLng !== null;
  if (hasLat !== hasLng) return "Map pin must include both latitude and longitude.";
  if ((hasLat && !Number.isFinite(Number(locationLat))) || (hasLng && !Number.isFinite(Number(locationLng)))) {
    return "Map pin coordinates are invalid.";
  }
  return "";
}

function boolInput(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function defaultCreditGrant() {
  return Math.max(0, Number(config.defaultUserCredits) || 0);
}

function googleRedirectUri(req) {
  return `${appBaseUrl(req)}/api/auth/google/callback`;
}

function appBaseUrl(req) {
  const configured = config.appBaseUrl.replace(/\/+$/, "");
  if (configured) return configured;

  const host = req.headers.host;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const proto =
    forwardedProto ||
    (host?.startsWith("127.0.0.1") || host?.startsWith("localhost")
      ? "http"
      : "https");
  return `${proto}://${host}`;
}

function redirectLoginError(res, error) {
  return redirect(res, `/login?error=${encodeURIComponent(error)}`, {
    "set-cookie": `${OAUTH_STATE_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  });
}

async function servePublicAsset(res, pathname) {
  const fullPath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 400, { error: "Invalid asset path" });
  }
  return serveFile(res, fullPath);
}

async function serveFile(res, filePath) {
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "File not found" });
  }
}

function isPublicAsset(pathname) {
  return ["/styles.css", "/dashboard.js", "/login.js", "/dev.js"].includes(pathname);
}

function publicPageFile(pathname) {
  const pages = {
    "/niches": "niches.html",
    "/how-it-works": "how-it-works.html",
    "/why-it-works": "why-it-works.html",
    "/pricing": "pricing.html",
  };
  return pages[pathname] || "";
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { ...headers, location });
  res.end();
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendCsv(res, filename, rows) {
  const headers = rows.length
    ? Object.keys(rows[0])
    : [
        "leadId",
        "businessName",
        "websiteUrl",
        "phone",
        "email",
        "address",
        "googleRating",
        "reviewCount",
        "googleMapsUrl",
        "googlePlaceId",
        "relevanceScore",
        "leadStatus",
        "niche",
        "notes",
        "auditScore",
        "recommendedServiceOffer",
        "subject",
        "emailBody",
        "followUp",
        "draftStatus",
        "draftCreatedAt",
        "leadCreatedAt",
      ];
  const csv = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\r\n");

  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
  res.end(csv);
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function contactType(lead) {
  const hasEmail = Boolean(String(lead.email || "").trim());
  const hasPhone = Boolean(String(lead.phone || "").trim());
  if (hasEmail && hasPhone) return "Email + phone";
  if (hasEmail) return "Email only";
  if (hasPhone) return "Phone only";
  return "";
}

async function accessibleLeadIdsForUser(userEmail) {
  const email = normalizeEmail(userEmail);
  const [runs, leads] = await Promise.all([
    storage.list("AgentRuns"),
    storage.list("Leads"),
  ]);
  const runIds = new Set(
    runs.filter((run) => normalizeEmail(run.userEmail) === email).map((run) => run.runId),
  );
  return new Set(leads.filter((lead) => runIds.has(lead.runId)).map((lead) => lead.leadId));
}

function unlockAccessMap(unlocks, userEmail) {
  const email = normalizeEmail(userEmail);
  const map = new Map();
  for (const unlock of unlocks || []) {
    if (normalizeEmail(unlock.userEmail) !== email) continue;
    if (!map.has(unlock.leadId)) map.set(unlock.leadId, new Set());
    map.get(unlock.leadId).add(unlock.feature);
  }
  return map;
}

function accessForLead(accessMap, leadId, owner = false) {
  return owner ? ownerAccessSet() : accessMap.get(leadId) || new Set();
}

function ownerAccessSet() {
  return new Set(["lead", "email", "phone", "audit", "copy"]);
}

function hasFullLeadAccess(access) {
  return access.has("lead");
}

function hasEmailAccess(access) {
  return access.has("email") || hasFullLeadAccess(access);
}

function hasPhoneAccess(access) {
  return access.has("phone") || hasFullLeadAccess(access);
}

function hasDetailAccess(access) {
  return access.has("email") || hasFullLeadAccess(access);
}

function hasAuditAccess(access) {
  return access.has("audit") || hasFullLeadAccess(access);
}

function hasCopyAccess(access) {
  return access.has("copy") || hasFullLeadAccess(access);
}

function sanitizeLeadForUser(lead, access) {
  const detailAccess = hasDetailAccess(access);
  const emailAccess = hasEmailAccess(access);
  const phoneAccess = hasPhoneAccess(access);
  const city = cityFromLead(lead);
  const safe = {
    leadId: lead.leadId,
    runId: lead.runId,
    businessName: detailAccess ? lead.businessName || "" : partialBusinessName(lead.businessName),
    previewName: partialBusinessName(lead.businessName),
    city,
    location: detailAccess ? lead.location || city : city,
    address: detailAccess ? lead.address || lead.location || city : city,
    googleRating: lead.googleRating || "",
    reviewCount: lead.reviewCount || "",
    relevanceScore: lead.relevanceScore || "",
    visibilityScore: lead.visibilityScore || "",
    visibilityTier: lead.visibilityTier || "",
    opportunityFlags: lead.opportunityFlags || "",
    status: lead.status || "",
    niche: lead.niche || "",
    notes: lead.notes || "",
    createdAt: lead.createdAt || "",
    updatedAt: lead.updatedAt || "",
    error: lead.error || "",
    websiteUrl: detailAccess ? lead.websiteUrl || "" : "",
    googleMapsUrl: detailAccess ? lead.googleMapsUrl || "" : "",
    contactPageUrl: detailAccess ? lead.contactPageUrl || "" : "",
    bookingPageUrl: detailAccess ? lead.bookingPageUrl || "" : "",
    googlePlaceId: detailAccess ? lead.googlePlaceId || "" : "",
    email: emailAccess ? lead.email || "" : "",
    phone: phoneAccess ? lead.phone || "" : "",
    locked: {
      fullLead: !hasFullLeadAccess(access),
      details: !detailAccess,
      email: !emailAccess,
      phone: !phoneAccess,
      audit: !hasAuditAccess(access),
      copy: !hasCopyAccess(access),
    },
    available: {
      email: Boolean(String(lead.email || "").trim()),
      phone: Boolean(String(lead.phone || "").trim()),
      website: Boolean(String(lead.websiteUrl || "").trim()),
      audit: Boolean(String(lead.websiteUrl || lead.phone || lead.email || lead.businessName || "").trim()),
      details: Boolean(
        String(
          lead.businessName || lead.websiteUrl || lead.googleMapsUrl || lead.address || lead.location || lead.phone || lead.email || "",
        ).trim(),
      ),
    },
    unlockCosts: {
      email: unlockCreditCost("email", access),
      lead: unlockCreditCost("lead", access),
      phone: unlockCreditCost("phone", access),
      audit: unlockCreditCost("audit", access),
      copy: unlockCreditCost("copy", access),
    },
  };
  return safe;
}

function sanitizeAuditForUser(audit, access) {
  if (!hasAuditAccess(access)) {
    return {
      auditId: audit.auditId,
      leadId: audit.leadId,
      runId: audit.runId,
      score: audit.score || "",
      locked: true,
      status: audit.status || "",
      createdAt: audit.createdAt || "",
    };
  }
  return { ...audit, locked: false };
}

function sanitizeDraftForUser(draft, access) {
  if (!hasCopyAccess(access)) {
    return {
      draftId: draft.draftId,
      leadId: draft.leadId,
      runId: draft.runId,
      status: draft.status || "",
      locked: true,
      hasBody: Boolean(draft.body),
      createdAt: draft.createdAt || "",
      updatedAt: draft.updatedAt || "",
    };
  }
  return { ...draft, locked: false };
}

function partialBusinessName(name) {
  const text = String(name || "Local business").trim();
  if (text.length <= 4) return `${text.slice(0, 1)}...`;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]} ${words[1].slice(0, 1)}...`;
  return `${text.slice(0, Math.min(6, text.length))}...`;
}

function cityFromLead(lead) {
  const value = String(lead.address || lead.location || "").trim();
  if (!value) return "";
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 3].replace(/\d+/g, "").trim() || parts[1];
  if (parts.length >= 2) return parts[parts.length - 2].replace(/\d+/g, "").trim() || parts[0];
  return parts[0];
}

function latestByCreatedAt(items) {
  return [...(items || [])].sort(
    (a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0),
  )[0] || null;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isOwnerEmail(email) {
  return config.ownerEmails.includes(normalizeEmail(email));
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function usageCount(events, type) {
  return events
    .filter((event) => event.type === type)
    .reduce((sum, event) => sum + numberValue(event.count), 0);
}

function googleApiCallCount(events) {
  return events
    .filter((event) => event.provider === "Google" && !String(event.type || "").includes("cache_hit"))
    .reduce((sum, event) => sum + numberValue(event.count), 0);
}

function aggregateUsageByType(events) {
  const grouped = new Map();
  for (const event of events) {
    const type = event.type || "unknown";
    const current = grouped.get(type) || {
      type,
      provider: event.provider || "System",
      count: 0,
    };
    current.count += numberValue(event.count);
    grouped.set(type, current);
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count);
}

function latestDate(values) {
  return values
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || "";
}

function normalizeDateRange(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return ["today", "7d", "30d", "all"].includes(normalized) ? normalized : "all";
}

function dateRangeStart(range) {
  if (range === "all") return null;

  const now = new Date();
  if (range === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (range === "7d") return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  if (range === "30d") return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return null;
}

function isWithinRange(value, startDate) {
  if (!startDate) return true;
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) && timestamp >= startDate.getTime();
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function setSession(res, user = {}) {
  const token = createSessionToken(user);
  res.setHeader(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800`,
  );
}

function clearSession(res) {
  res.setHeader(
    "set-cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  );
}

function clearDevSession(res) {
  res.setHeader(
    "set-cookie",
    `${DEV_SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  );
}

function isAuthed(req) {
  return Boolean(currentSession(req));
}

function currentSession(req) {
  const token = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  return verifySessionToken(token);
}

function isDevAuthed(req) {
  const token = parseCookies(req.headers.cookie || "")[DEV_SESSION_COOKIE];
  const session = verifySessionToken(token);
  return session?.scope === "dev";
}

function createSessionToken(user = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      iat: Date.now(),
      email: user.email || "",
      name: user.name || "",
      picture: user.picture || "",
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function createDevSessionToken() {
  const payload = Buffer.from(
    JSON.stringify({
      iat: Date.now(),
      scope: "dev",
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
  if (!token) return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  if (/^\d+$/.test(payload)) {
    const age = Date.now() - Number(payload);
    if (Number.isNaN(age) || age > 8 * 60 * 60 * 1000) return null;
    return timingSafeEqual(signature, sign(payload)) ? { iat: Number(payload) } : null;
  }

  if (!timingSafeEqual(signature, sign(payload))) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const age = Date.now() - Number(session.iat);
    if (!session.iat || Number.isNaN(age) || age > 8 * 60 * 60 * 1000) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function sign(value) {
  return crypto
    .createHmac("sha256", config.sessionSecret)
    .update(value)
    .digest("base64url");
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a || "");
  const right = Buffer.from(b || "");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(cookieHeader) {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        return [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
      }),
  );
}

function parseLeadImport(csv) {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const first = splitDelimitedLine(lines[0]);
  const hasHeader = first.some((cell) =>
    /business|website|location|phone|email|source|niche/i.test(cell),
  );
  const headers = hasHeader
    ? first.map(normalizeHeader)
    : ["businessName", "websiteUrl", "location", "phone", "email", "sourceUrl", "niche"];
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines.map((line) => {
    const cells = splitDelimitedLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
  });
}

function splitDelimitedLine(line) {
  const delimiter = line.includes("\t") ? "\t" : ",";
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function normalizeHeader(header) {
  const key = String(header || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const map = {
    business: "businessName",
    businessname: "businessName",
    name: "businessName",
    website: "websiteUrl",
    websiteurl: "websiteUrl",
    url: "websiteUrl",
    location: "location",
    address: "address",
    phone: "phone",
    email: "email",
    googlerating: "googleRating",
    rating: "googleRating",
    reviewcount: "reviewCount",
    reviews: "reviewCount",
    googleplaceid: "googlePlaceId",
    placeid: "googlePlaceId",
    googlemapsurl: "googleMapsUrl",
    mapsurl: "googleMapsUrl",
    contactpage: "contactPageUrl",
    contactpageurl: "contactPageUrl",
    bookingpage: "bookingPageUrl",
    bookingpageurl: "bookingPageUrl",
    relevancescore: "relevanceScore",
    score: "relevanceScore",
    acceptedreason: "acceptedReason",
    reasonaccepted: "acceptedReason",
    websitestatus: "websiteStatus",
    source: "sourceUrl",
    sourceurl: "sourceUrl",
    niche: "niche",
  };
  return map[key] || key;
}

if (!process.env.VERCEL) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
