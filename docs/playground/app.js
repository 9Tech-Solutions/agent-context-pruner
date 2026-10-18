import {
  validateReport,
  findRowByThreshold,
  parseHashThreshold,
  formatPercent,
  generateMarkdownSummary,
  generateSvgCard,
} from "./playground-core.js";

const REPORT_URL = "../../examples/synthetic-session-evaluation/report.json";

let state = {
  report: null,
  currentRow: null,
  currentThreshold: 0.05,
};

const elements = {
  errorBanner: document.getElementById("error-banner"),
  errorMessage: document.getElementById("error-message"),
  slider: document.getElementById("threshold-slider"),
  displayThreshold: document.getElementById("display-threshold"),
  presetButtons: document.querySelectorAll(".btn-preset"),
  netReduction: document.getElementById("metric-net-reduction"),
  grossReduction: document.getElementById("metric-gross-reduction"),
  countKept: document.getElementById("count-kept"),
  countTrunc: document.getElementById("count-trunc"),
  countDrop: document.getElementById("count-drop"),
  actionSummary: document.getElementById("action-summary-text"),
  metricLost: document.getElementById("metric-lost"),
  lossDetail: document.getElementById("metric-loss-detail"),
  barKept: document.getElementById("bar-seg-kept"),
  barTrunc: document.getElementById("bar-seg-trunc"),
  barDrop: document.getElementById("bar-seg-drop"),
  barLabel: document.getElementById("bar-percentage-label"),
  cardNetQuote: document.getElementById("card-net-quote"),
  btnCopyMarkdown: document.getElementById("btn-copy-markdown"),
  btnDownloadCard: document.getElementById("btn-download-card"),
  btnShareLink: document.getElementById("btn-share-link"),
  copyFeedback: document.getElementById("copy-feedback"),
};

function showError(msg) {
  if (elements.errorBanner) {
    elements.errorBanner.classList.add("visible");
    if (elements.errorMessage) {
      elements.errorMessage.textContent = msg;
    }
  }
}

function hideError() {
  if (elements.errorBanner) {
    elements.errorBanner.classList.remove("visible");
  }
}

function showFeedback(text) {
  if (!elements.copyFeedback) return;
  elements.copyFeedback.textContent = text;
  clearTimeout(elements.copyFeedback._timer);
  elements.copyFeedback._timer = setTimeout(() => {
    elements.copyFeedback.textContent = "";
  }, 3500);
}

function applyReport(data) {
  const result = validateReport(data);
  if (!result.ok) {
    showError(`Invalid report format: ${result.error}`);
    return;
  }

  hideError();
  document.querySelectorAll("input[type=range], .btn-preset, .btn-action").forEach((control) => {
    control.disabled = false;
  });
  state.report = result.report;

  // Determine initial threshold from URL fragment, or default to 0.05
  const allowed = state.report.rows.map((r) => r.threshold);
  const hashThreshold = parseHashThreshold(window.location.hash, allowed);
  const initialThreshold = hashThreshold !== null ? hashThreshold : 0.05;

  setThreshold(initialThreshold, false);
}

function setThreshold(threshold, updateHash = true) {
  if (!state.report) return;

  const row = findRowByThreshold(state.report.rows, threshold);
  if (!row) return;

  state.currentThreshold = row.threshold;
  state.currentRow = row;

  // Update slider element
  if (elements.slider) {
    elements.slider.value = row.threshold.toFixed(2);
    elements.slider.setAttribute("aria-valuenow", row.threshold.toFixed(2));
  }

  // Update display readout
  if (elements.displayThreshold) {
    elements.displayThreshold.textContent = row.threshold.toFixed(2);
  }

  // Update active preset button
  const currentCents = Math.round(row.threshold * 100);
  elements.presetButtons.forEach((btn) => {
    const btnVal = Math.round(parseFloat(btn.getAttribute("data-threshold")) * 100);
    btn.classList.toggle("active", btnVal === currentCents);
  });

  // Update metrics
  renderMetrics(row, state.report.scoredCalls);

  // Update URL fragment
  if (updateHash) {
    const hashStr = `threshold=${row.threshold.toFixed(2)}`;
    if (window.location.hash !== `#${hashStr}`) {
      window.history.replaceState(null, "", `#${hashStr}`);
    }
  }
}

