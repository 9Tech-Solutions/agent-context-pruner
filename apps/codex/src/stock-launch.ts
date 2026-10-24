import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "./proxy.ts";
import { hasShellPolicy, proxySettings } from "./stock-config.ts";

const BYPASS_ARGUMENTS = new Set([
  "--version",
  "-V",
  "--help",
  "-h",
  "--remote",
  "--oss",
  "--local-provider",
  "--profile",
  "-p",
  "--worktree",
  "-c",
  "--config",
  "login",
  "logout",
  "update",
  "doctor",
  "mcp",
  "plugin",
  "completion",
  "features",
  "debug",
  "sandbox",
  "apply",
  "agents",
  "queue",
  "archive",
  "unarchive",
  "delete",
  "cloud",
  "app",
  "remote-control",
  "migrate-rollouts",
  "migrate-nfs-db",
  "generate-json-schema",
  "generate-ts",
]);

/** Maintenance, remote clients, and explicit alternate providers retain their normal behavior. */
export function needsProxy(args: readonly string[]): boolean {
  return !args.some(
    (arg) =>
      BYPASS_ARGUMENTS.has(arg) ||
      arg.startsWith("--remote=") ||
      arg.startsWith("--profile=") ||
      /^-p.+/.test(arg) ||
      arg.startsWith("--cd=") ||
      arg.startsWith("--config=") ||
      /^-c.+/.test(arg) ||
      /^-C.+/.test(arg) ||
      /^(?:-c)?(?:model_provider|openai_base_url|chatgpt_base_url|model_providers\.|shell_environment_policy\.)/.test(
        arg,
      ),
  );
}

export function stockArguments(
  url: string,
  args: readonly string[],
  excludes: readonly string[] = [],
): string[] {
  const config = [
    'model_provider="context_pruner"',
    'model_providers.context_pruner.name="Local context pruner"',
    "model_providers.context_pruner.base_url=" + JSON.stringify(url),
    "model_providers.context_pruner.requires_openai_auth=true",
    'model_providers.context_pruner.wire_api="responses"',
    "model_providers.context_pruner.supports_websockets=false",
    "features.enable_request_compression=false",
    "shell_environment_policy.exclude=" +
      JSON.stringify([...new Set([...excludes, "CODEX_PRUNER_PROXY_TOKEN"])]),
    'model_providers.context_pruner.capabilities.remote_compaction="v2"',
    'model_providers.context_pruner.env_http_headers={"X-Codex-Pruner-Token"="CODEX_PRUNER_PROXY_TOKEN"}',
  ];
  return ["--no-daemon", ...config.flatMap((value) => ["-c", value]), ...args];
}

function readOptional(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").replace(/^\uFEFF/, "") : "";
}

export function projectPolicyPaths(cwd: string): string[] {
  let directory = resolve(cwd);
  const paths: string[] = [join(directory, "config.toml")];
  for (;;) {
    paths.push(join(directory, ".codex", "config.toml"));
    if (existsSync(join(directory, ".git"))) return paths;
    const parent = dirname(directory);
    if (parent === directory) return paths.slice(0, 2);
    directory = parent;
  }
}

function configuration(args: readonly string[]): ReturnType<typeof proxySettings> {
  const home = process.env["CODEX_HOME"] || join(homedir(), ".codex");
  const system =
    process.platform === "win32"
      ? join(process.env["ProgramData"] || "C:/ProgramData", "OpenAI", "Codex")
      : "/etc/codex";
  const managed = [
    join(system, "config.toml"),
    join(system, "requirements.toml"),
    join(system, "managed_config.toml"),
    join(home, "managed_config.toml"),
    join(home, "requirements.toml"),
  ];
  if (managed.some((path) => existsSync(path))) return undefined;
  const globalConfig = resolve(home, "config.toml");
  const cwdFlag = args.findIndex((arg) => arg === "-C" || arg === "--cd");
  const cwd = cwdFlag >= 0 ? (args[cwdFlag + 1] ?? process.cwd()) : process.cwd();
  for (const local of projectPolicyPaths(cwd)) {
    if (resolve(local) !== globalConfig && hasShellPolicy(readOptional(local))) return undefined;
  }
  return proxySettings(
    readOptional(globalConfig),
    readOptional(join(home, "auth.json")) || undefined,
    process.env,
  );
}

async function runChild(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const script = binary.endsWith(".js") || binary.endsWith(".mjs");
  const child = spawn(script ? process.execPath : binary, script ? [binary, ...args] : [...args], {
    stdio: "inherit",
    env,
  });
  const interrupt = () => {};
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const exitCode = await new Promise<number>((done) => {
    child.once("error", () => {
      done(1);
    });
    child.once("exit", (code) => {
      done(code ?? 1);
    });
  });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  return exitCode;
}

async function launch(binary: string, args: readonly string[]): Promise<void> {
  if (!isAbsolute(binary) || !existsSync(binary))
    throw new Error("Expected an absolute stock Codex executable path");
  const token = randomBytes(32).toString("hex");
  const settings =
    needsProxy(args) && process.env["CODEX_PRUNER_BYPASS"] !== "1"
      ? configuration(args)
      : undefined;
  if (needsProxy(args) && process.env["CODEX_PRUNER_UPSTREAM"] && !settings) {
    throw new Error("The explicitly selected proxy cannot be enabled for this configuration");
  }
  const proxy = settings
    ? await startProxy({
        upstream: settings.upstream,
        token,
        onPruned: (characters, results) => {
          process.stderr.write(
            "[context-pruner] removed " +
              characters +
              " characters from " +
              results +
              " old tool results\n",
          );
        },
      })
    : undefined;
  const forwarded = proxy ? stockArguments(proxy.url, args, settings!.excludes) : [...args];
  try {
    process.exitCode = await runChild(
      binary,
      forwarded,
      proxy ? { ...process.env, CODEX_PRUNER_PROXY_TOKEN: token } : process.env,
    );
  } finally {
    await proxy?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [binary, ...args] = process.argv.slice(2);
  void (binary ? launch(binary, args) : Promise.reject()).catch(() => {
    process.stderr.write(
      "codex-pruner: stock launcher failed; use the official Codex command directly\n",
    );
    process.exitCode = 1;
  });
}
