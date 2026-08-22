// The opponent roster.
//
// A character is the user-facing concept; the model/Elo/preset underneath
// are implementation details reachable through Advanced settings. Each
// archetype exists at three ages, and age is NOT cosmetic: it maps to Elo,
// and Elo changes both what Maia plays (it is the network's own
// conditioning) and how much room the persona is given.
//
// AGE -> ELO. The brief's anchors are 12 -> 1200, 18 -> 1800, 26 -> 2600,
// i.e. Elo = age * 100 across that range. Applied literally it would give a
// 6-year-old 600 and a 30-year-old 3000, so it is clamped to the band Maia
// was actually conditioned on and flattens after the mid-twenties, where
// real rating stops tracking age at all.

export const MIN_AGE = 6;
export const MAX_AGE = 26;
export const AGE_STEP = 0.5;
export const MIN_ELO = 600;
export const MAX_ELO = 2600;
export const ELO_STEP = 50;

// Age <-> Elo. The anchors are exact and linear across the whole range:
// 6 -> 600, 12 -> 1200, 18 -> 1800, 26 -> 2600, i.e. 100 Elo per year. A
// half-year is therefore exactly one 50-point rating step, which is why
// the age control moves in halves and the rating dropdown in fifties --
// they are two views of the same number.
export function eloForAge(age) {
  const clamped = Math.max(MIN_AGE, Math.min(MAX_AGE, age));
  return Math.round((clamped * 100) / ELO_STEP) * ELO_STEP;
}

export function ageForElo(elo) {
  const clamped = Math.max(MIN_ELO, Math.min(MAX_ELO, elo));
  return Math.round((clamped / 100) / AGE_STEP) * AGE_STEP;
}

/** Every selectable rating, 600..2600 in 50s. */
export const ELO_CHOICES = (() => {
  const out = [];
  for (let e = MIN_ELO; e <= MAX_ELO; e += ELO_STEP) out.push(e);
  return out;
})();

/** Every selectable age, 6..26 in halves. */
export const AGE_CHOICES = ELO_CHOICES.map(ageForElo);

/** "6", "6.5", "12", ... -- halves shown, whole years kept clean. */
export function formatAge(age) {
  return Number.isInteger(age) ? String(age) : age.toFixed(1);
}

// How strongly personality is allowed to express itself at a given rating.
//
// A weak player's style shows up as crude, obvious preferences and their
// move choice is noisy; a strong player's style is real but disciplined,
// and they rarely stray far from the best move. So: personality strength
// falls slightly with rating while sampling temperature falls a lot, and
// the number of candidates considered rises. This is what makes 1200-Josh
// and 2600-Josh both recognisably positional without playing identically.
export function styleForElo(elo) {
  const t = Math.max(0, Math.min(1, (elo - MIN_ELO) / (MAX_ELO - MIN_ELO)));
  return {
    strength: 1.0 - 0.25 * t,
    breadth: Math.round(4 + 2 * t),
    // How far the persona may depart from Maia's own policy ranking, in
    // nats (see scoring.js MAX_OVERRIDE_NATS). A weak player really does
    // insist on their pet plan; a strong one expresses style between
    // near-equal moves. ~1.9 (7x) down to ~1.05 (3x, the reference value).
    overrideNats: 1.9 - 0.85 * t,
    trapSearch: true,
  };
}

export const ARCHETYPES = {
  PositionalGenius: {
    label: "Positional Genius",
    blurb: "Patient, strategic, and obsessed with improving his pieces.",
    tendencies: ["Quiet improving moves", "Hates loose pawn structure", "Grinds endgames"],
  },
  TheAttacker: {
    label: "The Attacker",
    blurb: "Win in fifteen moves or die trying. Your king is the only thing on her mind.",
    tendencies: ["Hunts the king", "Sacrifices for initiative", "Never trades queens"],
  },
  TheWall: {
    label: "The Wall",
    blurb: "Immovable. He would rather hold a worse position for sixty moves than take a risk.",
    tendencies: ["Fortress defence", "Trades to defuse attacks", "Keeps every pawn"],
  },
  Trickster: {
    label: "Trickster",
    blurb: "Sets the board on fire and hands you the matches.",
    tendencies: ["Sharp gambits", "Lays traps", "Loves messy positions"],
  },
  Hoarder: {
    label: "Hoarder",
    blurb: "Takes the pawn. Always takes the pawn. Then refuses to give anything back.",
    tendencies: ["Grabs material", "Accepts every gambit", "Simplifies when ahead"],
  },
  TheSwindler: {
    label: "The Swindler",
    blurb: "Worst when he is losing — that is when the position gets truly confusing.",
    tendencies: ["Counterattacks under pressure", "Muddies lost positions", "Practical chances"],
  },
  TheTiltTrigger: {
    label: "The Tilt Trigger",
    blurb: "Passive, patient, and quietly infuriating. Nothing ever quite happens.",
    tendencies: ["Refuses to resolve tension", "Shuffles and waits", "Never commits"],
  },
};

