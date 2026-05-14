const TOP_LEAD_LIMIT = 20;
const START_HERE_LIMIT = 6;
const REFRESH_IDLE_MS = 15000;
const REFRESH_ACTIVE_MS = 4000;
const MAX_LEAD_COUNT = 100;

const state = {
  data: null,
  timer: null,
  selectedLeadId: "",
  messages: new Map(),
  continuingRuns: new Set(),
  hiddenBefore: Number(localStorage.getItem("manualBoardHiddenBefore") || 0),
  boardView: localStorage.getItem("leadBoardView") === "all" ? "all" : "priority",
};

upgradeDashboardDom();

const els = {
  campaignForm: document.getElementById("campaignForm"),
  campaignCostHint: document.getElementById("campaignCostHint"),
  campaignStatus: document.getElementById("campaignStatus"),
  clearLeadBoardButtons: document.querySelectorAll("[data-clear-board]"),
  boardViewButtons: document.querySelectorAll("[data-board-view]"),
  weeklyFeed: document.getElementById("weeklyFeed"),
  startHereList: document.getElementById("startHereList"),
  leadVisibleCount: document.getElementById("leadVisibleCount"),
  leadCards: document.getElementById("leadCards"),
  saveStatus: document.getElementById("saveStatus"),
  modal: document.getElementById("auditModal"),
  modalTitle: document.getElementById("modalTitle"),
  modalBody: document.getElementById("modalBody"),
  modalClose: document.getElementById("modalClose"),
  modalCopyEmail: document.getElementById("modalCopyEmail"),
  modalMarkContacted: document.getElementById("modalMarkContacted"),
};

document.getElementById("logoutButton").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

els.campaignForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.leadCount = Math.min(MAX_LEAD_COUNT, Number(payload.leadCount));
  payload.radiusKm = Number(payload.radiusKm);
  payload.minReviews = Number(payload.minReviews);
  payload.maxReviews = Number(payload.maxReviews);
  payload.reviewFilterEnabled = payload.reviewFilterEnabled === "true";
  payload.searchDepth = normalizeOption(payload.searchDepth, "smart");
  payload.websiteFilter = normalizeOption(payload.websiteFilter, "any");
  payload.visibilityFilter = normalizeOption(payload.visibilityFilter, "any");
  payload.opportunityFilter = normalizeOption(payload.opportunityFilter, "any");

  try {
    setSaveStatus("Starting search...");
    const response = await api("/api/campaigns", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (response.run) {
      setSaveStatus("New search started. Existing leads stay visible while new leads come in.");
      restartPolling(REFRESH_ACTIVE_MS);
      await refresh();
    }
  } catch (error) {
    setSaveStatus(error.message);
  }
});

els.clearLeadBoardButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.hiddenBefore = Date.now();
    localStorage.setItem("manualBoardHiddenBefore", String(state.hiddenBefore));
    setSaveStatus("Board cleared. Saved leads are still kept for dedupe and export.");
    render();
  });
});

els.boardViewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.boardView = button.dataset.boardView === "all" ? "all" : "priority";
    localStorage.setItem("leadBoardView", state.boardView);
    render();
  });
});

els.campaignStatus?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-stop-run]");
  if (!button) return;
  await stopRun(button.dataset.stopRun);
});

els.leadCards.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  const leadId = button.closest(".opportunity-card")?.dataset.leadId;
  if (!leadId) return;

  if (button.dataset.action === "copy") await copyMessage(leadId);
  if (button.dataset.action === "view") await openAuditModal(leadId);
  if (button.dataset.action === "contacted") await markContacted(leadId);
});

els.startHereList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-focus-lead]");
  if (!button) return;

  const card = leadCardById(button.dataset.focusLead);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("is-focused");
  window.setTimeout(() => card.classList.remove("is-focused"), 1300);
});

els.modalClose.addEventListener("click", closeAuditModal);
els.modal.addEventListener("click", (event) => {
  if (event.target === els.modal) closeAuditModal();
});
els.modalCopyEmail.addEventListener("click", async () => copyMessage(state.selectedLeadId));
els.modalMarkContacted.addEventListener("click", async () => markContacted(state.selectedLeadId));

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    window.location.href = "/login";
    return {};
  }

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : {};
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function refresh() {
  try {
    state.data = await api("/api/state");
    render();
  } catch (error) {
    setSaveStatus(error.message);
  }
}

