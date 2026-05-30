const NUM_SKELETON_CARDS = 3;
const TOKEN_KEY = "id_token";

const els = {
  signInBtn: document.getElementById("signin-btn"),
  signOutBtn: document.getElementById("signout-btn"),
  generateBtn: document.getElementById("generate-btn"),
  userLine: document.getElementById("user-line"),
  results: document.getElementById("results"),
  meta: document.getElementById("meta"),
  error: document.getElementById("error"),
};

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

function getStoredToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

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

function showSkeletons() {
  els.error.hidden = true;
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

function showError(message) {
  els.results.innerHTML = "";
  els.error.textContent = message;
  els.error.hidden = false;
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
  els.error.hidden = true;

  if (!recommendations?.length) {
    showError("No recommendations were returned. Try again in a moment.");
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
        </div>
      `;

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

async function fetchRecommendations(apiUrl, token) {
  const res = await fetch(`${apiUrl}recommendations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    clearToken();
    throw new Error("Your session expired. Please sign in again.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API returned ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function renderSignedIn(claims) {
  els.signInBtn.hidden = true;
  els.generateBtn.hidden = false;
  els.signOutBtn.hidden = false;
  els.userLine.textContent = claims?.email
    ? `Signed in as ${claims.email}`
    : "Signed in";
}

function renderSignedOut() {
  els.signInBtn.hidden = false;
  els.generateBtn.hidden = true;
  els.signOutBtn.hidden = true;
  els.userLine.textContent = "";
  els.results.innerHTML = "";
  els.meta.textContent = "";
}

async function onGenerate(apiUrl) {
  const token = getStoredToken();
  if (!token || !isTokenValid(token)) {
    clearToken();
    renderSignedOut();
    showError("Your session expired. Please sign in again.");
    return;
  }

  els.generateBtn.disabled = true;
  els.generateBtn.textContent = "Generating…";
  showSkeletons();

  try {
    const data = await fetchRecommendations(apiUrl, token);
    renderRecommendations(data);
  } catch (err) {
    showError(err.message ?? "Something went wrong fetching recommendations.");
    if (!getStoredToken()) renderSignedOut();
  } finally {
    els.generateBtn.disabled = false;
    els.generateBtn.textContent = "Get recommendations";
  }
}

(async () => {
  try {
    const config = await loadConfig();
    if (!config.apiUrl || !config.cognito) {
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
      window.location.href = buildLoginUrl(config.cognito);
    });

    els.signOutBtn.addEventListener("click", () => {
      clearToken();
      window.location.href = buildLogoutUrl(config.cognito);
    });

    els.generateBtn.addEventListener("click", () => onGenerate(config.apiUrl));
  } catch (err) {
    showError(`Frontend init failed: ${err.message}`);
  }
})();
