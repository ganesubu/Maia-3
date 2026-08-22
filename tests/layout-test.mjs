// Layout invariant tests.
//   node tests/layout-test.mjs
//
// jsdom has no CSS layout engine and the sandbox has no browser, so the
// board's rendered pixel width cannot be measured here (see the note in
// README §Testing). What CAN be checked — and is what actually caused the
// original bug — is the STRUCTURE of the stylesheet and the markup:
//
//   the old bug was `grid-template-columns: minmax(0, 640px) 1fr`, where
//   `1fr` = `minmax(auto, 1fr)` and `auto` as a track minimum means "at
//   least this track's min-content width". The move list grew that
//   minimum, and grid paid for it out of the board's track.
//
// So these tests assert the three structural rules that make that class of
// bug impossible, and that the board's size expression never mentions
// anything content-derived.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const css = fs.readFileSync(path.join(root, "css/style.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

// Strip comments so prose about the old bug isn't mistaken for live rules.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

// Minimal CSS rule parser: enough to look up a selector's declarations
// without pulling in a dependency.
function parseRules(source) {
  const out = [];
  // Drop @media wrappers' braces by parsing their bodies too.
  const flat = source.replace(/@media[^{]*\{/g, "").replace(/@keyframes[^{]*\{[\s\S]*?\}\s*\}/g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(flat))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}
const PARSED = parseRules(rules);

function declarationsFor(selector) {
  return PARSED.filter((r) =>
    r.selector
      .split(",")
      .map((s) => s.trim())
      .some((s) => s === selector || s.startsWith(selector + " ") || s.startsWith(selector + ":") || s.endsWith(" " + selector))
  );
}

function bodyOf(selector) {
  return declarationsFor(selector)
    .map((r) => r.body)
    .join("\n");
}

// A track list is "content-immune" if, after removing minmax() pairs whose
// MINIMUM is a fixed length (or 0) and the repeat() auto-fill/auto-fit
// keywords, nothing content-derived remains. `auto`, `min-content`,
// `max-content`, `fit-content` and a bare `fr` (which is minmax(auto, fr))
// are all content-derived track minimums — exactly what caused the bug.
function contentImmune(trackList) {
  const cleaned = trackList
    .replace(/minmax\(\s*(0|[\d.]+(px|rem|em|svh|vh|vw|%))\s*,[^)]*\)/g, "T")
    .replace(/\bauto-fill\b|\bauto-fit\b/g, "R");
  return !/\bauto\b|\bmin-content\b|\bmax-content\b|\bfit-content\b|\bfr\b/.test(cleaned);
}

console.log("=== 1. no grid track can be sized by its content ===");
{
  const tracks = [...rules.matchAll(/grid-template-columns\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  check("the stylesheet defines grid columns", tracks.length > 0);
  for (const t of tracks) {
    check(`track list is content-immune: "${t}"`, contentImmune(t), t);
  }
}

console.log("=== 2. the board's size comes only from the viewport ===");
{
  const frame = bodyOf(".board-frame");
  check(".board-frame is styled", frame.length > 0);
  const widthDecl = [...frame.matchAll(/(?:^|\s)width\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  check(".board-frame declares a width", widthDecl.length > 0, widthDecl.join(" | "));
  for (const w of widthDecl) {
    const usesOnlyViewportOrPercent = /^min\(\s*100%\s*,\s*var\(--board-max\)\s*\)$|^min\(\s*[\d.]+svh\s*,\s*100%\s*\)$|^100%$/.test(w);
    check(`board width "${w}" is viewport/percentage only`, usesOnlyViewportOrPercent, w);
  }
  // --board-max must never be defined in terms of content.
  const boardMaxDefs = [...rules.matchAll(/--board-max\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  check("--board-max is defined", boardMaxDefs.length > 0);
  for (const def of boardMaxDefs) {
    const contentish = /(auto|min-content|max-content|fit-content)/.test(def);
    check(`--board-max "${def}" is not content-derived`, !contentish, def);
    const viewporty = /(vh|svh|vw|dvh|%|px)/.test(def);
    check(`--board-max "${def}" is expressed in viewport/absolute units`, viewporty, def);
  }
  check("the board keeps a 1:1 aspect ratio", /#board[^{}]*\{[^{}]*aspect-ratio\s*:\s*1\s*\/\s*1/.test(rules) || /#board,\s*#analysis-board\s*\{[^{}]*aspect-ratio\s*:\s*1\s*\/\s*1/.test(rules));
}

console.log("=== 3. the move list is bounded in both axes ===");
{
  const ml = bodyOf(".move-list");
  check(".move-list is styled", ml.length > 0);
  check("it has a max-height", /max-height\s*:/.test(ml));
  check("it scrolls vertically instead of growing", /overflow-y\s*:\s*auto/.test(ml));
  check("it never scrolls horizontally", /overflow-x\s*:\s*hidden/.test(ml));
  check("it has min-width: 0", /min-width\s*:\s*0/.test(ml));
  check("long tokens wrap instead of widening it", /overflow-wrap\s*:\s*anywhere/.test(ml));
  check("its columns are fixed, not content-sized", /grid-template-columns\s*:[^;]*minmax\(\s*0\s*,\s*1fr\s*\)/.test(ml));
}

console.log("=== 4. flex/grid children carry min-width: 0 ===");
{
  // The `auto` minimum on a flex item is the other half of the same trap.
  for (const sel of [".square", ".board-row", ".detail-value", ".context-label", ".strip-meta"]) {
    const body = bodyOf(sel);
    const ok = /min-width\s*:\s*0/.test(body) || /min-height\s*:\s*0/.test(body);
    check(`${sel} defends against the auto minimum`, ok, body.slice(0, 80));
  }
}

console.log("=== 5. the page can never scroll horizontally ===");
{
  check("html/body clip horizontal overflow", /overflow-x\s*:\s*hidden/.test(rules));
}

console.log("=== 6. markup: the board is not a sizing sibling of the move list ===");
{
  // The board must not live inside the same panel as any growing list.
  const boardIdx = html.indexOf('<div id="board">');
  const analysisBoardIdx = html.indexOf('<div id="analysis-board">');
  check("the board exists", boardIdx > 0);
  check("the analysis board exists", analysisBoardIdx > 0);

  // Extract the section of markup between the board and the move list to
  // confirm the move list is a later, separate panel.
  const moveListIdx = html.indexOf('id="move-list"');
  check("the move list exists", moveListIdx > 0);
  check("the move list comes after the board", moveListIdx > boardIdx);
  const between = html.slice(boardIdx, moveListIdx);
  check("the board's own container is closed before the move list", between.includes("</div>"));
  check("the move list sits in its own panel", /<div class="panel">\s*<h2>Moves/.test(html));
  check("the board sits in a plain board-wrap, not a flex row with the list", /<div class="board-wrap">\s*<div class="board-frame">/.test(html));
}

console.log("=== 7. touch targets are large enough ===");
{
  const tap = [...rules.matchAll(/--tap\s*:\s*(\d+)px/g)].map((m) => Number(m[1]));
  check("a tap-target size is defined", tap.length > 0);
  check("tap targets are at least 44px", tap.every((t) => t >= 44), tap.join(","));
  const btn = bodyOf(".btn");
  check("buttons use it", /min-height\s*:\s*var\(--tap\)/.test(btn));
  const sel = bodyOf(".select");
  check("selects use it", /min-height\s*:\s*var\(--tap\)/.test(sel));
}

console.log("=== 8. the arrow overlay cannot intercept taps ===");
{
  const layer = bodyOf(".arrow-layer");
  check(".arrow-layer is styled", layer.length > 0);
  check("it is pointer-events: none", /pointer-events\s*:\s*none/.test(layer));
  check("it is absolutely positioned over the board", /position\s*:\s*absolute/.test(layer));
}

console.log("=== 9. landscape and small screens only change viewport caps ===");
{
  const mediaBlocks = [...css.matchAll(/@media[^{]+\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  check("there are responsive blocks", mediaBlocks.length >= 2, String(mediaBlocks.length));
  for (const block of mediaBlocks) {
    const stripped = block.replace(/\/\*[\s\S]*?\*\//g, "");
    const tracks = [...stripped.matchAll(/grid-template-columns\s*:\s*([^;]+);/g)].map((m) => m[1]);
    for (const t of tracks) {
      check(`responsive track "${t.trim()}" is still content-immune`, contentImmune(t), t);
    }
  }
}

console.log("=== 10. the self-test page is self-contained ===");
{
  const st = fs.readFileSync(path.join(root, "selftest.html"), "utf8");
  check("selftest.html exists and is a page", /<!doctype html>/i.test(st));
  check("it uses the app's own stylesheet", st.includes('href="./css/style.css"'));
  // Only real resource loads count. Advice text mentioning http://localhost
  // and the https:// scheme is not a network dependency.
  const loads = [
    ...[...st.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]),
    ...[...st.matchAll(/(?:import|fetch)\s*\(?\s*["'](https?:[^"']+)["']/g)].map((m) => m[1]),
  ];
  check("it loads nothing from the network", loads.length === 0, loads.join(" | "));
  for (const mod of ["./js/chess.esm.js", "./js/board.js", "./js/analysis.js", "./js/openings.js", "./js/characters.js"]) {
    check(`it imports ${mod}`, st.includes(mod));
  }
  check("it does not need a model file", !/weights\/.*\.bin/.test(st));
  check("it measures the real board width", st.includes("getBoundingClientRect"));
  check("it checks for horizontal overflow", st.includes("scrollWidth"));
}

console.log("");
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILURES`);
  process.exitCode = 1;
}
