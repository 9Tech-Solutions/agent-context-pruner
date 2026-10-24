import { expect, it } from "vite-plus/test";
import { needsProxy, projectPolicyPaths, stockArguments } from "../src/stock-launch.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { toolCall } from "../src/stock-smoke.ts";

it("bypasses attached short profile selectors", () => {
  expect(needsProxy(["-p=custom"])).toBe(false);
  expect(needsProxy(["-pcustom"])).toBe(false);
});

it("emits valid JavaScript for the native shell-token and file-read probes", () => {
  const script = toolCall()["input"] as string;
  expect(() => new Script("(async () => {" + script + "})")).not.toThrow();
  expect(script).toContain("CODEX_PRUNER_PROXY_TOKEN");
  expect(script).toContain("Proxy token reached a tool child");
});

it("does not load unrelated ancestor project policies outside a Git repository", () => {
  const root = mkdtempSync(join(tmpdir(), "pruner-policy-paths-"));
  const child = join(root, "child");
  mkdirSync(child);
  expect(projectPolicyPaths(child)).toEqual([
    join(child, "config.toml"),
    join(child, ".codex", "config.toml"),
  ]);
  mkdirSync(join(root, ".git"));
  expect(projectPolicyPaths(child)).toEqual([
    join(child, "config.toml"),
    join(child, ".codex", "config.toml"),
    join(root, ".codex", "config.toml"),
  ]);
});

it("bypasses every explicit config spelling so callers cannot undo token isolation", () => {
  for (const args of [
    ["--profile", "custom"],
    ["--profile=custom"],
    ["--config=model_provider=custom"],
    ["--config=shell_environment_policy.exclude=[]"],
    ["-cmodel_provider=custom"],
    ["--config", "shell_environment_policy.exclude=[]"],
    ["-c", "model_context_window=100000"],
  ]) {
    expect(needsProxy(args), JSON.stringify(args)).toBe(false);
  }
});

it("isolates stock inference from the daemon and uses HTTP with native remote compaction", () => {
  const args = stockArguments("http://127.0.0.1:12345", ["resume", "example-session"]);
  expect(args).toContain("--no-daemon");
  expect(args).toContain('model_provider="context_pruner"');
  expect(args).toContain('model_providers.context_pruner.base_url="http://127.0.0.1:12345"');
  expect(args).toContain("model_providers.context_pruner.requires_openai_auth=true");
  expect(args).toContain("model_providers.context_pruner.supports_websockets=false");
  expect(args).toContain("features.enable_request_compression=false");
  expect(args).toContain('shell_environment_policy.exclude=["CODEX_PRUNER_PROXY_TOKEN"]');
  expect(args).toContain('model_providers.context_pruner.capabilities.remote_compaction="v2"');
  expect(args).toContain(
    'model_providers.context_pruner.env_http_headers={"X-Codex-Pruner-Token"="CODEX_PRUNER_PROXY_TOKEN"}',
  );
  expect(args.slice(-2)).toEqual(["resume", "example-session"]);
});

it("preserves existing environment exclusions while adding the local token exclusion", () => {
  const args = stockArguments("http://127.0.0.1:12345", [], ["PRIVATE_*", "TOKEN_TO_HIDE"]);
  expect(args).toContain(
    'shell_environment_policy.exclude=["PRIVATE_*","TOKEN_TO_HIDE","CODEX_PRUNER_PROXY_TOKEN"]',
  );
});

it("keeps maintenance commands, alternate providers, and remote sessions on the ordinary launcher", () => {
  for (const args of [
    ["--version"],
    ["--help"],
    ["update"],
    ["login"],
    ["mcp", "list"],
    ["app-server", "generate-json-schema"],
    ["--remote", "ws://localhost:4321"],
    ["--oss"],
    ["-c", 'model_provider="another"'],
  ]) {
    expect(needsProxy(args), JSON.stringify(args)).toBe(false);
  }
  for (const args of [
    [],
    ["exec", "help me update the app"],
    ["resume", "--last"],
    ["review", "--uncommitted"],
    ["app-server"],
  ]) {
    expect(needsProxy(args), JSON.stringify(args)).toBe(true);
  }
});
