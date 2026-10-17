import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTests } from "@vscode/test-electron";

/**
 * Launches a real VS Code with the extension loaded and runs the extension-host
 * tests inside it.
 *
 * It uses the VS Code already installed on this machine rather than downloading
 * another copy, so the tests run against the same editor the user runs.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(here, "..", "..");
const extensionTestsPath = path.join(here, "run.js");

const candidates = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
  process.env["ProgramFiles(x86)"] &&
    path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe"),
].filter((candidate) => typeof candidate === "string");

const installed = candidates.find((candidate) => fs.existsSync(candidate));
console.log(installed ? `using installed VS Code: ${installed}` : "using a downloaded VS Code");

await runTests({
  ...(installed ? { vscodeExecutablePath: installed } : {}),
  extensionDevelopmentPath,
  extensionTestsPath,
  launchArgs: ["--disable-extensions", "--disable-gpu", "--no-sandbox"],
});
