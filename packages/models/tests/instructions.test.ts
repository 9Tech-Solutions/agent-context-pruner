import { compact, type Message } from "@9tech.solutions/pruner-domain";
import { describe, expect, it } from "vite-plus/test";
import { createHeuristicModel, createSystemOneModel, type HttpRequest } from "../src/index.ts";
import { call, fakeServer, message, result, transcript, unwrap } from "./helpers.ts";

const big = "line\n".repeat(1000);

function rereadSession(): Message[] {
  return [
    message("user", "start"),
    call("a", "Read", { file_path: "C:\\repo\\src\\Auth.ts" }, big),
    result("a", big),
    call("b", "Read", { file_path: "C:\\repo\\src\\Auth.ts" }, big),
    result("b", big),
    call("c", "Grep", { pattern: "x" }, big),
    result("c", big),
    message("user", "next"),
  ];
}

describe("compaction instructions in the models", () => {
  it("sends them to a SystemOne model inside the state", async () => {
    const seen: HttpRequest[] = [];
    const model = unwrap(
      createSystemOneModel(
        { profile: "typesafe", apiKey: "k" },
        fakeServer(() => 1, seen),
      ),
    );
    unwrap(
      await compact(transcript(), model, { preserveRecentMessages: 1, instructions: "keep b.ts" }),
    );
    const body = JSON.parse(seen[0]!.body);
    expect(body.state.instructions).toBe("keep b.ts");
    expect(body.state.context).toContain("`instructions` is what the person asked");
  });

  it("keeps files the person named, even when the rules would drop them", async () => {
    const model = createHeuristicModel();
    const actions = async (instructions?: string) =>
      unwrap(
        await compact(rereadSession(), model, { preserveRecentMessages: 1, instructions }),
      ).decisions.map((d) => d.action);
    expect(await actions()).toEqual(["drop_call", "drop_result", "drop_result"]);
    expect(await actions("focus on src/auth.ts next.")).toEqual(["keep", "keep", "drop_result"]);
    expect(await actions("keep Auth.ts")).toEqual(["keep", "keep", "drop_result"]);
    expect(await actions("keep the login flow")).toEqual([
      "drop_call",
      "drop_result",
      "drop_result",
    ]);
  });
});
