# Offline Evaluator Playground

A static browser instrument to explore the precomputed synthetic evaluation report without installing CLI dependencies or configuring API credentials.

## Overview

The playground loads `examples/synthetic-session-evaluation/report.json` through a relative URL (`../../examples/synthetic-session-evaluation/report.json`).

The report contains aggregate results from running the offline rules evaluator (`heuristic:v2`) across 19 discrete keep thresholds (0.05 to 0.95) on 11 scored tool calls in `session.jsonl`.

### Key observations

- **Threshold 0.05 (Baseline):** 11 kept, 0 truncated, 0 dropped, 0 needed results lost. Gross and net reduction are both 0%.
- **Threshold 0.85:** 8 kept, 3 truncated, 0 dropped, 0 needed results lost.
- **Threshold 0.90:** 5 kept, 6 truncated, 0 dropped, 0 needed results lost.
- **Threshold 0.95 (Failure Mode):** 1 kept, 3 truncated, 7 dropped. 1 needed result is lost, producing -24% net reduction.

The evaluator measures characters and models a full re-read for each lost result. At 0.95,
pruning's bookkeeping notes already produce expansion before that penalty. The -24% net figure
includes the modeled re-read. This is not an observed agent retry, token measurement, billing
result, or subscription-usage saving.

## Running locally

Because modern browsers restrict cross-file `fetch` when opened from `file://`, serve the repository with a local static server:

```sh
# Using python
python -m http.server 8000
```

Then open `http://localhost:8000/docs/playground/` in your browser.

Use HTTP rather than `file://`: browser ES modules and relative fetches require it. The
playground uses the canonical report in `examples/`, without a second embedded copy to maintain.

## Running tests

The playground logic and export formats are verified using Node's built-in test runner:

```sh
node --test docs/playground/playground.test.js
```

## Features

- **Discrete threshold slider:** Inspects each recorded row from 0.05 to 0.95.
- **Dark result band:** High-contrast readout of net reduction, actions (kept, truncated, dropped), and lost results.
- **Proportional segment bar:** Visual distribution of the 11 scored calls.
- **Shareable state:** Safe URL fragment updates (for example, `#threshold=0.95`).
- **Markdown export:** One-click copy of an aggregate summary.
- **PNG export:** Downloads a 1440x880 result card with the `SYNTHETIC / PRECOMPUTED` label and repository URL. The browser renders it from an escaped SVG template.
- **Zero dependencies:** Standard HTML, CSS, and ES modules using native system fonts.