function render() {
  renderSearchHint();
  renderCampaignStatus();
  const opportunities = topOpportunities();
  const priorityOpportunities = opportunities.slice(0, TOP_LEAD_LIMIT);
  renderWeeklyFeed(priorityOpportunities);
  renderStartHere(priorityOpportunities.slice(0, START_HERE_LIMIT));
  renderLeadCards(opportunities);
  syncPollingSpeed();
  maybeContinueLatestRun();
}

function renderSearchHint() {
  if (!els.campaignCostHint) return;
  const owner = Boolean(state.data?.credits?.owner);
  els.campaignCostHint.textContent = owner
    ? "Owner access: searches and lead access are unlimited."
    : "Search cost: 50 credits. Full lead unlock: 25 credits.";
}

function renderCampaignStatus() {
  if (!els.campaignStatus) return;
  const run = latestCampaignRun();
  if (!run) {
    els.campaignStatus.hidden = true;
    els.campaignStatus.innerHTML = "";
    return;
  }

  const status = String(run.status || "Running");
  const running = ["Running", "Continuing"].includes(status);
  const stopped = isStoppedRun(run);
  const failed = status === "Failed";
  const userStopped = isUserStoppedRun(run);
  const requested = numberValue(run.leadCount || run.progressTotal);
  const qualified = numberValue(run.qualifiedLeads || run.finalQualifiedLeads || run.progressDone);
  const raw = numberValue(run.rawResultsFound);
  const filtered = Math.max(
    0,
    numberValue(run.removedByReviewFilter) +
      numberValue(run.irrelevantRejected) +
      numberValue(run.duplicatesRemoved),
  );
  const progressTotal = Math.max(requested, numberValue(run.progressTotal), qualified, 1);
  const progressDone = Math.min(progressTotal, Math.max(qualified, numberValue(run.progressDone)));
  const progressPercent = Math.max(3, Math.min(100, Math.round((progressDone / progressTotal) * 100)));
  const title = running
    ? "Search running"
    : stopped
      ? "Search paused"
      : failed
        ? "Search failed"
        : ["Completed With Failures", "Completed With Filters"].includes(status)
          ? "Search completed with filters"
          : "Search complete";
  const subtitle = running
    ? currentStepText(run)
    : stopped
      ? userStopped
        ? "Search stopped. Leads already found stay on the board."
        : "Search paused before the requested count. The dashboard will continue it automatically."
    : run.discoveryMessage || `${qualified}/${requested || progressTotal} qualified leads found.`;
  const suggestions = campaignSuggestions(run, {
    requested,
    qualified,
    raw,
    filtered,
    running,
    failed,
    stopped,
    userStopped,
  });

  els.campaignStatus.hidden = false;
  els.campaignStatus.classList.toggle("is-running", running);
  els.campaignStatus.classList.toggle("is-stopped", stopped);
  els.campaignStatus.classList.toggle("is-failed", failed);
  els.campaignStatus.innerHTML = `
    <div class="campaign-status-main">
      <div>
        <p class="opportunity-eyebrow">${escapeHtml(statusLabel(status))}</p>
        <h2>${escapeHtml(run.niche || "Search")} in ${escapeHtml(run.location || "selected area")}</h2>
        <p>${escapeHtml(subtitle)}</p>
      </div>
      <div class="campaign-status-actions">
        <strong class="campaign-status-pill">${escapeHtml(title)}</strong>
        ${running ? `<button class="quiet-button stop-search-button" data-stop-run="${escapeAttr(run.runId)}" type="button">Stop search</button>` : ""}
      </div>
    </div>
    <div class="campaign-progress" aria-label="Search progress">
      <span style="width: ${progressPercent}%"></span>
    </div>
    <div class="campaign-status-stats">
      <span>${escapeHtml(qualified)}/${escapeHtml(requested || progressTotal)} qualified</span>
      <span>${escapeHtml(progressDone)}/${escapeHtml(progressTotal)} processed</span>
      <span>${escapeHtml(raw)} checked</span>
      <span>${escapeHtml(filtered)} filtered out</span>
      <span>${escapeHtml(filterSummary(run))}</span>
      <span>Updated ${escapeHtml(formatTime(run.updatedAt || run.createdAt))}</span>
    </div>
    ${
      suggestions.length
        ? `<div class="campaign-suggestions">
            <strong>How to improve results</strong>
            <ul>
              ${suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ul>
          </div>`
        : ""
    }
  `;
}

function upgradeDashboardDom() {
  ensureCampaignStatusCard();
  ensureBoardViewToggle();
  replaceLegacySelect("reviewFilterEnabled", [
    { value: "false", label: "Off" },
    { value: "true", label: "On" },
  ], "Review filter", "compact");
  replaceLegacySelect("contactPreference", [
    { value: "any", label: "Any reachable" },
    { value: "email", label: "Email only" },
    { value: "email_phone", label: "Email + phone" },
  ], "Contact type", "");
}

function ensureBoardViewToggle() {
  if (document.querySelector("[data-board-view]")) return;
  const actions = document.querySelector(".board-actions");
  const count = document.getElementById("leadVisibleCount");
  if (!actions || !count) return;

  const wrapper = document.createElement("div");
  wrapper.className = "board-view-toggle";
  wrapper.setAttribute("role", "group");
  wrapper.setAttribute("aria-label", "Lead board view");
  wrapper.innerHTML = `
    <button class="quiet-button is-active" data-board-view="priority" type="button">Priority 20</button>
    <button class="quiet-button" data-board-view="all" type="button">All leads</button>
  `;
  count.insertAdjacentElement("afterend", wrapper);
}

function ensureCampaignStatusCard() {
  if (document.getElementById("campaignStatus")) return;
  const card = document.createElement("section");
  card.id = "campaignStatus";
  card.className = "campaign-status-card";
  card.hidden = true;
  const controlCard = document.querySelector(".opportunity-control-card");
  controlCard?.insertAdjacentElement("afterend", card);
}

function replaceLegacySelect(name, options, legend, extraClass) {
  const select = document.querySelector(`select[name="${name}"]`);
  if (!select) return;

  const selectedValue = select.value || options.find((option) => option.value === "true")?.value || options[0]?.value;
  const fieldset = document.createElement("fieldset");
  fieldset.className = `segmented-field ${extraClass || ""}`.trim();
  fieldset.innerHTML = `
    <legend>${escapeHtml(legend)}</legend>
    <div class="segmented-control">
      ${options
        .map(
          (option) => `
            <label>
              <input name="${escapeAttr(name)}" type="radio" value="${escapeAttr(option.value)}" ${
                option.value === selectedValue ? "checked" : ""
              } />
              ${escapeHtml(option.label)}
            </label>
          `,
        )
        .join("")}
    </div>
  `;
  select.closest("label")?.replaceWith(fieldset);
}

function latestCampaignRun() {
  const runs = [...(state.data?.agentRuns || []), ...(state.data?.activeRuns || [])];
  const byId = new Map();
  for (const run of runs) byId.set(run.runId || `${run.createdAt}-${run.niche}`, run);
  return [...byId.values()].sort(
    (a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0),
  )[0];
}

function currentStepText(run) {
  const step = String(run.currentStep || "Searching").trim();
  const message = String(run.discoveryMessage || "").trim();
  if (message && !message.toLowerCase().includes("found 0/")) return message;
  return `${step}. New leads will appear below as they qualify.`;
}

function statusLabel(status) {
  if (status === "Running") return "Searching now";
  if (status === "Continuing") return "Continuing";
  if (status === "Stopped") return "Paused";
  if (status === "Failed") return "Needs attention";
  if (["Completed With Failures", "Completed With Filters"].includes(status)) return "Done";
  return "Done";
}

function syncPollingSpeed() {
  const run = latestCampaignRun();
  restartPolling(run && shouldKeepPollingFast(run) ? REFRESH_ACTIVE_MS : REFRESH_IDLE_MS);
}

function restartPolling(intervalMs) {
  if (state.pollingMs === intervalMs) return;
  window.clearInterval(state.timer);
  state.pollingMs = intervalMs;
  state.timer = window.setInterval(refresh, intervalMs);
}

function shouldKeepPollingFast(run) {
  if (isUserStoppedRun(run)) return false;
  return ["Running", "Continuing", "Stopped"].includes(String(run.status || "")) ||
    isStoppedEarlyCompletedRun(run);
}

function shouldContinueRun(run) {
  if (!run?.runId) return false;
  if (isUserStoppedRun(run)) return false;
  const requested = numberValue(run.leadCount || run.progressTotal);
  const qualified = numberValue(run.qualifiedLeads || run.finalQualifiedLeads || run.progressDone);
  if (!requested || qualified >= requested) return false;
  const status = String(run.status || "");
  return status === "Continuing" || status === "Stopped" || isStoppedEarlyCompletedRun(run);
}

function isStoppedRun(run) {
  return String(run?.status || "") === "Stopped" || isStoppedEarlyCompletedRun(run);
}

function isUserStoppedRun(run) {
  return truthy(run?.stopRequested) || /stopped by user/i.test(String(run?.currentStep || run?.discoveryMessage || ""));
}

function isStoppedEarlyCompletedRun(run) {
  return (
    String(run?.status || "") === "Completed With Failures" &&
    /stopped/i.test(String(run?.currentStep || run?.discoveryMessage || ""))
  );
}

async function stopRun(runId) {
  if (!runId) return;
  try {
    setSaveStatus("Stopping search...");
    await api(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
    state.continuingRuns.delete(runId);
    restartPolling(REFRESH_ACTIVE_MS);
    await refresh();
    setSaveStatus("Search stopped. Leads already found stay on the board.");
  } catch (error) {
    setSaveStatus(error.message);
  }
}

async function maybeContinueLatestRun() {
  const run = latestCampaignRun();
  if (!shouldContinueRun(run) || state.continuingRuns.has(run.runId)) return;

  state.continuingRuns.add(run.runId);
  try {
    setSaveStatus("Continuing search toward the requested lead count...");
    await api(`/api/runs/${encodeURIComponent(run.runId)}/continue`, { method: "POST" });
    restartPolling(REFRESH_ACTIVE_MS);
    await refresh();
  } catch (error) {
    setSaveStatus(error.message);
  } finally {
    state.continuingRuns.delete(run.runId);
  }
}

function topOpportunities() {
  const auditsByLeadId = new Map((state.data?.auditReports || []).map((audit) => [audit.leadId, audit]));
  const draftsByLeadId = latestDraftMap(state.data?.emailDrafts || []);

  return boardLeads(state.data?.leads || [])
    .filter((lead) => !["Rejected", "Failed"].includes(String(lead.status || "")))
    .map((lead) => {
      const audit = auditsByLeadId.get(lead.leadId) || {};
      const draft = draftsByLeadId.get(lead.leadId) || {};
      const score = opportunityScore(lead, audit);
      const priority = priorityFor(lead, score);
      const insight = coreInsight(lead, audit);
      const opportunity = opportunityText(lead, audit);
      const message = outreachMessage(lead, audit, draft, insight, opportunity);
      return { lead, audit, draft, score, priority, insight, opportunity, message };
    })
    .sort((a, b) => {
      if (a.priority.rank !== b.priority.rank) return b.priority.rank - a.priority.rank;
      if (a.score !== b.score) return b.score - a.score;
      return Date.parse(b.lead.createdAt || b.lead.updatedAt || 0) - Date.parse(a.lead.createdAt || a.lead.updatedAt || 0);
    });
}

function boardLeads(leads) {
  if (!state.hiddenBefore) return leads;
  return leads.filter((lead) => {
    const created = new Date(lead.createdAt || lead.updatedAt || 0).getTime();
    return created > state.hiddenBefore;
  });
}

function renderWeeklyFeed(opportunities) {
  const allLeads = boardLeads(state.data?.leads || []);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const newThisWeek = allLeads.filter((lead) => Date.parse(lead.createdAt || lead.updatedAt || 0) >= weekAgo).length;
  const highPriority = opportunities.filter((item) => item.priority.rank >= 3).length;
  const readyMessages = opportunities.filter((item) => item.message).length;

  els.weeklyFeed.innerHTML = [
    ["New leads added", newThisWeek],
    ["High priority count", highPriority],
    ["Messages ready", readyMessages],
  ]
    .map(
      ([label, value]) => `
        <article>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </article>
      `,
    )
    .join("");
}

function renderStartHere(opportunities) {
  if (!opportunities.length) {
    els.startHereList.innerHTML = `<li class="empty-start">No priority leads are ready yet.</li>`;
    return;
  }

  els.startHereList.innerHTML = opportunities
    .map(
      (item, index) => `
        <li>
          <button data-focus-lead="${escapeAttr(item.lead.leadId)}" type="button">
            <span>${index + 1}</span>
            <strong>${escapeHtml(item.lead.businessName || "Unnamed lead")}</strong>
            <em>${escapeHtml(item.priority.label)}</em>
          </button>
        </li>
      `,
    )
    .join("");
}

function renderLeadCards(opportunities) {
  const visibleOpportunities =
    state.boardView === "all" ? opportunities : opportunities.slice(0, TOP_LEAD_LIMIT);
  state.messages = new Map(visibleOpportunities.map((item) => [item.lead.leadId, item.message]));
  els.leadVisibleCount.textContent =
    state.boardView === "all"
      ? `${visibleOpportunities.length} all leads shown`
      : `${visibleOpportunities.length}/${opportunities.length} priority shown`;
  els.boardViewButtons.forEach((button) => {
    const active = button.dataset.boardView === state.boardView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  if (!visibleOpportunities.length) {
    els.leadCards.innerHTML = `
      <p class="empty-state dark-empty-state">
        No opportunities are ready yet. New qualified leads will appear here after discovery.
      </p>
    `;
    return;
  }

  els.leadCards.innerHTML = visibleOpportunities
    .map((item) => {
      const { lead, score, priority, insight, opportunity, message } = item;
      const contacted = salesStage(lead) === "Contacted";
      return `
        <article class="opportunity-card" data-lead-id="${escapeAttr(lead.leadId)}">
          <div class="opportunity-card-top">
            <div>
              <span class="priority-badge ${escapeAttr(priority.className)}">${escapeHtml(priority.label)}</span>
              <h3>${escapeHtml(lead.businessName || "Unnamed lead")}</h3>
              <p>${escapeHtml(leadLocation(lead))}</p>
            </div>
            <strong class="opportunity-score">${escapeHtml(score)}/100</strong>
          </div>

          <div class="opportunity-meta">
            <span>${escapeHtml(ratingText(lead))}</span>
            <span>${escapeHtml(reviewText(lead))}</span>
            <span>${escapeHtml(visibilityText(lead))}</span>
            <span>${escapeHtml(salesStage(lead))}</span>
          </div>

          <div class="opportunity-signal">
            <span>Core insight</span>
            <p>${escapeHtml(insight)}</p>
          </div>

          <div class="opportunity-signal">
            <span>Opportunity</span>
            <p>${escapeHtml(opportunity)}</p>
          </div>

          <div class="message-box">
            <div>
              <span>Exact outreach message</span>
              <button class="text-action" data-action="copy" type="button">Copy message</button>
            </div>
            <p>${escapeHtml(message)}</p>
          </div>

          <div class="opportunity-actions">
            <button class="secondary-button" data-action="view" type="button">View audit</button>
            <button class="secondary-button" data-action="copy" type="button">Copy message</button>
            <button data-action="contacted" type="button" ${contacted ? "disabled" : ""}>${contacted ? "Contacted" : "Mark contacted"}</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function campaignSuggestions(run, stats) {
  if (stats.running) return [];

  const requested = numberValue(stats.requested);
  const qualified = numberValue(stats.qualified);
  const raw = numberValue(stats.raw);
  if (requested && qualified >= requested && !stats.failed) return [];

  const suggestions = [];
  const reviewRemoved = numberValue(run.removedByReviewFilter);
  const relevanceRemoved = numberValue(run.removedByRelevanceFilter);
  const visibilityRemoved = numberValue(run.removedByVisibilityFilter);
  const websiteRemoved = numberValue(run.removedByWebsiteFilter);
  const opportunityRemoved = numberValue(run.removedByOpportunityFilter);
  const duplicates = Math.max(numberValue(run.removedAsDuplicate), numberValue(run.duplicatesRemoved));
  const enriched = numberValue(run.enrichedWithPlaceDetails);
  const contactPreference = String(run.contactPreference || "any");

  if (stats.userStopped) {
    suggestions.push("This search was stopped manually. Start a new search when you want more leads from the same or a wider area.");
  }
  if (reviewRemoved > Math.max(qualified, 10)) {
    suggestions.push("The review range removed many businesses. Raise max reviews, lower min reviews, or turn the review filter off for a larger list.");
  }
  if (relevanceRemoved > Math.max(qualified, 10)) {
    suggestions.push("The niche match removed many places. Try a broader search term, for example the main service category instead of a very specific keyword.");
  }
  if (visibilityRemoved > Math.max(qualified, 10)) {
    suggestions.push("The visibility filter removed many businesses. Use Any visibility for volume, or Low visibility when you only want map-ranking opportunities.");
  }
  if (websiteRemoved > Math.max(qualified, 10)) {
    suggestions.push("The website filter removed many businesses. Use Any website status if you want more reachable leads first.");
  }
  if (opportunityRemoved > Math.max(qualified, 10)) {
    suggestions.push("The opportunity filter removed many businesses. Use Any opportunity for volume, then sort by audit insight.");
  }
  if (duplicates > Math.max(qualified, 5)) {
    suggestions.push("Saved businesses were skipped to prevent duplicate leads and API waste. Try a new nearby city, a different radius, or a fresh niche.");
  }
  if (raw > 0 && enriched < Math.min(requested || 20, 20) && !reviewRemoved && !relevanceRemoved) {
    suggestions.push("Google returned few usable business profiles. Increase the radius or search a larger nearby city.");
  }
  if (["email", "email_phone"].includes(contactPreference)) {
    suggestions.push("Strict contact access can reduce usable leads. Use Any reachable if phone-only leads are acceptable.");
  }
  if (run.websiteFilter && run.websiteFilter !== "any") {
    suggestions.push("The website filter is strict. Use Any website status if you want the system to capture more reachable businesses first.");
  }
  if (run.visibilityFilter && run.visibilityFilter !== "any") {
    suggestions.push("Visibility filtering narrows the list. Use Any visibility when you need volume, then sort the board by score.");
  }
  if (run.opportunityFilter && run.opportunityFilter !== "any") {
    suggestions.push("The opportunity filter only keeps one specific gap. Use Any opportunity for more leads, then prioritize by audit insight.");
  }
  if (!suggestions.length) {
    suggestions.push("For more leads, increase the radius, loosen review filters, and use a broader niche phrase.");
  }

  return suggestions.slice(0, 4);
}

async function openAuditModal(leadId) {
  const lead = leadById(leadId);
  if (!lead) return;

  let audit = (state.data.auditReports || []).find((item) => item.leadId === leadId) || {};
  if (!audit.auditId || audit.locked !== false) {
    setSaveStatus("Preparing audit...");
    const unlocked = await unlockFeature(leadId, "audit");
    if (!unlocked) return;
    audit = (state.data.auditReports || []).find((item) => item.leadId === leadId) || {};
  }

  const draft = latestDraftMap(state.data.emailDrafts || []).get(leadId) || {};
  const insight = coreInsight(lead, audit);
  const opportunity = opportunityText(lead, audit);
  const message = outreachMessage(lead, audit, draft, insight, opportunity);
  state.messages.set(leadId, message);
  state.selectedLeadId = leadId;

  els.modalTitle.textContent = lead.businessName || "Lead audit";
  els.modalCopyEmail.disabled = !message;
  els.modalMarkContacted.disabled = salesStage(lead) === "Contacted";
  els.modalMarkContacted.textContent = salesStage(lead) === "Contacted" ? "Contacted" : "Mark contacted";
  els.modalBody.innerHTML = `
    ${modalSection("Opportunity Snapshot", [
      ["Priority", priorityFor(lead, opportunityScore(lead, audit)).label],
      ["Score", `${opportunityScore(lead, audit)}/100`],
      ["Rating", ratingText(lead)],
      ["Location", leadLocation(lead)],
    ])}
    ${modalTextSection("Core Insight", insight)}
    ${modalTextSection("Opportunity", opportunity)}
    ${modalTextSection("Conversion Gaps", audit.conversionIssues || audit.ctaIssues || audit.cons)}
    ${modalTextSection("Top Fixes", audit.top5QuickFixes)}
    ${modalTextSection("Exact Outreach Message", message)}
  `;
  els.modal.hidden = false;
}

function closeAuditModal() {
  els.modal.hidden = true;
  state.selectedLeadId = "";
}

async function copyMessage(leadId) {
  if (!leadId) return;
  const message = state.messages.get(leadId);
  if (!message) {
    setSaveStatus("No outreach message is ready for this lead.");
    return;
  }

  await navigator.clipboard.writeText(message);
  setSaveStatus("Outreach message copied.");
}

async function unlockFeature(leadId, feature) {
  try {
    await api(`/api/leads/${leadId}/unlock`, {
      method: "POST",
      body: JSON.stringify({ feature }),
    });
    await refresh();
    return true;
  } catch (error) {
    setSaveStatus(error.message);
    return false;
  }
}

async function markContacted(leadId) {
  if (!leadId) return;
  await api(`/api/leads/${leadId}/contacted`, { method: "POST" });
  setSaveStatus("Marked contacted.");
  await refresh();
  if (!els.modal.hidden) openAuditModal(leadId);
}

function opportunityScore(lead, audit) {
  const auditScore = Number(audit?.score || 0);
  const relevanceScore = Number(lead?.relevanceScore || 0);
  const rating = Number(lead?.googleRating || 0);
  const reviewCount = Number(lead?.reviewCount || 0);
  const contactBoost = lead?.available?.email || lead?.available?.phone || lead?.email || lead?.phone ? 6 : 0;
  const reviewGapBoost = reviewCount > 0 && reviewCount <= 35 ? 7 : 0;
  const ratingBoost = rating >= 4 ? 4 : rating >= 3.5 ? 2 : 0;
  const visibilityBoost = String(lead?.visibilityTier || "").toLowerCase() === "low" ? 5 : 0;
  const base = Math.max(auditScore, relevanceScore, 54);
  return Math.min(100, Math.round(base + contactBoost + reviewGapBoost + ratingBoost + visibilityBoost));
}

function priorityFor(lead, score) {
  if (salesStage(lead) === "Contacted") {
    return { label: "Contacted", className: "priority-done", rank: 0 };
  }
  if (score >= 88) return { label: "Top priority", className: "priority-top", rank: 4 };
  if (score >= 76) return { label: "High priority", className: "priority-high", rank: 3 };
  if (score >= 64) return { label: "Strong fit", className: "priority-fit", rank: 2 };
  return { label: "Worth a look", className: "priority-watch", rank: 1 };
}

function coreInsight(lead, audit) {
  if (audit?.locked === false) {
    const auditText = firstText(audit.conversionIssues, audit.ctaIssues, audit.bookingFlowProblems, audit.top5QuickFixes);
    if (auditText) return auditText;
  }

  const reviews = Number(lead.reviewCount || 0);
  const rating = Number(lead.googleRating || 0);
  if (reviews > 0 && reviews <= 35 && rating >= 3.5) {
    return "Visible demand is present, but review depth is still low enough to open with a trust and conversion gap.";
  }
  if (!lead.websiteUrl && !lead.available?.details) {
    return "The business has local search visibility, but the website path is not visible in preview.";
  }
  if (lead.visibilityTier === "low") {
    return "The business appears to have lower map visibility, which can make local search improvement a stronger opener.";
  }
  if (lead.error) return lead.error;
  return "The profile has enough demand signal to lead with a fast booking and follow-up improvement.";
}

function opportunityText(lead, audit) {
  if (audit?.locked === false && audit.recommendedServiceOffer) return firstPipe(audit.recommendedServiceOffer);
  if (audit?.locked === false && audit.top5QuickFixes) return firstPipe(audit.top5QuickFixes);

  const niche = cleanNiche(lead.niche);
  if (niche) {
    return `Offer a quick ${niche} conversion review focused on turning more local search visitors into booked calls.`;
  }
  return "Offer a short conversion review focused on clearer calls to action, stronger trust signals, and faster follow-up.";
}

function outreachMessage(lead, audit, draft, insight, opportunity) {
  if (draft?.locked === false && draft.body) {
    return [draft.subject ? `Subject: ${draft.subject}` : "", draft.body, draft.followUp].filter(Boolean).join("\n\n");
  }

  const name = lead.businessName || "there";
  const niche = cleanNiche(lead.niche) || "local business";
  const opener = insight ? insight.charAt(0).toLowerCase() + insight.slice(1) : "there may be a quick conversion win on the site";
  return `Hi ${name} team, I was looking at local ${niche} options and noticed ${opener} ${opportunity} Worth me sending over the 2-minute version of what I would change first?`;
}

function latestDraftMap(drafts) {
  const map = new Map();
  for (const draft of drafts || []) {
    const existing = map.get(draft.leadId);
    if (!existing || Date.parse(draft.createdAt || 0) > Date.parse(existing.createdAt || 0)) {
      map.set(draft.leadId, draft);
    }
  }
  return map;
}

function salesStage(lead) {
  const status = String(lead.status || "");
  const hasContact = hasEmail(lead) || hasPhone(lead) || lead.available?.email || lead.available?.phone;
  if (status === "Contacted" || status === "Interested") return "Contacted";
  if (status === "Approved") return "Approved";
  if (status === "Pending Approval" && hasContact) return "Ready";
  if (status === "Phone Only") return "Phone Ready";
  if (["Rejected", "Failed"].includes(status)) return "Rejected";
  if (hasContact) return "Ready";
  return "New";
}

function leadById(leadId) {
  return (state.data?.leads || []).find((lead) => lead.leadId === leadId);
}

function leadCardById(leadId) {
  return [...document.querySelectorAll(".opportunity-card")].find((card) => card.dataset.leadId === leadId);
}

function leadLocation(lead) {
  return lead.address || lead.location || lead.city || "Location unavailable";
}

function ratingText(lead) {
  const rating = lead.googleRating || lead.rating;
  return rating ? `${rating} stars` : "Rating unavailable";
}

function reviewText(lead) {
  const count = Number(lead.reviewCount || 0);
  return count ? `${count.toLocaleString()} reviews` : "Reviews unavailable";
}

function visibilityText(lead) {
  const tier = String(lead.visibilityTier || "").trim();
  const score = Number(lead.visibilityScore || 0);
  if (!tier && !score) return "Visibility unknown";
  return `${tier || "Visibility"}${score ? ` visibility ${score}/100` : ""}`;
}

function filterSummary(run) {
  const depth = optionLabel(run.searchDepth, {
    fast: "Fast scan",
    smart: "Smart grid",
    deep: "Deep grid",
  }, "Smart grid");
  const website = optionLabel(run.websiteFilter, {
    any: "Any website",
    has_website: "Has website",
    no_website: "No website",
    weak_website: "Weak website",
  }, "Any website");
  const visibility = optionLabel(run.visibilityFilter, {
    any: "Any visibility",
    low: "Low visibility",
    medium: "Medium visibility",
    high: "High visibility",
  }, "Any visibility");
  return `${depth} / ${website} / ${visibility}`;
}

function optionLabel(value, labels, fallback) {
  return labels[String(value || "").trim()] || fallback;
}

function normalizeOption(value, fallback) {
  return String(value || fallback).trim().toLowerCase();
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function truthy(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function formatTime(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "just now";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function cleanNiche(value) {
  return String(value || "").trim().toLowerCase();
}

function hasEmail(lead) {
  return Boolean(String(lead?.email || "").trim());
}

function hasPhone(lead) {
  return Boolean(String(lead?.phone || "").trim());
}

function firstText(...values) {
  for (const value of values) {
    const text = firstPipe(value);
    if (text) return text;
  }
  return "";
}

function firstPipe(value) {
  return String(value || "").split(" | ")[0].trim();
}

function modalSection(title, rows) {
  return `
    <section class="audit-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="modal-grid">
        ${rows
          .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
          .join("")}
      </div>
    </section>
  `;
}

function modalTextSection(title, value) {
  if (!value) return "";
  return `
    <section class="audit-section">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(String(value).replaceAll(" | ", " / "))}</p>
    </section>
  `;
}

function setSaveStatus(message) {
  els.saveStatus.textContent = message;
  els.saveStatus.classList.toggle("is-visible", Boolean(message));
  window.clearTimeout(setSaveStatus.timer);
  setSaveStatus.timer = window.setTimeout(() => {
    els.saveStatus.textContent = "";
    els.saveStatus.classList.remove("is-visible");
  }, 3500);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

refresh();
restartPolling(REFRESH_IDLE_MS);