// palette: [background, accent] used by the generated portrait.
const ROSTER = [
  {
    id: "josh",
    name: "Josh",
    archetype: "PositionalGenius",
    ages: AGE_CHOICES,
    palette: ["#2f4858", "#7fb3d5"],
    face: { hair: "short", accessory: "none" },
    bios: {
      child: "Learned from his grandfather's old books. Already never in a hurry.",
      teen: "Club champion two years running. Wins games nobody else finds interesting.",
      adult: "Titled, methodical, and completely immune to provocation.",
    },
  },
  {
    id: "mara",
    name: "Mara",
    archetype: "TheAttacker",
    ages: AGE_CHOICES,
    palette: ["#5a2233", "#e07a5f"],
    face: { hair: "long", accessory: "none" },
    bios: {
      child: "Has never once castled queenside and does not intend to start.",
      teen: "Blitz specialist. Believes defence is a rumour.",
      adult: "Her sacrifices used to be unsound. That stopped being true.",
    },
  },
  {
    id: "bern",
    name: "Bernard",
    archetype: "TheWall",
    ages: AGE_CHOICES,
    palette: ["#33413a", "#8fae7f"],
    face: { hair: "short", accessory: "glasses" },
    bios: {
      child: "Draws with everyone. Nobody enjoys it.",
      teen: "Correspondence player at heart. Will not be rushed.",
      adult: "Has held a rook-down endgame for ninety moves and drawn it.",
    },
  },
  {
    id: "kiko",
    name: "Kiko",
    archetype: "Trickster",
    ages: AGE_CHOICES,
    palette: ["#4a2f5e", "#c39bd3"],
    face: { hair: "curly", accessory: "none" },
    bios: {
      child: "Only plays gambits. Cannot explain any of them.",
      teen: "Prepares one nasty line and steers every game into it.",
      adult: "Knows exactly which move looks safest and is not.",
    },
  },
  {
    id: "greta",
    name: "Greta",
    archetype: "Hoarder",
    ages: AGE_CHOICES,
    palette: ["#5c4a1f", "#d4b483"],
    face: { hair: "bun", accessory: "none" },
    bios: {
      child: "If it is free, she takes it. Sometimes it is not free.",
      teen: "Accepts every gambit on principle and defends the extra pawn to the end.",
      adult: "A pawn up is a won game. She usually proves it.",
    },
  },
  {
    id: "duke",
    name: "Duke",
    archetype: "TheSwindler",
    ages: AGE_CHOICES,
    palette: ["#1f3d4a", "#4fb3a5"],
    face: { hair: "short", accessory: "cap" },
    bios: {
      child: "Loses a piece, then somehow wins. Nobody knows how.",
      teen: "Plays on in dead positions until the position stops being dead.",
      adult: "Resignation is a thing other people do.",
    },
  },
  {
    id: "pim",
    name: "Pim",
    archetype: "TheTiltTrigger",
    ages: AGE_CHOICES,
    palette: ["#3d3a30", "#b8b09a"],
    face: { hair: "short", accessory: "none" },
    bios: {
      child: "Moves the same knight back and forth. It is very effective.",
      teen: "Has never initiated a trade in his life.",
      adult: "Waits. And waits. You will crack first.",
    },
  },
];

// Which bio a given age gets. Three bands rather than 41 hand-written
// lines: the bio describes who they are at that stage of life, and the
// rating (and how they actually play) is what varies continuously.
function bandFor(age) {
  if (age < 13) return "child";
  if (age < 19) return "teen";
  return "adult";
}

// Flatten into one character per (person, age). 7 people x 41 ages.
export const CHARACTERS = ROSTER.flatMap((person) =>
  person.ages.map((age) => {
    const elo = eloForAge(age);
    return {
      id: `${person.id}-${String(age).replace(".", "_")}`,
      personId: person.id,
      name: person.name,
      age,
      ageLabel: formatAge(age),
      elo,
      archetype: person.archetype,
      archetypeLabel: ARCHETYPES[person.archetype].label,
      blurb: ARCHETYPES[person.archetype].blurb,
      bio: person.bios[bandFor(age)],
      tendencies: ARCHETYPES[person.archetype].tendencies,
      palette: person.palette,
      face: person.face,
      style: styleForElo(elo),
    };
  })
);

