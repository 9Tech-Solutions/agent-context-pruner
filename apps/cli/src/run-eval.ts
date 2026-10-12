import {
  err,
  ok,
  type CompactError,
  type DecisionModel,
  type Message,
  type Result,
} from "@9tech.solutions/pruner-domain";
import {
  buildReport,
  chooseCuts,
  evaluateCut,
  formatReport,
  type CutEvaluation,
  type ModelReport,
} from "@9tech.solutions/pruner-eval";
import type { HttpTransport } from "@9tech.solutions/pruner-models";
import type { EvalArgs } from "./args.ts";
import { createModel, type Env, type Provider } from "./models.ts";
import { parseClaudeTranscript } from "./transcript.ts";

/** Everything outside the process the eval touches, injected so tests run without files or network. */
export interface Io {
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  /** The report itself. */
  readonly out: (text: string) => void;
  /** Progress and notices, kept apart from the report. */
  readonly progress: (text: string) => void;
  readonly env: Env;
  readonly transport: HttpTransport;
}

interface Segment {
  readonly label: string;
  readonly messages: readonly Message[];
  readonly cuts: readonly number[];
}

interface Prepared {
  readonly provider: Provider;
  readonly model: DecisionModel;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

function segmentsOf(file: string, jsonl: string, args: EvalArgs, io: Io): Segment[] {
  const parsed = parseClaudeTranscript(jsonl);
  if (parsed.badLines > 0)
    io.progress(`${file}: skipped ${parsed.badLines} lines that are not JSON`);
  if (parsed.segments.length === 0) io.progress(`${file}: no conversation rows found`);
  const options = {
    cuts: args.cuts,
    minCalls: args.minCalls,
    preserveRecentMessages: args.preserve,
  };
  return parsed.segments.flatMap((messages, index) => {
    const cuts = chooseCuts(messages, options);
    return cuts.length > 0 ? [{ label: `${file}#${index + 1}`, messages, cuts }] : [];
  });
}

async function loadSegments(args: EvalArgs, io: Io): Promise<Result<Segment[], string>> {
  const segments: Segment[] = [];
  for (const file of args.files) {
    try {
      segments.push(...segmentsOf(file, await io.readFile(file), args, io));
    } catch (error) {
      return err(`cannot read ${file}: ${reason(error)}`);
    }
  }
  return ok(segments);
}

/** Builds every model before any is asked, so a bad configuration fails before anything is sent. */
function prepareModels(args: EvalArgs, io: Io): Result<Prepared[], string> {
  const prepared: Prepared[] = [];
  for (const provider of args.providers) {
    const model = createModel(provider, args, io.env, io.transport);
    if (!model.ok) return err(`${provider}: ${model.error}`);
    prepared.push({ provider, model: model.value });
  }
  return ok(prepared);
}

/** The error's kinds only: a provider's message can echo the request, which is transcript text. */
function errorKind(error: CompactError): string {
  return "cause" in error ? `${error.kind} (${error.cause.kind})` : error.kind;
}

async function evaluateAll(
  model: DecisionModel,
  segments: readonly Segment[],
  args: EvalArgs,
  io: Io,
): Promise<{ evaluations: CutEvaluation[]; errors: string[] }> {
  const evaluations: CutEvaluation[] = [];
  const errors: string[] = [];
  for (const segment of segments) {
    for (const cut of segment.cuts) {
      const outcome = await evaluateCut(segment.messages, cut, model, args.preserve);
      const where = `${segment.label} at message ${cut}`;
      if (outcome.ok) {
        evaluations.push(outcome.value);
        io.progress(`${model.id}: ${where}, ${outcome.value.scored.length} calls scored`);
      } else {
        errors.push(`${where}: ${errorKind(outcome.error)}`);
        io.progress(`${model.id}: ${where} failed: ${outcome.error.message}`);
      }
    }
  }
  return { evaluations, errors };
}

async function reportFor(
  { provider, model }: Prepared,
  segments: readonly Segment[],
  args: EvalArgs,
  io: Io,
): Promise<ModelReport> {
  if (provider !== "heuristic") {
    const points = segments.reduce((sum, segment) => sum + segment.cuts.length, 0);
    io.progress(`${model.id}: sending ${points} transcript prefixes to the provider`);
  }
  const { evaluations, errors } = await evaluateAll(model, segments, args, io);
  const options = { headChars: args.head, maxLossRate: args.maxLoss };
  return buildReport(model.id, evaluations, errors, options);
}

async function writeJson(path: string, reports: readonly ModelReport[], io: Io): Promise<boolean> {
  try {
    await io.writeFile(path, `${JSON.stringify(reports, null, 2)}\n`);
    return true;
  } catch (error) {
    io.progress(`cannot write ${path}: ${reason(error)}`);
    return false;
  }
}

function fail(io: Io, message: string): number {
  io.progress(message);
  return 1;
}

/** Runs `eval`: returns the process exit code, 1 when any model scored no compaction point. */
export async function runEval(args: EvalArgs, io: Io): Promise<number> {
  const segments = await loadSegments(args, io);
  if (!segments.ok) return fail(io, segments.error);
  const models = prepareModels(args, io);
  if (!models.ok) return fail(io, models.error);
  if (segments.value.length === 0) {
    const need = `${args.minCalls} unprotected calls before a prompt`;
    return fail(io, `no compaction points: no session segment has ${need}`);
  }
  const reports: ModelReport[] = [];
  for (const prepared of models.value) {
    const report = await reportFor(prepared, segments.value, args, io);
    reports.push(report);
    io.out(`${formatReport(report)}\n`);
  }
  const written = args.json ? await writeJson(args.json, reports, io) : true;
  return written && reports.every((report) => report.points > 0) ? 0 : 1;
}