function renderMetrics(row, totalCalls) {
  const net = formatPercent(row.netReduction);
  const gross = formatPercent(row.reduction);

  if (elements.netReduction) {
    elements.netReduction.textContent = net;
    elements.netReduction.className =
      "metric-value " +
      (row.netReduction < 0 ? "negative" : row.netReduction > 0 ? "positive" : "neutral");
  }

  if (elements.grossReduction) {
    elements.grossReduction.textContent = `Character reduction: ${gross}`;
  }

  if (elements.countKept) elements.countKept.textContent = `${row.kept} Kept`;
  if (elements.countTrunc) elements.countTrunc.textContent = `${row.truncated} Truncated`;
  if (elements.countDrop) elements.countDrop.textContent = `${row.dropped} Dropped`;

  if (elements.actionSummary) {
    if (row.dropped > 0) {
      elements.actionSummary.textContent = `${row.dropped} tool calls dropped in this replay`;
    } else if (row.truncated > 0) {
      elements.actionSummary.textContent = `${row.truncated} outputs truncated to head characters`;
    } else {
      elements.actionSummary.textContent = "All scored calls retained word for word";
    }
  }

  if (elements.metricLost) {
    elements.metricLost.textContent = `${row.lost} / ${row.needed}`;
    elements.metricLost.className = "metric-value " + (row.lost > 0 ? "negative" : "neutral");
  }

  if (elements.lossDetail) {
    const lossPct = formatPercent(row.lossRate);
    elements.lossDetail.textContent = `${lossPct} loss in this one-result fixture. The 0.05 baseline loses none.`;
  }

  const scenario = document.getElementById("scenario-status");
  if (scenario) {
    scenario.textContent =
      row.lost > 0
        ? "Failure case: this threshold loses the only later-reused result. The 0.05 baseline keeps all 11 calls, with no loss or reduction."
        : row.truncated > 0
          ? "No labeled result is lost, but this fixture still has no context reduction at this threshold."
          : "Baseline: all 11 calls are kept. Nothing is lost and nothing is removed.";
  }

  // Segmented Bar Calculation
  const keptPct = Math.round((row.kept / totalCalls) * 100);
  const truncPct = Math.round((row.truncated / totalCalls) * 100);
  const dropPct = 100 - keptPct - truncPct;

  if (elements.barKept) elements.barKept.style.width = `${keptPct}%`;
  if (elements.barTrunc) elements.barTrunc.style.width = `${truncPct}%`;
  if (elements.barDrop) elements.barDrop.style.width = `${dropPct}%`;

  if (elements.barLabel) {
    elements.barLabel.textContent = `Kept: ${keptPct}% • Truncated: ${truncPct}% • Dropped: ${dropPct}%`;
  }

  if (elements.cardNetQuote) {
    elements.cardNetQuote.textContent = "-24% net reduction after modeled re-reads";
  }
}

async function copyText(text, successMsg) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      showFeedback(successMsg);
      return;
    }
    // Fallback for older contexts
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    if (!document.execCommand("copy")) throw new Error("Copy was refused");
    document.body.removeChild(textArea);
    showFeedback(successMsg);
  } catch {
    showFeedback("Unable to copy to clipboard.");
  }
}

async function handleDownloadCard() {
  if (!state.report || !state.currentRow) return;
  const row = state.currentRow;
  const svg = generateSvgCard(state.report, row);
  const source = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1440;
    canvas.height = 880;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("PNG unavailable");
    const url = URL.createObjectURL(png);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pruner-synthetic-eval-${row.threshold.toFixed(2)}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showFeedback("Downloaded PNG result card. Its synthetic label stays in the image.");
  } catch {
    showFeedback("Could not create the PNG card. Please try again.");
  } finally {
    URL.revokeObjectURL(source);
  }
}

function handleCopyMarkdown() {
  if (!state.report || !state.currentRow) return;
  const md = generateMarkdownSummary(state.report, state.currentRow);
  void copyText(md, "Copied Markdown summary to clipboard");
}

function handleCopyShareLink() {
  if (!state.currentRow) return;
  const baseUrl = window.location.origin + window.location.pathname;
  const shareUrl = `${baseUrl}#threshold=${state.currentRow.threshold.toFixed(2)}`;
  void copyText(
    shareUrl,
    `Copied shareable link with #threshold=${state.currentRow.threshold.toFixed(2)}`,
  );
}

async function init() {
  document.querySelectorAll("input[type=range], .btn-preset, .btn-action").forEach((control) => {
    control.disabled = true;
  });
  // Bind UI control listeners
  if (elements.slider) {
    elements.slider.addEventListener("input", (e) => {
      setThreshold(parseFloat(e.target.value), true);
    });
  }

  elements.presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = parseFloat(btn.getAttribute("data-threshold"));
      setThreshold(val, true);
    });
  });

  if (elements.btnCopyMarkdown) {
    elements.btnCopyMarkdown.addEventListener("click", handleCopyMarkdown);
  }

  if (elements.btnDownloadCard) {
    elements.btnDownloadCard.addEventListener("click", handleDownloadCard);
  }

  if (elements.btnShareLink) {
    elements.btnShareLink.addEventListener("click", handleCopyShareLink);
  }

  window.addEventListener("hashchange", () => {
    if (!state.report) return;
    const allowed = state.report.rows.map((r) => r.threshold);
    const parsed = parseHashThreshold(window.location.hash, allowed);
    if (parsed !== null && parsed !== state.currentThreshold) {
      setThreshold(parsed, false);
    }
  });

  // Attempt to fetch real precomputed report.json
  try {
    const response = await fetch(REPORT_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    applyReport(data);
  } catch (err) {
    showError(
      `Failed to fetch "${REPORT_URL}" (${err.message}). ` +
        `If opening directly via file://, browser security restricts cross-file fetch. ` +
        `Serve the repository over HTTP to explore this fixture.`,
    );
  }
}

// Start application
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  void init();
}
