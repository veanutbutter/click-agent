import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

/**
 * Bundles the extension host and stages the webview assets.
 *
 * The workspace packages publish their TypeScript sources directly
 * (`"main": "./src/index.ts"`), so esbuild pulls the provider layer, the agent
 * loop and the config store straight into one CommonJS file with no separate
 * build step. `vscode` is the only external.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const webDist = path.join(repoRoot, "apps", "web", "dist");
const webviewOut = path.join(here, "dist", "webview");

if (!fs.existsSync(path.join(webDist, "agent.html"))) {
  console.error(
    `Missing ${path.join(webDist, "agent.html")}.\n` +
      "Build the renderer first:  pnpm --filter @click/web build",
  );
  process.exit(1);
}

await esbuild.build({
  entryPoints: [path.join(here, "src", "extension.ts")],
  outfile: path.join(here, "dist", "extension.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  external: ["vscode"],
});

// A second entry for the extension-host tests, which run inside VS Code and
// therefore need the review layer reachable through the built bundle.
await esbuild.build({
  entryPoints: [path.join(here, "src", "testing.ts")],
  outfile: path.join(here, "dist", "testing.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "warning",
  external: ["vscode"],
});

fs.rmSync(webviewOut, { recursive: true, force: true });
fs.mkdirSync(webviewOut, { recursive: true });

// The standalone editor entry (index.html and its own chunk) is not part of the
// extension; only the agent entry and the chunks it shares ship.
const skip = (name) => name === "index.html" || /^index-.*\.(js|css)$/.test(name);
const copyFiltered = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyFiltered(src, dst);
    else fs.copyFileSync(src, dst);
  }
};
copyFiltered(webDist, webviewOut);

console.log(`staged webview assets in ${path.relative(repoRoot, webviewOut)}`);
