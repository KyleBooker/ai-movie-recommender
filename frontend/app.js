const NUM_SKELETON_CARDS = 3;
const TOKEN_KEY = "id_token";

const els = {
  tabs: document.getElementById("tabs"),
  signInBtn: document.getElementById("signin-btn"),
  signOutBtn: document.getElementById("signout-btn"),
  userLine: document.getElementById("user-line"),
  signedOutPane: document.getElementById("signed-out-pane"),
  requestsPane: document.getElementById("requests-pane"),
  servicesPane: document.getElementById("services-pane"),
  jobsPane: document.getElementById("jobs-pane"),
  generateBtn: document.getElementById("generate-btn"),
  refreshRequestsBtn: document.getElementById("refresh-requests-btn"),
  meta: document.getElementById("meta"),
  requestsList: document.getElementById("requests-list"),
  requestsEmpty: document.getElementById("requests-empty"),
  resultsError: document.getElementById("results-error"),
  globalError: document.getElementById("global-error"),
  statTotal: document.getElementById("stat-total"),
  statToday: document.getElementById("stat-today"),
  statWeek: document.getElementById("stat-week"),
  statMonth: document.getElementById("stat-month"),
  tmdbKey: document.getElementById("tmdb-key"),
  omdbKey: document.getElementById("omdb-key"),
  tmdbStatus: document.getElementById("tmdb-status"),
  omdbStatus: document.getElementById("omdb-status"),
  tmdbResult: document.getElementById("tmdb-test-result"),
  omdbResult: document.getElementById("omdb-test-result"),
  newJobBtn: document.getElementById("new-job-btn"),
  refreshJobsBtn: document.getElementById("refresh-jobs-btn"),
  jobsList: document.getElementById("jobs-list"),
  jobsEmpty: document.getElementById("jobs-empty"),
  jobModal: document.getElementById("job-modal"),
  jobModalTitle: document.getElementById("job-modal-title"),
  jobSaveBtn: document.getElementById("job-save-btn"),
  jobModalError: document.getElementById("job-modal-error"),
  jobName: document.getElementById("job-name"),
  jobType: document.getElementById("job-type"),
  jobSchedule: document.getElementById("job-schedule"),
  jobMaxResults: document.getElementById("job-max-results"),
  jobEnabled: document.getElementById("job-enabled"),
};

let editingJobId = null;

const panes = {
  requests: els.requestsPane,
  services: els.servicesPane,
  jobs: els.jobsPane,
};

let APP_CONFIG = null;

// ----- Config + auth -----
async function loadConfig() {
  const res = await fetch("config.json");
  if (!res.ok) throw new Error("Could not load config.json");
  return res.json();
}

function captureTokensFromHash() {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.substring(1)
    : "";
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const idToken = params.get("id_token");
  if (!idToken) return null;
  sessionStorage.setItem(TOKEN_KEY, idToken);
  window.history.replaceState(null, "", window.location.pathname);
  return idToken;
}

const getStoredToken = () => sessionStorage.getItem(TOKEN_KEY);
const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

