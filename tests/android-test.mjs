// Android packaging + Android-specific behaviour tests.
//   node tests/android-test.mjs
//
// Covers the things that would break specifically on a phone: the file
// picker, an out-of-date WebView, and whether the APK payload produced by
// android-build/prepare-www.mjs is complete and self-consistent.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const buildDir = path.join(root, "android-build");

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

console.log("=== 1. the file picker is usable on Android ===");
{
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const input = html.match(/<input[^>]*id="weights-file"[^>]*>/)[0];
  // Several Android pickers hide extensions they don't know, and .bin is
  // one of them, so an accept filter makes the model invisible.
  check("the weights input has no accept filter", !/accept=/.test(input), input);
  check("the file input still exists", !!input);
  check("there is guidance for Android users", /Downloads/.test(html));
}

console.log("=== 2. a wrong file is rejected with a readable message ===");
{
  const { parseWeights, NotAWeightsFileError } = await import("../js/weights-format.js");
  const cases = [
    ["an empty file", new ArrayBuffer(0)],
    ["a tiny file", new ArrayBuffer(16)],
    ["a JPEG", (() => { const b = new Uint8Array(4096); b[0] = 0xff; b[1] = 0xd8; return b.buffer; })()],
    ["random noise", (() => { const b = new Uint8Array(200000); for (let i = 0; i < b.length; i++) b[i] = (i * 7919) & 255; return b.buffer; })()],
  ];
  for (const [label, buf] of cases) {
    let err = null;
    try {
      parseWeights(buf);
    } catch (e) {
      err = e;
    }
    check(`${label} is rejected`, !!err, label);
    check(`${label} gives a typed error`, err instanceof NotAWeightsFileError, err && err.constructor.name);
    check(`${label} names the file to pick`, err && /\.bin|Maia3 model/i.test(err.message), err && err.message);
    check(`${label} does not leak a raw parser error`, err && !/JSON|RangeError|undefined/.test(err.message), err && err.message);
  }

  // A real container must still parse.
  const tiny = path.join(here, "tiny-model.bin");
  if (fs.existsSync(tiny)) {
    const b = fs.readFileSync(tiny);
    const parsed = parseWeights(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    check("a genuine container still parses", !!parsed.config && parsed.tensors.size > 0);
  }
}

console.log("=== 3. an out-of-date Android WebView fails clearly ===");
{
  // Simulate a WebView without module-worker support.
  const realWorker = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      throw new TypeError("Failed to construct 'Worker': module workers are not supported");
    }
  };
  const { Maia3Engine } = await import(`../js/engine.js?nocache=${Date.now()}`);
  const engine = new Maia3Engine();
  check("construction does not throw", true);
  check("the failure is recorded", !!engine.workerError, String(engine.workerError));
  check("the message names Android WebView", /WebView/i.test(engine.workerError || ""), engine.workerError);
  check("the message says what to do", /update/i.test(engine.workerError || ""), engine.workerError);
  let rejected = false;
  try {
    await engine._call({ type: "load" });
  } catch {
    rejected = true;
  }
  check("calls reject instead of hanging", rejected);
  globalThis.Worker = realWorker;
}

console.log("=== 4. the build scaffold is valid ===");
{
  check("capacitor.config.json exists", fs.existsSync(path.join(buildDir, "capacitor.config.json")));
  const cfg = JSON.parse(fs.readFileSync(path.join(buildDir, "capacitor.config.json"), "utf8"));
  check("it declares an app id", /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(cfg.appId), cfg.appId);
  check("it declares an app name", !!cfg.appName);
  check("webDir points at www", cfg.webDir === "www");
  // A WebView served over http: would make the app an insecure context,
  // which disables IndexedDB persistence and service workers.
  check("the Android scheme is https", cfg.server && cfg.server.androidScheme === "https", JSON.stringify(cfg.server));

  const pkg = JSON.parse(fs.readFileSync(path.join(buildDir, "package.json"), "utf8"));
  check("capacitor android is a dependency", !!pkg.dependencies["@capacitor/android"]);
  check("a build script exists", !!pkg.scripts.build);

  // GitHub only reads workflows from the repository root, so that is where
  // this one must live -- not inside android-build/.
  const wfPath = path.join(root, ".github/workflows/android.yml");
  check("the workflow is at the repository root", fs.existsSync(wfPath), wfPath);
  check("there is no stray copy inside android-build", !fs.existsSync(path.join(buildDir, ".github")));
  const wf = fs.readFileSync(wfPath, "utf8");
  check("its working directory matches the root layout", /working-directory:\s*android-build\b/.test(wf) && !/maia3-web\/android-build/.test(wf));
  check("the workflow can be run by hand", /workflow_dispatch/.test(wf));
  check("the workflow sets up Java", /setup-java/.test(wf));
  check("the workflow builds a debug APK", /assembleDebug/.test(wf));
  check("the workflow uploads the APK", /upload-artifact/.test(wf) && /\.apk/.test(wf));
  check("the workflow leaves .bin files uncompressed", /noCompress/.test(wf));
}

