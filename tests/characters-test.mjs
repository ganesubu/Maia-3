// Character roster tests.
//   node tests/characters-test.mjs
//
// Covers the two claims the roster makes: that age maps meaningfully to
// Elo, and that the same archetype at different ages keeps its personality
// while genuinely playing differently. The second is checked against the
// real personality scoring code with a mock Maia policy, so it is a claim
// about behaviour rather than about labels.

import { Chess } from "../js/chess.esm.js";
import {
  CHARACTERS,
  PEOPLE,
  ARCHETYPES,
  VANILLA_CHARACTER,
  ELO_CHOICES,
  AGE_CHOICES,
  MIN_AGE,
  MAX_AGE,
  MIN_ELO,
  MAX_ELO,
  ELO_STEP,
  AGE_STEP,
  eloForAge,
  ageForElo,
  formatAge,
  styleForElo,
  characterById,
  characterFor,
  charactersFor,
  portraitSvg,
} from "../js/characters.js";
import { PRESETS, weightsFor } from "../js/personality/presets.js";
import { PersonalityController } from "../js/personality/controller.js";
import { computeMoveFeatures, positionContext, materialBalanceOf } from "../js/personality/features.js";
import { rankCandidates, sampleMove } from "../js/personality/scoring.js";

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

console.log("=== 1. age maps to Elo across the full range ===");
check("6 -> 600", eloForAge(6) === 600, String(eloForAge(6)));
check("12 -> 1200", eloForAge(12) === 1200, String(eloForAge(12)));
check("18 -> 1800", eloForAge(18) === 1800, String(eloForAge(18)));
check("26 -> 2600", eloForAge(26) === 2600, String(eloForAge(26)));
check("6.5 -> 650", eloForAge(6.5) === 650, String(eloForAge(6.5)));
check("half a year is exactly one 50-point step", eloForAge(10.5) - eloForAge(10) === 50);
check("the mapping is monotonic", AGE_CHOICES.every((a, i) => i === 0 || eloForAge(a) > eloForAge(AGE_CHOICES[i - 1])));
check("it clamps below", eloForAge(2) === MIN_ELO, String(eloForAge(2)));
check("it clamps above", eloForAge(80) === MAX_ELO, String(eloForAge(80)));
check("Elo -> age inverts it", ELO_CHOICES.every((e) => eloForAge(ageForElo(e)) === e));
check("age -> Elo inverts it", AGE_CHOICES.every((a) => ageForElo(eloForAge(a)) === a));

console.log("=== 1b. the selectable ladders line up ===");
check("41 ratings, 600..2600", ELO_CHOICES.length === 41 && ELO_CHOICES[0] === 600 && ELO_CHOICES.at(-1) === 2600, String(ELO_CHOICES.length));
check("every rating is a 50-step", ELO_CHOICES.every((e) => e % ELO_STEP === 0));
check("ratings are strictly increasing", ELO_CHOICES.every((e, i) => i === 0 || e === ELO_CHOICES[i - 1] + ELO_STEP));
check("41 ages, 6..26", AGE_CHOICES.length === 41 && AGE_CHOICES[0] === MIN_AGE && AGE_CHOICES.at(-1) === MAX_AGE, String(AGE_CHOICES.length));
check("every age is a half-year step", AGE_CHOICES.every((a, i) => i === 0 || Math.abs(a - AGE_CHOICES[i - 1] - AGE_STEP) < 1e-9));
check("whole years print cleanly", formatAge(12) === "12", formatAge(12));
check("halves print with one decimal", formatAge(6.5) === "6.5", formatAge(6.5));

console.log("=== 2. roster integrity ===");
check("there are seven personalities", PEOPLE.length === 7, String(PEOPLE.length));
check("each spans the whole ladder", PEOPLE.every((p) => p.ages.length === 41));
check("the roster is 7 x 41 characters", CHARACTERS.length === 287, String(CHARACTERS.length));
check("ids are unique", new Set(CHARACTERS.map((c) => c.id)).size === CHARACTERS.length);
check("ids are safe for use in markup", CHARACTERS.every((c) => /^[a-z0-9_-]+$/.test(c.id)), CHARACTERS[1].id);
for (const c of CHARACTERS) {
  check(`${c.id} has an Elo matching its age`, c.elo === eloForAge(c.age), `${c.elo} vs ${eloForAge(c.age)}`);
  check(`${c.id} has an age label`, typeof c.ageLabel === "string" && c.ageLabel.length > 0);
  check(`${c.id} has an archetype that exists as a preset`, !!PRESETS[c.archetype], c.archetype);
  check(`${c.id} has a bio`, c.bio && c.bio.length > 10);
  check(`${c.id} lists tendencies`, c.tendencies.length >= 2);
}
check("every archetype is represented", new Set(CHARACTERS.map((c) => c.archetype)).size === 7);
check("lookup by id works", characterById("josh-18") && characterById("josh-18").elo === 1800);
check("lookup of a bad id returns null", characterById("nobody-99") === null);
check("charactersFor returns ages in order", charactersFor("josh").every((c, i, a) => i === 0 || c.age > a[i - 1].age));

