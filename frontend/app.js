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
  meta: document.getElementById("meta"),
  results: document.getElementById("results"),
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
};

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
  if (name === "requests") loadStats();
  if (name === "services") loadSettings();
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
function showSkeletons() {
  els.resultsError.hidden = true;
  els.meta.textContent = "";
  els.results.innerHTML = Array.from({ length: NUM_SKELETON_CARDS })
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
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderRecommendations({ recommendations, meta }) {
  els.resultsError.hidden = true;

  if (!recommendations?.length) {
    showResultsError("No recommendations returned. Try again in a moment.");
    return;
  }

  els.results.innerHTML = recommendations
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
    .join("");

  if (meta?.basedOnMovieCount) {
    els.meta.textContent = `Based on ${meta.basedOnMovieCount} movies you've watched · model: ${meta.modelId ?? "unknown"}`;
  }
}

function showResultsError(message) {
  els.results.innerHTML = "";
  els.resultsError.textContent = message;
  els.resultsError.hidden = false;
}

async function onGenerate() {
  els.generateBtn.disabled = true;
  els.generateBtn.textContent = "Generating…";
  showSkeletons();
  try {
    const data = await apiFetch("recommendations");
    renderRecommendations(data);
  } catch (err) {
    showResultsError(err.message ?? "Something went wrong.");
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
    wireServicesTab();
  } catch (err) {
    els.globalError.textContent = `Init failed: ${err.message}`;
    els.globalError.hidden = false;
  }
})();
