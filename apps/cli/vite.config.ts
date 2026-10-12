import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // One runnable file: the workspace packages are bundled in, Node built-ins stay imports.
    entry: { main: "src/main.ts" },
    format: "esm",
    platform: "node",
    dts: false,
    tsconfig: "tsconfig.build.json",
    deps: { alwaysBundle: [/^@9tech\.solutions\//] },
    banner: { js: "#!/usr/bin/env node" },
  },
});
