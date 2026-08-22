
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync("index.html", "utf8");
const app = fs.readFileSync("js/app.js", "utf8");
const androidHtml = fs.readFileSync("android-build/www/index.html", "utf8");
const androidApp = fs.readFileSync("android-build/www/js/app.js", "utf8");

assert.match(html, /id="temperature"[^>]*min="0"[^>]*max="1"[^>]*step="0\.1"/);
assert.match(html, /id="temperature-val">1\.0</);
assert.match(app, /temperature:\s*1\.0/);
assert.match(app, /temperature:\s*state\.temperature/);
assert.match(app, /\["temperature"\]|temperature:\s*state\.temperature/);
assert.match(app, /\$\("temperature"\)\.addEventListener\("input"/);
assert.match(app, /Math\.max\(0, Math\.min\(1, Number\(\$\("temperature"\)\.value\)\)\)/);
assert.match(app, /state\.temperature\s*=\s*Math\.max\(0, Math\.min\(1, Number\(p\.temperature\)\)\)/);
assert.match(androidHtml, /id="temperature"[^>]*min="0"[^>]*max="1"[^>]*step="0\.1"/);
assert.match(androidApp, /temperature:\s*state\.temperature/);

console.log("temperature-settings-test: 9/9 passed");
