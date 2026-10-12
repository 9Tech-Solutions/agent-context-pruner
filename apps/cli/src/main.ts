import { readFile, writeFile } from "node:fs/promises";
import { fetchTransport } from "@9tech.solutions/pruner-models";
import { parseEvalArgs, USAGE } from "./args.ts";
import { runEval } from "./run-eval.ts";

const [command, ...rest] = process.argv.slice(2);

if (command !== "eval" || rest.includes("--help") || rest.includes("-h")) {
  process.stdout.write(`${USAGE}\n`);
  const asked = command === undefined || command === "--help" || command === "eval";
  process.exitCode = asked ? 0 : 2;
} else {
  const args = parseEvalArgs(rest);
  if (!args.ok) {
    process.stderr.write(`${args.error}\n\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = await runEval(args.value, {
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, text) => writeFile(path, text, "utf8"),
      out: (text) => process.stdout.write(text),
      progress: (text) => process.stderr.write(`${text}\n`),
      env: process.env,
      transport: fetchTransport(),
    });
  }
}
