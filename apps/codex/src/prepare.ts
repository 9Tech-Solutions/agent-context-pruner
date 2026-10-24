import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = "83086188ae0614bd882818ff1aa23f3194962012";
const runtime = fileURLToPath(new URL("../runtime/", import.meta.url));
const patch = fileURLToPath(new URL("../patches/codex-0.163.0.patch", import.meta.url));
const files = [
  [join(runtime, "context_pruner.rs"), "context_pruner.rs"],
  [join(runtime, "context_pruner_protocol.rs"), "context_pruner_protocol.rs"],
  [join(runtime, "context_pruner_process.rs"), "context_pruner_process.rs"],
  [join(runtime, "protocol_tests.rs"), "protocol_tests.rs"],
  [fileURLToPath(new URL("../../../LICENSE", import.meta.url)), "context_pruner.LICENSE"],
  [fileURLToPath(new URL("../../../NOTICE", import.meta.url)), "context_pruner.NOTICE"],
] as const;

function git(checkout: string, args: readonly string[]) {
  const result = spawnSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw new Error("Git is required to prepare the runtime checkout.");
  return result;
}

function prepare(checkout: string): void {
  if (!isAbsolute(checkout) || git(checkout, ["rev-parse", "HEAD"]).stdout.trim() !== COMMIT) {
    throw new Error("Use an absolute path to a Codex rust-v0.163.0 checkout at the pinned commit.");
  }
  const target = join(checkout, "codex-rs", "core", "src");
  for (const [source, file] of files) {
    const destination = join(target, file);
    if (existsSync(destination) && !readFileSync(destination).equals(readFileSync(source))) {
      throw new Error(`Existing ${file} differs; review it before preparing this checkout.`);
    }
  }
  if (git(checkout, ["apply", "--reverse", "--check", patch]).status !== 0) {
    if (git(checkout, ["apply", "--check", patch]).status !== 0) {
      throw new Error("The runtime patch conflicts with this checkout; no files were overwritten.");
    }
    if (git(checkout, ["apply", patch]).status !== 0)
      throw new Error("Could not apply runtime patch.");
  }
  for (const [source, file] of files) copyFileSync(source, join(target, file));
  process.stdout.write("Prepared Codex 0.163.0 with the opt-in context-pruner bridge.\n");
}

try {
  prepare(process.argv[2] ?? "");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Could not prepare Codex."}\n`);
  process.exitCode = 1;
}
