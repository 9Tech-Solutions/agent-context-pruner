import { parseArgs } from "node:util";
import { err, ok, type Result } from "@9tech.solutions/pruner-domain";
import {
  isProviderId as isProvider,
  type ProviderId as Provider,
  type ProviderSettings,
} from "@9tech.solutions/pruner-models";

export interface EvalArgs extends Omit<ProviderSettings, "apiKey"> {
  readonly files: readonly string[];
  readonly providers: readonly Provider[];
  readonly cuts: number;
  readonly minCalls: number;
  readonly preserve: number;
  readonly head: number;
  readonly maxLoss: number;
  readonly json?: string;
}

export const USAGE = `Usage: agent-context-pruner eval <session.jsonl>... [options]

Replays Claude Code sessions, asks each model what it would prune at a few
compaction points, and measures that against what the session reused later.

  --provider <list>   comma list of typesafe, cloudflare, ollama, custom, heuristic (default heuristic)
  --model <name>      model sent to the provider
  --base-url <url>    ollama or custom server root
  --account-id <id>   cloudflare account (default CLOUDFLARE_ACCOUNT_ID)
  --cuts <n>          compaction points per session segment (default 3)
  --min-calls <n>     unprotected calls a point needs (default 10)
  --preserve <n>      newest messages never pruned (default 6)
  --head <n>          characters a truncated result keeps (default 300)
  --max-loss <ratio>  largest share of reused results a recommendation may remove (default 1, no limit)
  --json <file>       also write the reports as JSON (scores and labels only, no transcript text)

Network providers receive the transcript prefixes. Keys come from TYPESAFE_API_KEY,
CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.`;

function count(value: string | undefined, fallback: number, name: string): Result<number, string> {
  if (value === undefined) return ok(fallback);
  if (value.trim() === "") return err(`--${name} needs a value`);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? ok(parsed)
    : err(`--${name} must be a number, got "${value}"`);
}

function providers(value: string | undefined): Result<Provider[], string> {
  const names = (value ?? "heuristic")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) return err("--provider needs at least one provider");
  const unknown = names.filter((name) => !isProvider(name));
  if (unknown.length > 0) return err(`unknown provider: ${unknown.join(", ")}`);
  return ok(names.filter(isProvider));
}

/** `--model` and `--base-url` name one server: with two network providers, one would get the other's settings. */
function oneServer(chosen: readonly Provider[], values: { model?: string; "base-url"?: string }) {
  const network = chosen.filter((provider) => provider !== "heuristic");
  const pointed = values.model !== undefined || values["base-url"] !== undefined;
  return pointed && network.length > 1
    ? err("--model and --base-url apply to one provider: run each network provider separately")
    : ok(chosen);
}

const OPTIONS = {
  provider: { type: "string" },
  model: { type: "string" },
  "base-url": { type: "string" },
  "account-id": { type: "string" },
  cuts: { type: "string" },
  "min-calls": { type: "string" },
  preserve: { type: "string" },
  head: { type: "string" },
  "max-loss": { type: "string" },
  json: { type: "string" },
} as const;

/** Parses `eval`'s arguments; every problem comes back as a message, never a throw. */
export function parseEvalArgs(argv: readonly string[]): Result<EvalArgs, string> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (positionals.length === 0) return err("give at least one session .jsonl file");
  const numbers = [
    count(values.cuts, 3, "cuts"),
    count(values["min-calls"], 10, "min-calls"),
    count(values.preserve, 6, "preserve"),
    count(values.head, 300, "head"),
    count(values["max-loss"], 1, "max-loss"),
  ];
  const bad = numbers.find((n) => !n.ok);
  if (bad && !bad.ok) return bad;
  const [cuts, minCalls, preserve, head, maxLoss] = numbers.map((n) => (n.ok ? n.value : 0));
  const chosen = providers(values.provider);
  if (!chosen.ok) return chosen;
  const single = oneServer(chosen.value, values);
  if (!single.ok) return single;
  return ok({
    files: positionals,
    providers: chosen.value,
    model: values.model,
    baseUrl: values["base-url"],
    accountId: values["account-id"],
    cuts: cuts!,
    minCalls: minCalls!,
    preserve: preserve!,
    head: head!,
    maxLoss: maxLoss!,
    json: values.json,
  });
}
