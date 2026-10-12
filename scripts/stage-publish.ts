/**
 * Builds `.publish/<package>/` for every published package: its `dist`, the
 * repository's LICENSE and NOTICE, its README, and a package.json fit for the
 * registry. The workspace package.json files point `exports` at `src` for
 * development; Bun's packer does not apply `publishConfig.exports`, so the
 * published manifest is written here instead, with `workspace:*` resolved.
 *
 *   bun scripts/stage-publish.ts      then   npm publish .publish/<package>
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Published {
  readonly dir: string;
  /** The build inlines the workspace packages, so they are not dependencies. */
  readonly bundlesWorkspace?: boolean;
}

const PACKAGES: readonly Published[] = [
  { dir: "packages/domain" },
  { dir: "packages/models" },
  { dir: "packages/eval" },
  { dir: "apps/cli", bundlesWorkspace: true },
];

const KEYWORDS = [
  "claude-code",
  "compaction",
  "context",
  "ai-agents",
  "decision-model",
  "systemone",
];
const COPIED_FIELDS = ["name", "version", "description", "license", "author", "homepage", "bugs"];

type Manifest = Record<string, unknown>;

const root = join(import.meta.dirname, "..");
const read = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Manifest;

const versions = new Map(
  PACKAGES.map((p) => [read(p.dir)["name"] as string, read(p.dir)["version"] as string]),
);

function dependencies(manifest: Manifest, bundled: boolean): Record<string, string> | undefined {
  const entries = Object.entries((manifest["dependencies"] ?? {}) as Record<string, string>)
    .filter(([name]) => !(bundled && versions.has(name)))
    .map(([name, range]) => {
      if (!range.startsWith("workspace:")) return [name, range] as const;
      const version = versions.get(name);
      if (!version) throw new Error(`${name} is a workspace dependency that is not published`);
      return [name, `^${version}`] as const;
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function publishedManifest(pkg: Published): Manifest {
  const manifest = read(pkg.dir);
  const copied = Object.fromEntries(COPIED_FIELDS.map((field) => [field, manifest[field]]));
  const publishConfig = (manifest["publishConfig"] ?? {}) as Manifest;
  return {
    ...copied,
    keywords: KEYWORDS,
    repository: { ...(manifest["repository"] as Manifest), directory: pkg.dir },
    type: "module",
    exports: publishConfig["exports"],
    bin: manifest["bin"],
    files: ["dist", "LICENSE", "NOTICE", "README.md"],
    dependencies: dependencies(manifest, pkg.bundlesWorkspace === true),
    engines: { node: ">=20" },
    publishConfig: { access: "public" },
  };
}

function stage(pkg: Published): string {
  const manifest = publishedManifest(pkg);
  const out = join(root, ".publish", (manifest["name"] as string).split("/")[1]!);
  const dist = join(root, pkg.dir, "dist");
  if (!existsSync(dist)) throw new Error(`${pkg.dir}/dist is missing: run bun run ready first`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(dist, join(out, "dist"), { recursive: true });
  for (const file of ["LICENSE", "NOTICE"]) cpSync(join(root, file), join(out, file));
  cpSync(join(root, pkg.dir, "README.md"), join(out, "README.md"));
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return out;
}

for (const pkg of PACKAGES) process.stdout.write(`staged ${stage(pkg)}\n`);
