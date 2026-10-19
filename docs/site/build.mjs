import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? "_site");
const files = [
  ["docs/site/index.html", "index.html"],
  ["docs/site/styles.css", "styles.css"],
  ["docs/assets/pruner-artwork.png", "assets/pruner-artwork.png"],
  ["docs/assets/playground-preview.png", "assets/playground-preview.png"],
  ["docs/assets/readme-hero.png", "assets/readme-hero.png"],
  ["docs/playground/index.html", "docs/playground/index.html"],
  ["docs/playground/styles.css", "docs/playground/styles.css"],
  ["docs/playground/app.js", "docs/playground/app.js"],
  ["docs/playground/playground-core.js", "docs/playground/playground-core.js"],
  [
    "examples/synthetic-session-evaluation/report.json",
    "examples/synthetic-session-evaluation/report.json",
  ],
];

for (const [source, target] of files) {
  const destination = resolve(output, target);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(resolve(root, source), destination);
}
writeFileSync(resolve(output, ".nojekyll"), "");
