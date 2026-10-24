import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const [binary, ...args] = process.argv.slice(2);
const adapter = fileURLToPath(new URL("../dist/main.mjs", import.meta.url));

if (!binary || !isAbsolute(binary) || !existsSync(binary) || !existsSync(adapter)) {
  process.stderr.write("Usage: codex-pruner <absolute-path-to-patched-codex> [Codex arguments]\n");
  process.exitCode = 1;
} else {
  const child = spawn(binary, ["--no-daemon", ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_CONTEXT_PRUNER_COMMAND: JSON.stringify([process.execPath, adapter]),
    },
  });
  // The native CLI receives console interrupts and owns turn cancellation.
  process.on("SIGINT", () => {});
  child.on("error", () => {
    process.stderr.write("codex-pruner: could not launch the supplied executable\n");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
