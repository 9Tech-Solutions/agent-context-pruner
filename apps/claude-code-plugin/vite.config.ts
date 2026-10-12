import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // One self-contained hooks module: the engine loads files inside the plugin folder only.
    entry: { pruner: "src/register.ts" },
    outDir: "plugin/hooks",
    clean: false,
    format: "esm",
    platform: "neutral",
    dts: false,
    tsconfig: "tsconfig.build.json",
    deps: { alwaysBundle: [/^@9tech\.solutions\//] },
  },
});