function parseJwt(token) {
  try {
    const payload = token.split(".")[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function isTokenValid(token) {
  const claims = parseJwt(token);
  if (!claims?.exp) return false;
  return claims.exp * 1000 > Date.now();
}

function buildLoginUrl(cognito) {
  const params = new URLSearchParams({
    client_id: cognito.clientId,
    response_type: "token",
    scope: "openid email profile",
    redirect_uri: cognito.redirectUri,
  });
  return `${cognito.domain}/login?${params.toString()}`;
}

function buildLogoutUrl(cognito) {
  const params = new URLSearchParams({
    client_id: cognito.clientId,
    logout_uri: cognito.redirectUri,
  });
  return `${cognito.domain}/logout?${params.toString()}`;
}

// ----- API client -----
async function apiFetch(path, options = {}) {
  const token = getStoredToken();
  if (!token || !isTokenValid(token)) {
    clearToken();
    renderSignedOut();
    throw new Error("Your session expired. Please sign in again.");
  }
  const res = await fetch(`${APP_CONFIG.apiUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    clearToken();
    renderSignedOut();
    throw new Error("Your session expired. Please sign in again.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ----- Tab management -----
function showTab(name) {
  for (const [key, pane] of Object.entries(panes)) {
    pane.hidden = key !== name;
  }
  for (const btn of els.tabs.querySelectorAll(".tab")) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  if (name === "requests") {
    loadStats();
    loadRequestHistory();
  }
  if (name === "services") loadSettings();
  if (name === "jobs") loadJobs();
}

// ----- Signed-in / signed-out shell -----
function renderSignedIn(claims) {
  els.signInBtn.hidden = true;
  els.signOutBtn.hidden = false;
  els.tabs.hidden = false;
  els.signedOutPane.hidden = true;
  els.userLine.textContent = claims?.email
    ? `Signed in as ${claims.email}`
    : "Signed in";
  showTab("requests");
}

function renderSignedOut() {
  els.signInBtn.hidden = false;
  els.signOutBtn.hidden = true;
  els.tabs.hidden = true;
  els.userLine.textContent = "";
  for (const pane of Object.values(panes)) pane.hidden = true;
  els.signedOutPane.hidden = false;
}

// ----- Requests tab -----
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showSkeletonRequest() {
  const skeleton = Array.from({ length: NUM_SKELETON_CARDS })
    .map(
      () => `
        <article class="skeleton">
          <div class="skeleton-poster"></div>
          <div class="skeleton-body">
            <div class="skeleton-line medium"></div>
            <div class="skeleton-line short"></div>
            <div class="skeleton-line"></div>
            <div class="skeleton-line"></div>
          </div>
        </article>`,
    )
    .join("");
  const pendingCard = `
    <article class="request-card" id="pending-request">
      <header class="request-card-header">
        <h3 class="request-card-title">
          <span>⚡ Generating recommendations…</span>
        </h3>
        <span class="request-card-time">just now</span>
      </header>
      <div class="cards">${skeleton}</div>
    </article>`;
  els.requestsEmpty.hidden = true;
  els.resultsError.hidden = true;
  els.requestsList.insertAdjacentHTML("afterbegin", pendingCard);
}

function renderRecsGrid(recommendations) {
  if (!recommendations?.length) {
    return `<p class="muted">No recommendations in this run.</p>`;
  }
  return `<div class="cards">${recommendations
    .map((rec) => {
      const title = escapeHtml(rec.title);
      const year = escapeHtml(rec.year);
      const reason = escapeHtml(rec.reason);
      const poster = rec.posterUrl
        ? `<img class="poster" loading="lazy" src="${escapeHtml(rec.posterUrl)}" alt="Poster for ${title}" />`
        : `<div class="poster-fallback">No poster found</div>`;
      const cardInner = `
        ${poster}
        <div class="card-body">
          <h2 class="card-title">${title}</h2>
          <span class="card-year">${year}</span>
          <p class="card-reason">${reason}</p>
        </div>`;
      const wrapper = rec.tmdbUrl
        ? `<a href="${escapeHtml(rec.tmdbUrl)}" target="_blank" rel="noopener noreferrer">${cardInner}</a>`
        : cardInner;
      return `<article class="card">${wrapper}</article>`;
    })
    .join("")}</div>`;
}

function renderRequestCard(req) {
  const time = req.runAt ? new Date(req.runAt * 1000).toLocaleString() : "—";
  const label = req.jobName ?? "Manual run";
  const isFailure = req.status === "failed";
  const body = isFailure
    ? `<div class="request-card-error">Failed: ${escapeHtml(
        req.errorMessage ?? "unknown error",
      )}</div>`
    : renderRecsGrid(req.recommendations ?? []);

  return `
    <article class="request-card" data-request-id="${escapeHtml(req.requestId)}">
      <header class="request-card-header">
        <h3 class="request-card-title">
          <span>${escapeHtml(label)}</span>
        </h3>
        <div class="request-card-right">
          <span class="request-card-time">${escapeHtml(time)}</span>
          <button class="icon-btn" data-request-delete title="Delete this run">🗑</button>
        </div>
      </header>
      ${body}
    </article>`;
}

function renderRequestHistory(requests) {
  const pending = document.getElementById("pending-request");
  if (pending) pending.remove();

  if (!requests.length) {
    els.requestsList.innerHTML = "";
    els.requestsEmpty.hidden = false;
    return;
  }
  els.requestsEmpty.hidden = true;
  els.requestsList.innerHTML = requests.map(renderRequestCard).join("");
}

async function loadRequestHistory() {
  try {
    const data = await apiFetch("requests");
    renderRequestHistory(data.recent ?? []);
  } catch (err) {
    els.resultsError.textContent = err.message;
    els.resultsError.hidden = false;
  }
}

async function deleteRequest(requestId) {
  try {
    await apiFetch(`requests/${encodeURIComponent(requestId)}`, {
      method: "DELETE",
    });
    await Promise.all([loadStats(), loadRequestHistory()]);
  } catch (err) {
    els.resultsError.textContent = `Could not delete: ${err.message}`;
    els.resultsError.hidden = false;
  }
}

async function onGenerate() {
  els.generateBtn.disabled = true;
  els.generateBtn.textContent = "Generating…";
  showSkeletonRequest();
  try {
    await apiFetch("recommendations");
    // Result was persisted server-side; refresh from history so the new run
    // appears at the top alongside scheduled runs.
    await Promise.all([loadStats(), loadRequestHistory()]);
  } catch (err) {
    const pending = document.getElementById("pending-request");
    if (pending) pending.remove();
    els.resultsError.textContent = err.message ?? "Something went wrong.";
    els.resultsError.hidden = false;
  } finally {
    els.generateBtn.disabled = false;
    els.generateBtn.textContent = "Get recommendations";
  }
}

async function loadStats() {
  try {
    const stats = await apiFetch("requests");
    els.statTotal.textContent = stats.totalRequests ?? 0;
    els.statToday.textContent = stats.today ?? 0;
    els.statWeek.textContent = stats.thisWeek ?? 0;
    els.statMonth.textContent = stats.thisMonth ?? 0;
  } catch (err) {
    console.error("Could not load stats:", err);
    for (const el of [els.statTotal, els.statToday, els.statWeek, els.statMonth]) {
      el.textContent = "—";
    }
  }
}

// ----- Services tab -----
function setStatusPill(pillEl, state, label) {
  pillEl.className = `status-pill ${state}`;
  pillEl.innerHTML = `<span class="status-dot"></span> ${label}`;
}

async function loadSettings() {
  try {
    const settings = await apiFetch("settings");
    setStatusPill(
      els.tmdbStatus,
      settings.hasTmdbKey ? "status-connected" : "status-not-set",
      settings.hasTmdbKey ? "Connected" : "Not set",
    );
    setStatusPill(
      els.omdbStatus,
      settings.hasOmdbKey ? "status-connected" : "status-not-set",
      settings.hasOmdbKey ? "Connected" : "Not set",
    );
    // Mask existing values: don't pre-fill, just show placeholder.
    if (settings.hasTmdbKey) els.tmdbKey.placeholder = "•••••••••••••••• (saved)";
    if (settings.hasOmdbKey) els.omdbKey.placeholder = "•••••••••••••••• (saved)";
  } catch (err) {
    console.error("Could not load settings:", err);
  }
}

async function saveSetting(field, value) {
  return apiFetch("settings", {
    method: "PUT",
    body: JSON.stringify({ [field]: value }),
  });
}

async function testConnection(service, currentInputValue) {
  const body = currentInputValue ? { apiKey: currentInputValue } : {};
  return apiFetch(`settings/test/${service}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function showTestResult(resultEl, ok, message) {
  resultEl.hidden = false;
  resultEl.className = `test-result ${ok ? "ok" : "fail"}`;
  resultEl.textContent = message;
}

function wireServicesTab() {
  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.toggle);
      if (target) target.type = target.type === "password" ? "text" : "password";
    });
  });

  document.querySelector('[data-action="save-tmdb"]').addEventListener("click", async () => {
    const value = els.tmdbKey.value.trim();
    if (!value) {
      showTestResult(els.tmdbResult, false, "Enter a key before saving.");
      return;
    }
    try {
      await saveSetting("tmdbApiKey", value);
      els.tmdbKey.value = "";
      els.tmdbKey.placeholder = "•••••••••••••••• (saved)";
      setStatusPill(els.tmdbStatus, "status-connected", "Connected");
      showTestResult(els.tmdbResult, true, "Saved.");
    } catch (err) {
      showTestResult(els.tmdbResult, false, err.message);
    }
  });

  document.querySelector('[data-action="save-omdb"]').addEventListener("click", async () => {
    const value = els.omdbKey.value.trim();
    if (!value) {
      showTestResult(els.omdbResult, false, "Enter a key before saving.");
      return;
    }
    try {
      await saveSetting("omdbApiKey", value);
      els.omdbKey.value = "";
      els.omdbKey.placeholder = "•••••••••••••••• (saved)";
      setStatusPill(els.omdbStatus, "status-connected", "Connected");
      showTestResult(els.omdbResult, true, "Saved.");
    } catch (err) {
      showTestResult(els.omdbResult, false, err.message);
    }
  });

  document.querySelector('[data-action="test-tmdb"]').addEventListener("click", async () => {
    showTestResult(els.tmdbResult, true, "Testing…");
    try {
      const result = await testConnection("tmdb", els.tmdbKey.value.trim());
      showTestResult(els.tmdbResult, result.ok, result.message);
    } catch (err) {
      showTestResult(els.tmdbResult, false, err.message);
    }
  });

  document.querySelector('[data-action="test-omdb"]').addEventListener("click", async () => {
    showTestResult(els.omdbResult, true, "Testing…");
    try {
      const result = await testConnection("omdb", els.omdbKey.value.trim());
      showTestResult(els.omdbResult, result.ok, result.message);
    } catch (err) {
      showTestResult(els.omdbResult, false, err.message);
    }
  });
}