export const PEOPLE = ROSTER.map((p) => ({
  id: p.id,
  name: p.name,
  archetype: p.archetype,
  archetypeLabel: ARCHETYPES[p.archetype].label,
  blurb: ARCHETYPES[p.archetype].blurb,
  palette: p.palette,
  ages: p.ages,
}));

export function characterById(id) {
  return CHARACTERS.find((c) => c.id === id) || null;
}

export function charactersFor(personId) {
  return CHARACTERS.filter((c) => c.personId === personId).sort((a, b) => a.age - b.age);
}

/** The character for this person at this rating (nearest valid step). */
export function characterFor(personId, elo) {
  const wanted = Math.max(MIN_ELO, Math.min(MAX_ELO, Math.round(elo / ELO_STEP) * ELO_STEP));
  const set = charactersFor(personId);
  if (!set.length) return null;
  return set.find((c) => c.elo === wanted) || set[Math.floor(set.length / 2)];
}

// A "Vanilla Maia" pseudo-character, so the plain engine is reachable from
// the same UI without a separate mode switch.
export const VANILLA_CHARACTER = {
  id: "vanilla",
  personId: "vanilla",
  name: "Maia",
  age: null,
  ageLabel: null,
  elo: 1500,
  archetype: null,
  archetypeLabel: "No personality",
  blurb: "The Maia-3 network on its own, with no personality layer at all.",
  bio: "Plays whatever a human of the chosen rating would most likely play.",
  tendencies: ["Pure human-move prediction", "Rating is the only setting"],
  palette: ["#24352d", "#c9a227"],
  face: { hair: "none", accessory: "none" },
  // Vanilla Maia's strength is the rating alone; personality is entirely
  // off, so the style knobs that shape a persona do not apply.
  style: { strength: 0, breadth: 4, overrideNats: 1.1, trapSearch: false },
};

// ---- portraits --------------------------------------------------------
//
// Generated inline as SVG rather than shipped as images: no remote assets,
// no binary payload, scales cleanly at any size, and each character gets a
// stable look derived from their own palette and face descriptor.

export function portraitSvg(character, size = 96) {
  const [bg, accent] = character.palette;
  const skin = "#e8c9a8";
  const f = character.face || {};
  const hair = {
    short: `<path d="M30 40c0-13 9-20 20-20s20 7 20 20c0-6-8-9-20-9s-20 3-20 9z" fill="${accent}"/>`,
    long: `<path d="M28 44c0-15 10-24 22-24s22 9 22 24v18c0 4-4 5-5 1l-3-14c-4 4-9 5-14 5s-10-1-14-5l-3 14c-1 4-5 3-5-1z" fill="${accent}"/>`,
    curly: `<g fill="${accent}"><circle cx="34" cy="34" r="8"/><circle cx="45" cy="28" r="9"/><circle cx="57" cy="30" r="8"/><circle cx="66" cy="38" r="7"/></g>`,
    bun: `<g fill="${accent}"><circle cx="50" cy="16" r="7"/><path d="M30 42c0-14 9-22 20-22s20 8 20 22c0-7-8-11-20-11s-20 4-20 11z"/></g>`,
    none: "",
  }[f.hair || "none"] || "";
  const accessory = {
    glasses: `<g fill="none" stroke="#22312b" stroke-width="2.4"><circle cx="41" cy="51" r="7"/><circle cx="59" cy="51" r="7"/><path d="M48 51h4"/></g>`,
    cap: `<path d="M28 38c0-12 10-19 22-19s22 7 22 19H28z" fill="${accent}"/><path d="M26 38h34v5H26z" fill="${accent}" opacity="0.75"/>`,
    none: "",
  }[f.accessory || "none"] || "";

  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${escapeAttr(
    character.name
  )}" xmlns="http://www.w3.org/2000/svg">
  <defs><clipPath id="clip-${character.id}"><circle cx="50" cy="50" r="48"/></clipPath></defs>
  <g clip-path="url(#clip-${character.id})">
    <rect width="100" height="100" fill="${bg}"/>
    <circle cx="50" cy="94" r="34" fill="${accent}" opacity="0.55"/>
    <ellipse cx="50" cy="52" rx="20" ry="23" fill="${skin}"/>
    <circle cx="42" cy="50" r="2.4" fill="#2b2118"/>
    <circle cx="58" cy="50" r="2.4" fill="#2b2118"/>
    <path d="M44 62c3 2.5 9 2.5 12 0" stroke="#2b2118" stroke-width="2" fill="none" stroke-linecap="round"/>
    ${hair}
    ${accessory}
  </g>
  <circle cx="50" cy="50" r="47" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="2"/>
</svg>`;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
