import {
  createHeuristicModel,
  createProviderModel,
  fetchTransport,
  isProviderId,
  keysFromEnv,
} from "@9tech.solutions/pruner-models";
import type { DecisionModel } from "@9tech.solutions/pruner-domain";
import { readBoundedInput } from "./input.ts";
import { parseRequest } from "./protocol.ts";
import { planPruning } from "./plan.ts";

type Environment = Readonly<Record<string, string | undefined>>;

function envValue(env: Environment, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function configuredModel(env: Environment): DecisionModel {
  const provider = envValue(env, "PRUNER_PROVIDER") ?? "heuristic";
  if (!isProviderId(provider) || provider === "heuristic") return createHeuristicModel();
  const result = createProviderModel(
    provider,
    { model: envValue(env, "PRUNER_MODEL"), baseUrl: envValue(env, "PRUNER_BASE_URL") },
    keysFromEnv(env),
    fetchTransport(),
  );
  return result.ok ? result.value : createHeuristicModel();
}

function fail(): void {
  process.stderr.write("agent-context-pruner-codex: request failed\n");
  process.exitCode = 1;
}

async function run(): Promise<void> {
  const input = await readBoundedInput(process.stdin);
  if (!input.ok) return fail();
  const request = parseRequest(input.value);
  if (!request.ok) return fail();
  const model = configuredModel(process.env);
  let plan = await planPruning(request.value.messages, model, request.value.instructions);
  if (!plan.ok && model.id !== "heuristic:v2") {
    plan = await planPruning(
      request.value.messages,
      createHeuristicModel(),
      request.value.instructions,
    );
  }
  if (!plan.ok) return fail();
  process.stdout.write(`${JSON.stringify(plan.value)}\n`);
}

void run().catch(fail);