// ----- Jobs tab -----
function formatDate(seconds) {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString();
}

function renderJobs(jobs) {
  if (!jobs.length) {
    els.jobsList.innerHTML = "";
    els.jobsEmpty.hidden = false;
    return;
  }
  els.jobsEmpty.hidden = true;

  els.jobsList.innerHTML = jobs
    .map((job) => {
      const name = escapeHtml(job.name);
      const typeLabel =
        job.type === "DISCOVER" ? "🔍 DISCOVER" : "👥 RECOMMENDATION";
      const typeClass =
        job.type === "DISCOVER" ? "pill-discover" : "pill-recommendation";
      const stateClass = job.enabled ? "pill-active" : "pill-disabled";
      const stateLabel = job.enabled ? "● Active" : "○ Disabled";
      const toggleLabel = job.enabled ? "⏸ Disable" : "▶ Enable";
      return `
        <article class="job-card" data-job-id="${escapeHtml(job.jobId)}">
          <header class="job-card-header">
            <h3 class="job-card-title">${name}</h3>
            <span class="status-pill ${stateClass}">${stateLabel}</span>
          </header>
          <div class="job-card-pills">
            <span class="pill ${typeClass}">${typeLabel}</span>
          </div>
          <dl class="job-card-meta">
            <dt>⏰ Schedule</dt><dd>${escapeHtml(job.scheduleLabel ?? job.scheduleExpression)}</dd>
            <dt>≡ Max Results</dt><dd>${escapeHtml(job.maxResults)}</dd>
            <dt>📅 Last Run</dt><dd>${escapeHtml(formatDate(job.lastRunAt))}</dd>
          </dl>
          <div class="job-card-actions">
            <button class="secondary-btn" data-job-action="run">⚡ Run</button>
            <button class="secondary-btn" data-job-action="toggle">${toggleLabel}</button>
            <button class="secondary-btn" data-job-action="edit">✎ Edit</button>
            <button class="danger-btn" data-job-action="delete">🗑</button>
          </div>
        </article>`;
    })
    .join("");
}

