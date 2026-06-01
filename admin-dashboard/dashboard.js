"use strict";

// Paste the deployed getAnalyticsStats URL here after firebase deploy
const STATS_ENDPOINT = "PASTE_GET_ANALYTICS_STATS_URL_HERE";

const STORAGE_KEY = "ecoprompt_admin_key";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const adminKeyInput  = document.getElementById("adminKey");
const saveKeyBtn     = document.getElementById("saveKeyBtn");
const clearKeyBtn    = document.getElementById("clearKeyBtn");
const authStatus     = document.getElementById("authStatus");
const refreshBtn     = document.getElementById("refreshBtn");
const errorBanner    = document.getElementById("errorBanner");
const datePicker     = document.getElementById("datePicker");
const monthPicker    = document.getElementById("monthPicker");
const dateInput      = document.getElementById("dateInput");
const monthInput     = document.getElementById("monthInput");
const segBtns        = document.querySelectorAll(".seg-btn");

// ── State ─────────────────────────────────────────────────────────────────────
let currentRange = "today";

// ── Init ──────────────────────────────────────────────────────────────────────
(function init() {
  // Set date/month pickers to today / current month as defaults
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const monthStr = now.toISOString().slice(0, 7);
  dateInput.value  = todayStr;
  monthInput.value = monthStr;

  // Restore saved key
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    adminKeyInput.value = saved;
    authStatus.textContent = "Admin key loaded from local storage.";
  }
})();

// ── Auth controls ─────────────────────────────────────────────────────────────
saveKeyBtn.addEventListener("click", () => {
  const key = adminKeyInput.value.trim();
  if (!key) {
    authStatus.textContent = "Enter a key before saving.";
    return;
  }
  localStorage.setItem(STORAGE_KEY, key);
  authStatus.textContent = "Key saved to local storage.";
});

clearKeyBtn.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  adminKeyInput.value = "";
  authStatus.textContent = "Saved key cleared.";
});

// ── Range selector ────────────────────────────────────────────────────────────
segBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    segBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentRange = btn.dataset.range;

    if (currentRange === "today") {
      datePicker.classList.remove("hidden");
      monthPicker.classList.add("hidden");
    } else if (currentRange === "month") {
      datePicker.classList.add("hidden");
      monthPicker.classList.remove("hidden");
    } else {
      datePicker.classList.add("hidden");
      monthPicker.classList.add("hidden");
    }
  });
});

// ── Refresh ───────────────────────────────────────────────────────────────────
refreshBtn.addEventListener("click", fetchAndRender);

