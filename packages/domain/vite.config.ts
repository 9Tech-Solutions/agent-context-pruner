import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Build declarations from src only, so test helpers never leak into the output.
    tsconfig: "tsconfig.build.json",
    dts: {
      generator: "tsgo",
    },
    // `exports` points at src while developing; the dist paths go to publishConfig on build.
    exports: { devExports: true },
  },
});
