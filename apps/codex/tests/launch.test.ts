import { expect, it, vi } from "vite-plus/test";

const recorded = vi.hoisted(() => ({
  calls: [] as {
    binary: string;
    args: readonly string[];
    stdio: unknown;
    command: string | undefined;
    shell: boolean | undefined;
  }[],
}));

vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("node:child_process", () => ({
  spawn: (
    binary: string,
    args: readonly string[],
    options: {
      stdio: unknown;
      env: NodeJS.ProcessEnv;
      shell?: boolean;
    },
  ) => {
    recorded.calls.push({
      binary,
      args,
      stdio: options.stdio,
      command: options.env["CODEX_CONTEXT_PRUNER_COMMAND"],
      shell: options.shell,
    });
    return { on: () => {} };
  },
}));

it("isolates the custom runtime from a stock daemon and scopes its helper to the child", async () => {
  const originalArgs = process.argv;
  const originalSignals = new Set(process.listeners("SIGINT"));
  vi.stubEnv("CODEX_CONTEXT_PRUNER_COMMAND", "parent-setting");
  process.argv = [process.execPath, "launch.mjs", process.execPath, "resume", "synthetic-session"];
  try {
    await import("../src/launch.ts");
    expect(recorded.calls).toHaveLength(1);
    const call = recorded.calls[0]!;
    expect(call.binary).toBe(process.execPath);
    expect(call.args).toEqual(["--no-daemon", "resume", "synthetic-session"]);
    expect(call.stdio).toBe("inherit");
    expect(call.shell).toBeUndefined();
    const command = JSON.parse(call.command!) as string[];
    expect(command[0]).toBe(process.execPath);
    expect(command[1]?.replaceAll("\\", "/")).toMatch(/\/apps\/codex\/dist\/main\.mjs$/);
    expect(process.env["CODEX_CONTEXT_PRUNER_COMMAND"]).toBe("parent-setting");
  } finally {
    process.argv = originalArgs;
    vi.unstubAllEnvs();
    for (const listener of process.listeners("SIGINT")) {
      if (!originalSignals.has(listener)) process.removeListener("SIGINT", listener);
    }
  }
});
