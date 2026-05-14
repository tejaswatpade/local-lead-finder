const devLoginForm = document.getElementById("devLoginForm");
const devDashboard = document.getElementById("devDashboard");

const devEls = {
  refresh: document.getElementById("devRefresh"),
  logout: document.getElementById("devLogout"),
  updated: document.getElementById("devUpdated"),
  kpis: document.getElementById("devKpis"),
  usersBody: document.getElementById("devUsersBody"),
  usageBody: document.getElementById("devUsageBody"),
  runsBody: document.getElementById("devRunsBody"),
  usersRange: document.getElementById("devUsersRange"),
  apiRange: document.getElementById("devApiRange"),
  runUser: document.getElementById("devRunUser"),
  runRange: document.getElementById("devRunRange"),
};

if (devLoginForm) {
  devLoginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("devLoginError");
    error.textContent = "";

    const payload = Object.fromEntries(new FormData(devLoginForm).entries());
    const response = await fetch("/api/dev/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      error.textContent = data.error || "Could not open the internal dashboard.";
      return;
    }

    window.location.href = "/dev";
  });
}

if (devDashboard) {
  devEls.refresh?.addEventListener("click", () => loadDevState());
  devEls.logout?.addEventListener("click", async () => {
    await fetch("/api/dev/logout", { method: "POST" });
    window.location.href = "/dev";
  });
  [devEls.usersRange, devEls.apiRange, devEls.runUser, devEls.runRange].forEach((control) => {
    control?.addEventListener("change", () => loadDevState());
  });
  loadDevState();
}

async function loadDevState() {
  const params = new URLSearchParams({
    usersRange: devEls.usersRange?.value || "all",
    apiRange: devEls.apiRange?.value || "all",
    runsRange: devEls.runRange?.value || "all",
    runsUser: devEls.runUser?.value || "",
  });
  const response = await fetch(`/api/dev/state?${params.toString()}`);
  if (response.status === 401) {
    window.location.href = "/dev";
    return;
  }
  const data = await response.json();
  renderDevState(data);
}

function renderDevState(data) {
  if (devEls.updated) {
    devEls.updated.textContent = `Updated ${formatDate(data.generatedAt)}`;
  }
  renderRunUserOptions(data.availableUsers || []);

  devEls.kpis.innerHTML = [
    ["Users", data.totals.users],
    ["Campaigns", data.totals.campaigns],
    ["Google API calls", data.totals.googleApiCalls],
    ["Credits spent", data.totals.creditsSpent],
    ["Credits live", data.totals.creditsInCirculation],
  ]
    .map(([label, value]) => `
      <article class="kpi-card">
        <span>${escapeHtml(label)}</span>
        <strong>${formatNumber(value)}</strong>
      </article>
    `)
    .join("");

  devEls.usersBody.innerHTML =
    data.users.length
      ? data.users.map(renderUserRow).join("")
      : `<tr><td colspan="9">No user activity in this date range.</td></tr>`;

  devEls.usageBody.innerHTML =
    data.apiByType.length
      ? data.apiByType.map(renderUsageRow).join("")
      : `<tr><td colspan="3">No API usage in this date range.</td></tr>`;

  devEls.runsBody.innerHTML =
    data.recentRuns.length
      ? data.recentRuns.map(renderRunRow).join("")
      : `<tr><td colspan="5">No campaigns match these filters.</td></tr>`;
}

function renderRunUserOptions(users) {
  if (!devEls.runUser) return;

  const selected = devEls.runUser.value;
  devEls.runUser.innerHTML = [
    `<option value="">All users</option>`,
    ...users.map((email) => `<option value="${escapeAttribute(email)}">${escapeHtml(email)}</option>`),
  ].join("");
  devEls.runUser.value = users.includes(selected) ? selected : "";
}

function renderUserRow(user) {
  return `
    <tr>
      <td>
        <strong>${escapeHtml(user.email)}</strong>
        ${user.name ? `<span>${escapeHtml(user.name)}</span>` : ""}
      </td>
      <td>${formatNumber(user.campaigns)}</td>
      <td>${formatNumber(user.qualifiedLeads)} / ${formatNumber(user.leads)}</td>
      <td>${formatNumber(user.creditsBalance)}</td>
      <td>${formatNumber(user.lifetimeCreditsUsed)}</td>
      <td>${formatNumber(user.googleApiCalls)}</td>
      <td>${formatNumber(user.cacheHits)}</td>
      <td>${formatNumber(user.loginCount)}</td>
      <td>${formatDate(user.lastSeenAt)}</td>
    </tr>
  `;
}

function renderUsageRow(row) {
  return `
    <tr>
      <td><strong>${escapeHtml(usageLabel(row.type))}</strong></td>
      <td>${escapeHtml(row.provider || "")}</td>
      <td>${formatNumber(row.count)}</td>
    </tr>
  `;
}

function renderRunRow(run) {
  return `
    <tr>
      <td>${escapeHtml(run.userEmail || "Unknown")}</td>
      <td>
        <strong>${escapeHtml(run.niche || "Campaign")}</strong>
        <span>${escapeHtml(run.location || "")}</span>
      </td>
      <td>
        <strong>${escapeHtml(run.status || "")}</strong>
        ${run.currentStep ? `<span>${escapeHtml(run.currentStep)}</span>` : ""}
      </td>
      <td>
        <strong>${formatNumber(run.qualifiedLeads)} / ${formatNumber(run.leadCount)}</strong>
        ${run.status === "Running" ? `<span>${formatNumber(run.rawResultsFound)} checked</span>` : ""}
      </td>
      <td>${formatDate(run.updatedAt || run.createdAt)}</td>
    </tr>
  `;
}

function usageLabel(type) {
  return String(type || "unknown")
    .replace(/^google_/, "Google ")
    .replace(/_/g, " ");
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;",
    })[char],
  );
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
