import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

const SRC = join(import.meta.dirname, "..", "src");
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

it("keeps the domain free of external dependencies", () => {
  const external = sourceFiles(SRC).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(IMPORT)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => !specifier.startsWith("./") && !specifier.startsWith("../"))
      .map((specifier) => `${file}: ${specifier}`),
  );
  expect(external).toEqual([]);
});
