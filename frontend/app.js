const NUM_SKELETON_CARDS = 3;

const els = {
  btn: document.getElementById("generate-btn"),
  results: document.getElementById("results"),
  meta: document.getElementById("meta"),
  error: document.getElementById("error"),
};

async function loadConfig() {
  const res = await fetch("config.json");
  if (!res.ok) throw new Error("Could not load config.json");
  return res.json();
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

async function fetchRecommendations(apiUrl) {
  const res = await fetch(`${apiUrl}recommendations`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API returned ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function onClick(apiUrl) {
  els.btn.disabled = true;
  els.btn.textContent = "Generating…";
  showSkeletons();

  try {
    const data = await fetchRecommendations(apiUrl);
    renderRecommendations(data);
  } catch (err) {
    showError(err.message ?? "Something went wrong fetching recommendations.");
  } finally {
    els.btn.disabled = false;
    els.btn.textContent = "Get recommendations";
  }
}

(async () => {
  try {
    const config = await loadConfig();
    if (!config.apiUrl) throw new Error("config.json is missing apiUrl");
    els.btn.addEventListener("click", () => onClick(config.apiUrl));
  } catch (err) {
    showError(`Frontend init failed: ${err.message}`);
    els.btn.disabled = true;
  }
})();