// ── Fetch ─────────────────────────────────────────────────────────────────────
async function fetchAndRender() {
  hideError();

  if (STATS_ENDPOINT === "PASTE_GET_ANALYTICS_STATS_URL_HERE") {
    showError("Stats endpoint not configured. Open dashboard.js and set STATS_ENDPOINT to the deployed Cloud Function URL.");
    return;
  }

  const adminKey = adminKeyInput.value.trim();
  if (!adminKey) {
    showError("Enter your admin key above, then click Refresh.");
    return;
  }

  const params = new URLSearchParams({ range: currentRange });
  if (currentRange === "today")  params.set("date",  dateInput.value);
  if (currentRange === "month")  params.set("month", monthInput.value);

  refreshBtn.textContent = "Loading…";
  refreshBtn.disabled = true;

  try {
    const res = await fetch(`${STATS_ENDPOINT}?${params}`, {
      headers: { "x-admin-key": adminKey }
    });

    if (res.status === 403) {
      showError("Access denied (403). Check your admin key.");
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(`Server error ${res.status}: ${body.error || "unknown"}`);
      return;
    }

    const data = await res.json();
    render(data);
  } catch (err) {
    showError(`Network error: ${err.message}`);
  } finally {
    refreshBtn.textContent = "Refresh";
    refreshBtn.disabled = false;
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(data) {
  const s = data.summary || {};

  // Stat cards
  setText("val-totalUsers",     fmt(s.totalUsers));
  setText("val-activeUsers",    fmt(s.activeUsers));
  setText("val-prompts",        fmt(s.totalPromptsOptimized));
  setText("val-tokensSaved",    fmt(s.totalTokensSaved));
  setText("val-originalTokens", fmt(s.totalOriginalTokens));
  setText("val-optimizedTokens",fmt(s.totalOptimizedTokens));
  setText("val-reduction",      s.averageReductionPercent + "%");
  setText("val-energy",         s.estimatedEnergyWhSaved + " Wh");
  setText("val-water",          s.estimatedWaterMlSaved + " mL");

  const rangeLabelMap = { today: "today", month: "this month", all: "all time" };
  setText("sub-activeUsers", `in range: ${rangeLabelMap[data.range] || data.range}`);

  // Impact section
  const avgPerPrompt = s.totalPromptsOptimized
    ? Math.round(s.totalTokensSaved / s.totalPromptsOptimized)
    : 0;

  const users = data.users || [];
  const mostActive = users.slice().sort((a, b) => b.promptsOptimized - a.promptsOptimized)[0];
  const bestReduction = users.slice().sort((a, b) => b.reductionPercent - a.reductionPercent)[0];

  setText("imp-tokensAvoided",  fmt(s.totalTokensSaved));
  setText("imp-avgPerPrompt",   fmt(avgPerPrompt));
  setText("imp-mostActive",     mostActive ? `${mostActive.label} (${fmt(mostActive.promptsOptimized)} prompts)` : "—");
  setText("imp-bestReduction",  bestReduction ? `${bestReduction.label} (${bestReduction.reductionPercent}%)` : "—");

  // Charts — per user
  renderBarChart("chartTokensSaved", users, "tokensSaved",    "Tokens Saved", "#1a7a82");
  renderBarChart("chartPrompts",     users, "promptsOptimized","Prompts",     "#0f4f8a");
  renderBarChart("chartReduction",   users, "reductionPercent","Reduction %", "#1e7e4e");

  // Trend charts
  renderTrendChart("chartDailyTrend",   data.dailyTrend   || [], "date",  "tokensSaved", "Tokens Saved", "#1a7a82");
  renderTrendChart("chartMonthlyTrend", data.monthlyTrend || [], "month", "tokensSaved", "Tokens Saved", "#0f4f8a");

  // Top users table
  renderTopUsersTable(data.topUsersByTokensSaved || []);
}

// ── Bar chart (div-based) ─────────────────────────────────────────────────────
function renderBarChart(containerId, rows, valueKey, label, color) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  if (!rows.length) {
    container.innerHTML = '<p style="color:#5a6a7e;font-size:13px;padding:12px 0">No data for selected range.</p>';
    return;
  }

  const max = Math.max(...rows.map((r) => r[valueKey] || 0), 1);
  const chart = document.createElement("div");
  chart.className = "bar-chart";

  rows.forEach((row) => {
    const val = row[valueKey] || 0;
    const pct = Math.round((val / max) * 100);

    const col = document.createElement("div");
    col.className = "bar-col";

    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.height = `${pct}%`;
    fill.style.background = color;
    fill.dataset.tip = `${row.label}: ${fmtVal(valueKey, val)}`;

    const lbl = document.createElement("span");
    lbl.className = "bar-label";
    lbl.textContent = row.label;

    col.appendChild(fill);
    col.appendChild(lbl);
    chart.appendChild(col);
  });

  container.appendChild(chart);
}

// ── Trend chart (canvas) ──────────────────────────────────────────────────────
function renderTrendChart(containerId, rows, xKey, yKey, yLabel, color) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  if (!rows.length) {
    container.innerHTML = '<p style="color:#5a6a7e;font-size:13px;padding:12px 0">No trend data available.</p>';
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.className = "trend-canvas";
  container.appendChild(canvas);

  // Use logical pixel dimensions; let CSS scale
  const W = 560, H = 160;
  const PAD = { top: 10, right: 16, bottom: 36, left: 52 };
  canvas.width  = W;
  canvas.height = H;
  canvas.style.width  = "100%";
  canvas.style.height = "160px";

  const ctx = canvas.getContext("2d");
  const vals = rows.map((r) => r[yKey] || 0);
  const maxVal = Math.max(...vals, 1);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top  - PAD.bottom;

  // Background
  ctx.fillStyle = "#f4f6fa";
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = "#dde3ec";
  ctx.lineWidth = 1;
  [0, 0.25, 0.5, 0.75, 1].forEach((frac) => {
    const y = PAD.top + plotH * (1 - frac);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + plotW, y);
    ctx.stroke();

    ctx.fillStyle = "#5a6a7e";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(fmtShort(maxVal * frac), PAD.left - 5, y + 4);
  });

  // X labels (every nth)
  const n = rows.length;
  const step = n <= 12 ? 1 : Math.ceil(n / 10);
  ctx.fillStyle = "#5a6a7e";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  rows.forEach((r, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    const x = PAD.left + (i / Math.max(n - 1, 1)) * plotW;
    const lbl = r[xKey].length > 7 ? r[xKey].slice(5) : r[xKey];
    ctx.fillText(lbl, x, H - 6);
  });

  // Line
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  rows.forEach((r, i) => {
    const x = PAD.left + (i / Math.max(n - 1, 1)) * plotW;
    const y = PAD.top  + plotH * (1 - (r[yKey] || 0) / maxVal);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Dots
  rows.forEach((r, i) => {
    const x = PAD.left + (i / Math.max(n - 1, 1)) * plotW;
    const y = PAD.top  + plotH * (1 - (r[yKey] || 0) / maxVal);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
}

// ── Top users table ───────────────────────────────────────────────────────────
function renderTopUsersTable(topUsers) {
  const tbody = document.getElementById("topUsersBody");
  tbody.innerHTML = "";

  if (!topUsers.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No data for selected range.</td></tr>';
    return;
  }

  topUsers.forEach((u, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><strong>${u.label}</strong></td>
      <td>${fmt(u.tokensSaved)}</td>
      <td>${fmt(u.promptsOptimized)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function fmt(n) {
  if (n == null || n === "") return "—";
  return Number(n).toLocaleString();
}

function fmtShort(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return Math.round(n).toString();
}

function fmtVal(key, val) {
  if (key === "reductionPercent") return val + "%";
  return fmt(val);
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.remove("hidden");
}

function hideError() {
  errorBanner.textContent = "";
  errorBanner.classList.add("hidden");
}