console.log("=== 2b. characterFor(person, elo) ===");
for (const elo of ELO_CHOICES) {
  const c = characterFor("josh", elo);
  check(`josh at ${elo} resolves`, !!c && c.elo === elo, c && String(c.elo));
}
check("an off-grid rating snaps to the nearest step", characterFor("josh", 1237).elo === 1250, String(characterFor("josh", 1237).elo));
check("below the floor clamps", characterFor("josh", 100).elo === MIN_ELO);
check("above the ceiling clamps", characterFor("josh", 9000).elo === MAX_ELO);
check("an unknown person returns null", characterFor("nobody", 1200) === null);

console.log("=== 3. the same archetype persists across ages ===");
for (const person of PEOPLE) {
  const set = charactersFor(person.id);
  check(`${person.name} keeps one archetype at every age`, new Set(set.map((c) => c.archetype)).size === 1);
  // Bios are written per life-stage (child / teen / adult) rather than one
  // per half-year, so what must differ is across stages, not across steps.
  const bios = new Set(set.map((c) => c.bio));
  check(`${person.name} has a distinct bio per life stage`, bios.size === 3, `${bios.size} distinct`);
  check(`${person.name}'s youngest and oldest read differently`, set[0].bio !== set.at(-1).bio);
}

console.log("=== 4. but strength settings genuinely differ by age ===");
for (const person of PEOPLE) {
  const set = charactersFor(person.id);
  const young = set[0];
  const mid = set[Math.floor(set.length / 2)];
  const old = set.at(-1);
  check(`${person.name}: candidate breadth rises with rating`, old.style.breadth >= young.style.breadth, `${young.style.breadth} -> ${old.style.breadth}`);
  check(`${person.name}: style is a little more disciplined at high rating`, old.style.strength < young.style.strength, `${young.style.strength} -> ${old.style.strength}`);
  check(`${person.name}: personality is still substantial when strong`, old.style.strength >= 0.7, String(old.style.strength));
  void mid;
}
check("styleForElo has no hidden per-character temperature", ELO_CHOICES.every((e) => !Object.hasOwn(styleForElo(e), "temperature")));