let currentJobs = [];

async function loadJobs() {
  // Only show the placeholder if we have nothing on screen yet; otherwise
  // leave existing cards visible until fresh data arrives.
  if (!currentJobs.length) {
    els.jobsList.innerHTML = `<div class="muted">Loading…</div>`;
  }
  try {
    const { jobs } = await apiFetch("jobs");
    currentJobs = jobs ?? [];
    renderJobs(currentJobs);
  } catch (err) {
    if (!currentJobs.length) els.jobsList.innerHTML = "";
    els.jobsEmpty.hidden = true;
    els.globalError.textContent = `Could not load jobs: ${err.message}`;
    els.globalError.hidden = false;
  }
}

function openJobModal(job) {
  editingJobId = job?.jobId ?? null;
  els.jobModalTitle.textContent = job ? "Edit Job" : "New Job";
  els.jobSaveBtn.textContent = job ? "Save Changes" : "Create Job";
  els.jobName.value = job?.name ?? "";
  els.jobType.value = job?.type ?? "RECOMMENDATION";
  els.jobSchedule.value = job
    ? `${job.scheduleExpression}|${job.scheduleLabel ?? job.scheduleExpression}`
    : els.jobSchedule.options[0].value;
  els.jobMaxResults.value = job?.maxResults ?? 5;
  els.jobEnabled.checked = job ? job.enabled : true;
  els.jobModalError.hidden = true;
  els.jobModal.hidden = false;
}

function closeJobModal() {
  els.jobModal.hidden = true;
  editingJobId = null;
}