console.log("=== 5. prepare-www produces a complete, correct payload ===");
{
  execFileSync("node", ["prepare-www.mjs"], { cwd: buildDir, stdio: "pipe" });
  const www = path.join(buildDir, "www");
  check("www was created", fs.existsSync(www));

  // Everything the app needs must be there.
  for (const needed of ["index.html", "selftest.html", "manifest.json", "css/style.css", "js/app.js", "js/worker.js", "js/personality/scoring.js", "js/characters.js", "js/openings.js", "js/analysis.js", "icons/icon-192.png"]) {
    check(`www contains ${needed}`, fs.existsSync(path.join(www, needed)));
  }
  // And nothing that has no business in an APK.
  for (const unwanted of ["tests", "android-build", "node_modules", "convert_weights.py", "Start Maia 3.bat", "sw.js", ".github", "GITHUB_WORKFLOW_LOCATION.txt"]) {
    check(`www excludes ${unwanted}`, !fs.existsSync(path.join(www, unwanted)));
  }

  // Every relative reference in the HTML must resolve inside www.
  const html = fs.readFileSync(path.join(www, "index.html"), "utf8");
  const refs = [...new Set([...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1]))];
  for (const ref of refs) check(`index.html reference ${ref} resolves`, fs.existsSync(path.join(www, ref)));

  // Every ES import must resolve too, or the app is a blank screen.
  const jsFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) jsFiles.push(p);
    }
  })(path.join(www, "js"));
  check("www contains the JS modules", jsFiles.length >= 15, String(jsFiles.length));
  let unresolved = [];
  for (const f of jsFiles) {
    const src = fs.readFileSync(f, "utf8");
    const specs = [
      ...[...src.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/new URL\("(\.[^"]+)"/g)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      const target = path.resolve(path.dirname(f), spec);
      // Stockfish binaries are downloaded by the GitHub Actions APK workflow
      // immediately before prepare-www; they are intentionally not committed
      // to the source repository.
      if (spec.includes("../stockfish/")) continue;
      if (!fs.existsSync(target)) unresolved.push(`${path.relative(www, f)} -> ${spec}`);
    }
  }
  check("every import resolves inside www", unresolved.length === 0, unresolved.join(" | "));

  // No absolute or external URLs anywhere in the payload.
  let external = [];
  for (const f of [...jsFiles, path.join(www, "index.html"), path.join(www, "css/style.css")]) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/https?:\/\/[^\s"')]+/g)) {
      const url = m[0];
      if (url.startsWith("http://www.w3.org/2000/svg")) continue; // XML namespace
      if (/chess\.esm\.js$/.test(f)) continue; // comments in the vendored lib
      external.push(`${path.basename(f)}: ${url}`);
    }
  }
  check("the payload references no external URL", external.length === 0, external.slice(0, 3).join(" | "));

  // The app must survive the service worker being absent from the APK.
  const appJs = fs.readFileSync(path.join(www, "js/app.js"), "utf8");
  check("service worker registration is guarded", /register\("\.\/sw\.js"\)\s*\.catch/.test(appJs.replace(/\s+/g, " ")) || /\.catch\(/.test(appJs.slice(appJs.indexOf("sw.js"))), "no .catch on register()");
}

console.log("=== 6. the Android guide covers every route ===");
{
  const doc = fs.readFileSync(path.join(buildDir, "README-ANDROID.md"), "utf8");
  check("route A (PWA over Wi-Fi) documented", /ipconfig/.test(doc) && /Install app/.test(doc));
  check("route B (server on the phone) documented", /localhost:8000/.test(doc));
  check("route C (APK) documented", /Actions/.test(doc) && /\.apk/i.test(doc));
  check("it warns about bundling large models", /100 MB|Git LFS/.test(doc));
  check("it gives per-model guidance for phones", /Recommended/.test(doc));
}

console.log("");
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILURES`);
  process.exitCode = 1;
}
