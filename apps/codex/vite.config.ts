import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Bundle the workspace core into one Node entrypoint.
    entry: {
      main: "src/main.ts",
      launch: "src/launch.ts",
      prepare: "src/prepare.ts",
      smoke: "src/smoke.ts",
    },
    format: "esm",
    platform: "node",
    dts: false,
    tsconfig: "tsconfig.build.json",
    deps: { alwaysBundle: [/^@9tech\.solutions\//] },
    banner: { js: "#!/usr/bin/env node" },
  },
});