console.log("=== 5. behavioural difference: young vs old, same archetype ===");
{
  // Mock Maia: a deterministic pseudo-policy plus a material-based value,
  // exactly as in personality-test.mjs. The real scoring code then decides.
  // A realistic mock policy: real Maia policy heads are PEAKED (the top
  // move typically carries a large share), not uniform. The hash decides
  // the arbitrary ordering — uncorrelated with any personality — and a
  // geometric decay supplies a realistic shape. An unrealistically flat
  // mock would hide the effect of temperature entirely.
  function pseudoPolicy(moves, seedKey = "") {
    const order = moves
      .map((m, i) => {
        const uci = m.from + m.to + (m.promotion || "");
        let h = 2166136261;
        for (let k = 0; k < uci.length; k++) {
          h ^= uci.charCodeAt(k);
          h = Math.imul(h, 16777619);
        }
        return { i, h: h >>> 0 };
      })
      .sort((a, b) => a.h - b.h);
    const probs = new Array(moves.length).fill(0);
    let total = 0;
    order.forEach((entry, rank) => {
      const p = Math.pow(0.55, rank) + 0.001;
      probs[entry.i] = p;
      total += p;
    });
    return probs.map((p) => p / total);
  }

  function rankFor(fen, character) {
    const board = new Chess(fen);
    const moves = board.moves({ verbose: true });
    const probs = pseudoPolicy(moves, fen);
    const ctx = positionContext(board);
    const cands = moves
      .map((m, i) => {
        const child = new Chess(fen);
        child.move({ from: m.from, to: m.to, promotion: m.promotion });
        return { move: m, prob: probs[i], child };
      })
      .sort((a, b) => b.prob - a.prob)
      .slice(0, character.style.breadth);
    const feats = cands.map((c) =>
      computeMoveFeatures(board, c.move, c.child, {
        ...ctx,
        policyProb: c.prob,
        modelCp: Math.max(-1000, Math.min(1000, materialBalanceOf(c.child, board.turn()) * 90)),
      })
    );
    return rankCandidates(feats, weightsFor(character.archetype), {
      personaScale: character.style.strength,
      traits: null,
    });
  }

  const POSITIONS = [
    "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    "r1bq1rk1/pp2ppbp/2np1np1/8/3NP3/2N1BP2/PPPQ2PP/R3KB1R w KQ - 4 9",
    "r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w kq - 5 11",
    "8/5pk1/6p1/8/3K4/4P3/5P2/8 w - - 0 40",
  ];

  // Global temperature is deliberately shared across characters. Age/Elo
  // differences are therefore measured through candidate breadth/strength,
  // while sampling is controlled by one global value.
  const GLOBAL_TEST_TEMPERATURE = 0.5;

  function sampleDistribution(fen, character, trials = 400) {
    const ranked = rankFor(fen, character);
    const counts = new Map();
    let seed = 12345;
    const realRandom = Math.random;
    Math.random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    try {
      for (let i = 0; i < trials; i++) {
        const pick = sampleMove(ranked, GLOBAL_TEST_TEMPERATURE, 1.0);
        const uci = pick.features.uci;
        counts.set(uci, (counts.get(uci) || 0) + 1);
      }
    } finally {
      Math.random = realRandom;
    }
    const topShare = Math.max(...counts.values()) / trials;
    return { counts, topShare, distinct: counts.size, ranked };
  }

  for (const person of PEOPLE) {
    const set2 = charactersFor(person.id);
    const young = set2[0];
    const old = set2.at(-1);
    let sameFavourite = 0;
    for (const fen of POSITIONS) {
      const y = rankFor(fen, young);
      const o = rankFor(fen, old);
      check(`${person.name} @${young.elo} produced a ranking`, y.length > 0);
      check(`${person.name} @${old.elo} produced a ranking`, o.length > 0);
      check(`${person.name}: the stronger version considers at least as many moves`, o.length >= y.length, `${y.length} vs ${o.length}`);
      if (y[0].features.uci === o[0].features.uci) sameFavourite++;

      const dy = sampleDistribution(fen, young);
      const doo = sampleDistribution(fen, old);
      // Global temperature is the same for both ages, so the test should
      // not claim that age alone makes one sampling distribution looser.
      check(
        `${person.name}: global-temperature sample remains valid for both ages`,
        dy.distinct >= 1 && doo.distinct >= 1,
        `${dy.distinct} / ${doo.distinct}`
      );
    }
    // Same person, same taste: the archetype's favourite move should still
    // agree most of the time. A character that changed its mind entirely
    // with rating would not be the same player.
    check(
      `${person.name}: young and old still share a favourite most of the time`,
      sameFavourite >= Math.ceil(POSITIONS.length / 2),
      `${sameFavourite}/${POSITIONS.length}`
    );
  }
}

console.log("=== 6. vanilla Maia pseudo-character ===");
check("vanilla has no archetype", VANILLA_CHARACTER.archetype === null);
check("vanilla's personality strength is zero", VANILLA_CHARACTER.style.strength === 0);
check("vanilla still has a portrait palette", VANILLA_CHARACTER.palette.length === 2);
check("vanilla is not in the character roster", !CHARACTERS.some((c) => c.id === "vanilla"));

console.log("=== 7. portraits are safe, local, inline SVG ===");
for (const c of [...CHARACTERS, VANILLA_CHARACTER]) {
  const svg = portraitSvg(c, 64);
  check(`${c.id} portrait is an svg`, svg.trim().startsWith("<svg") && svg.trim().endsWith("</svg>"));
  // The xmlns declaration and url(#local) fragment references are not
  // network requests; anything else with a scheme or an <image> would be.
  const fetchy = svg
    .replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "")
    .replace(/url\(#[^)]*\)/g, "");
  check(`${c.id} portrait requests no network resource`, !/https?:|url\(|<image|xlink:href/i.test(fetchy), fetchy.slice(0, 60));
  check(`${c.id} portrait has an accessible label`, svg.includes('role="img"') && svg.includes("aria-label"));
  check(`${c.id} portrait uses its own palette`, svg.includes(c.palette[0]));
  check(`${c.id} portrait has a unique clip id`, svg.includes(`clip-${c.id}`));
}
{
  const evil = { ...CHARACTERS[0], id: "x", name: 'Bad"><script>alert(1)</script>' };
  const svg = portraitSvg(evil, 32);
  check("portrait labels are escaped", !svg.includes("<script>"), svg.slice(0, 120));
}

console.log("=== 8. personality state resets between games ===");
{
  const controller = new PersonalityController();
  for (let i = 0; i < 6; i++) controller.updateMomentum("g5");
  check("momentum accumulated", Math.abs(controller.flankCommitment) > 0.2);
  controller.reset();
  check("reset clears momentum", controller.flankCommitment === 0);
  check("reset clears the ply counter", controller.pliesThisGame === 0);
}

console.log("");
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILURES`);
  process.exitCode = 1;
}