async function saveJob() {
  const [scheduleExpression, scheduleLabel] = els.jobSchedule.value.split("|");
  const payload = {
    name: els.jobName.value.trim() || "Untitled Job",
    type: els.jobType.value,
    scheduleExpression,
    scheduleLabel,
    maxResults: Number(els.jobMaxResults.value) || 5,
    enabled: els.jobEnabled.checked,
  };
  els.jobSaveBtn.disabled = true;
  els.jobSaveBtn.textContent = "Saving…";
  try {
    if (editingJobId) {
      await apiFetch(`jobs/${editingJobId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      await apiFetch("jobs", { method: "POST", body: JSON.stringify(payload) });
    }
    closeJobModal();
    await loadJobs();
  } catch (err) {
    els.jobModalError.textContent = err.message;
    els.jobModalError.hidden = false;
  } finally {
    els.jobSaveBtn.disabled = false;
    els.jobSaveBtn.textContent = editingJobId ? "Save Changes" : "Create Job";
  }
}

async function onJobAction(jobId, action) {
  const job = currentJobs.find((j) => j.jobId === jobId);
  if (!job) return;
  try {
    if (action === "run") {
      await apiFetch(`jobs/${jobId}/run`, { method: "POST" });
      alert("Run started. Results appear under Requests in a few seconds.");
    } else if (action === "toggle") {
      // Optimistic update: flip locally and re-render immediately so the card
      // never disappears. Revert if the backend call fails.
      const prev = job.enabled;
      job.enabled = !prev;
      renderJobs(currentJobs);
      try {
        await apiFetch(`jobs/${jobId}`, {
          method: "PUT",
          body: JSON.stringify({ enabled: job.enabled }),
        });
      } catch (err) {
        job.enabled = prev;
        renderJobs(currentJobs);
        throw err;
      }
    } else if (action === "edit") {
      openJobModal(job);
    } else if (action === "delete") {
      if (!confirm(`Delete job "${job.name}"? This cannot be undone.`)) return;
      // Optimistic removal — drop from the array, re-render, then sync.
      const prevJobs = currentJobs.slice();
      currentJobs = currentJobs.filter((j) => j.jobId !== jobId);
      renderJobs(currentJobs);
      try {
        await apiFetch(`jobs/${jobId}`, { method: "DELETE" });
      } catch (err) {
        currentJobs = prevJobs;
        renderJobs(currentJobs);
        throw err;
      }
    }
  } catch (err) {
    els.globalError.textContent = `Action failed: ${err.message}`;
    els.globalError.hidden = false;
  }
}

function wireJobsTab() {
  els.newJobBtn.addEventListener("click", () => openJobModal(null));
  els.refreshJobsBtn.addEventListener("click", () => loadJobs());
  els.jobSaveBtn.addEventListener("click", saveJob);
  document.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", closeJobModal);
  });
  els.jobsList.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-job-action]");
    if (!btn) return;
    const card = btn.closest("[data-job-id]");
    if (!card) return;
    onJobAction(card.dataset.jobId, btn.dataset.jobAction);
  });
}

// ----- Init -----
(async () => {
  try {
    APP_CONFIG = await loadConfig();
    if (!APP_CONFIG.apiUrl || !APP_CONFIG.cognito) {
      throw new Error("config.json is missing apiUrl or cognito section");
    }

    captureTokensFromHash();
    const token = getStoredToken();

    if (token && isTokenValid(token)) {
      renderSignedIn(parseJwt(token));
    } else {
      clearToken();
      renderSignedOut();
    }

    els.signInBtn.addEventListener("click", () => {
      window.location.href = buildLoginUrl(APP_CONFIG.cognito);
    });
    els.signOutBtn.addEventListener("click", () => {
      clearToken();
      window.location.href = buildLogoutUrl(APP_CONFIG.cognito);
    });

    for (const btn of els.tabs.querySelectorAll(".tab")) {
      btn.addEventListener("click", () => showTab(btn.dataset.tab));
    }

    els.generateBtn.addEventListener("click", onGenerate);
    els.refreshRequestsBtn.addEventListener("click", () => {
      loadStats();
      loadRequestHistory();
    });
    els.requestsList.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-request-delete]");
      if (!btn) return;
      const card = btn.closest("[data-request-id]");
      if (!card) return;
      deleteRequest(card.dataset.requestId);
    });
    wireServicesTab();
    wireJobsTab();
  } catch (err) {
    els.globalError.textContent = `Init failed: ${err.message}`;
    els.globalError.hidden = false;
  }
})();
