// Copies the web app (the parent folder) into ./www for Capacitor to
// package, skipping everything that has no business inside an APK.
//
// Run automatically by `npm run build`. Safe to re-run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const www = path.join(here, "www");

// Never copied into the APK: build tooling, tests, the Windows launcher,
// the Python converter, and this folder itself.
const SKIP_TOP = new Set([
  "android-build",
  "tests",
  "node_modules",
  "convert_weights.py",
  "Start Maia 3.bat",
  ".git",
  // CI and repository paperwork. `.github` in particular would otherwise be
  // copied into the APK payload, since it lives at the project root.
  ".github",
  ".gitignore",
  ".DS_Store",
]);

// The service worker is pointless inside a WebView that already serves
// everything locally, and an extra cache layer only risks serving stale
// files after an app update. index.html registers it defensively, and the
// registration simply fails harmlessly if the file isn't there.
const SKIP_IN_APK = new Set(["sw.js"]);

function copyDir(src, dest, isTop = false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (isTop && SKIP_TOP.has(entry.name)) continue;
    if (SKIP_IN_APK.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(www, { recursive: true, force: true });
copyDir(appRoot, www, true);

// Model weights: whatever is present in weights/ gets bundled into the
// APK, so the app works the moment it is installed with no file picking.
// Nothing is required -- an APK with no weights is still perfectly usable,
// the user just loads a .bin from device storage once.
const weightsDir = path.join(www, "weights");
const bundled = fs
  .readdirSync(weightsDir)
  .filter((f) => f.endsWith(".bin"))
  .map((f) => {
    const mb = fs.statSync(path.join(weightsDir, f)).size / (1024 * 1024);
    return `${f} (${mb.toFixed(0)} MB)`;
  });

console.log(`www/ prepared from ${appRoot}`);
if (bundled.length) {
  console.log(`Bundling model weights into the APK: ${bundled.join(", ")}`);
  const totalMb = bundled.reduce((a, b) => a + Number(b.match(/\((\d+) MB\)/)[1]), 0);
  if (totalMb > 400) {
    console.log(
      `NOTE: ${totalMb} MB of weights is a very large APK. Consider bundling only maia3-5m.bin ` +
        `and loading the bigger models from device storage inside the app.`
    );
  }
} else {
  console.log("No .bin files in weights/ — the APK will ask you to pick a model file on first run.");
}
