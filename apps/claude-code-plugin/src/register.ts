import type { On, PluginOptions, Register } from "claude-code";
import { handleCompact, messageOf } from "./compact-hook.ts";
import { resolveHookConfig } from "./config.ts";

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveHookConfig(options);
  let compacting = false;

  on("session.compact", ($, e, next) => handleCompact(config, $, e, next));

  on("turn.complete", async ($, e, next) => {
    if (compacting || config.compactAtPercent <= 0) return next(e);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < config.compactAtPercent) return next(e);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(`auto-compact skipped (${messageOf(error)})`);
    } finally {
      compacting = false;
    }
    return next(e);
  });
};
