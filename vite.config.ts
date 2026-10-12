import { defineConfig } from "vite-plus";

/** Build output committed on purpose: the Claude Code plugin ships its bundled hooks module. */
const GENERATED = ["apps/claude-code-plugin/plugin/hooks/pruner.js"];

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: GENERATED,
  },
  lint: {
    ignorePatterns: GENERATED,
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
