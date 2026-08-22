// Direct port of personality/dimensions/*.py. Each dimension is a pure
// function (MoveFeatures) -> roughly [-1, 1]: "how much does this
// personality, at full strength, like this candidate" - independent of any
// weight. Only scoring.js multiplies these by a preset's weight, exactly
// as in the reference (dimensions never see their own weight).
//
// Registration order matches personality/dimensions/__init__.py.

const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

function aggressive(f) {
  let v = 0;
  v += 0.45 * clamp(f.opp_king_pressure_delta / 3);
  v += f.gives_check ? 0.35 : 0;
  if (f.is_capture && f.center_distance_delta <= 0) v += 0.2;
  v += 0.25 * clamp(f.momentum_alignment);
  v += 0.15 * clamp(f.space_delta);
  v -= f.retreats ? 0.25 : 0;
  v -= f.trades_queens ? 0.3 : 0;
  v -= f.initiates_trade ? 0.15 : 0;
  return clamp(v);
}

function tactical(f) {
  let v = 0;
  v += f.gives_check ? 0.35 : 0;
  v += f.is_capture ? 0.3 : 0;
  v += 0.25 * Math.min(1, Math.abs(f.see) / 5);
  v += 0.25 * Math.min(1, f.volatility / 6);
  v += f.maintains_tension ? 0.2 : 0;
  return clamp(v);
}

function positional(f) {
  let v = 0;
  v += 0.3 * clamp(f.mobility_delta / 6);
  v += 0.25 * clamp(-f.center_distance_delta / 2);
  v -= 0.25 * Math.min(1, Math.max(0, -f.material_delta) / 3);
  if (f.gives_check || f.is_capture) v -= 0.2;
  v -= f.creates_doubled_pawn ? 0.3 : 0;
  v -= f.creates_isolated_pawn ? 0.25 : 0;
  v += f.rook_to_open_file ? 0.25 : 0;
  v += f.is_prophylactic ? 0.2 : 0;
  v += f.develops_minor ? 0.15 : 0;
  v += 0.1 * clamp(f.space_delta);
  v -= f.retreats ? 0.15 : 0;
  return clamp(v);
}

function strategic(f) {
  let v = 0;
  v += f.is_passed_pawn_push ? 0.4 : 0;
  v += f.phase === "endgame" && f.king_centralizing ? 0.3 : 0;
  v += 0.25 * clamp(-f.center_distance_delta / 2);
  v -= f.is_capture ? 0.2 : 0;
  v -= f.creates_doubled_pawn ? 0.35 : 0;
  v -= f.creates_isolated_pawn ? 0.3 : 0;
  v += f.rook_to_open_file ? 0.25 : 0;
  v += 0.2 * clamp(f.space_delta);
  v += f.develops_minor ? 0.15 : 0;
  return clamp(v);
}

function defensive(f) {
  let v = 0;
  v -= 0.45 * clamp(f.own_king_pressure_delta / 3);
  v += f.is_castle ? 0.35 : 0;
  v -= f.is_sacrifice ? 0.3 : 0;
  v += f.trades_queens ? 0.3 : 0;
  v += f.initiates_trade ? 0.2 : 0;
  v += f.is_prophylactic ? 0.2 : 0;
  v -= f.maintains_tension ? 0.2 : 0;
  return clamp(v);
}

function solid(f) {
  let v = 0;
  v -= 0.4 * Math.min(1, Math.max(0, -f.material_delta) / 3);
  v -= f.is_sacrifice ? 0.35 : 0;
  v -= 0.3 * Math.min(1, f.volatility / 6);
  v += f.is_prophylactic ? 0.15 : 0;
  v -= f.creates_doubled_pawn || f.creates_isolated_pawn ? 0.15 : 0;
  if (f.initiates_trade && f.material_balance > 0) v += 0.25;
  if (f.trades_queens) v += 0.2;
  return clamp(v);
}

function gambiteer(f) {
  if (f.phase !== "opening") return 0;
  let v = 0;
  if (f.is_capture && f.material_delta >= -3 && f.material_delta < 0) v += 0.6;
  else if (f.is_sacrifice && f.material_delta >= -3) v += 0.5;
  v += 0.4 * clamp(f.mobility_delta / 6, 0, 1);
  return clamp(v);
}

function sacrificial(f) {
  if (f.material_delta >= 0) return 0;
  const hasCompensation = f.gives_check || f.opp_king_pressure_delta > 0 || f.creates_threat;
  if (!hasCompensation) return 0;
  const magnitude = Math.min(1, Math.abs(f.material_delta) / 4);
  return clamp(0.6 * magnitude + 0.4);
}

function endgame_specialist(f) {
  if (f.phase !== "endgame") return 0;
  let v = 0;
  v += f.king_centralizing ? 0.5 : 0;
  v += f.is_passed_pawn_push ? 0.5 : 0;
  return clamp(v);
}

function initiative(f) {
  let v = 0;
  v += f.gives_check ? 0.5 : 0;
  v += f.creates_threat ? 0.5 : 0;
  v += 0.3 * clamp(-f.opp_mobility_delta / 5);
  v -= f.retreats ? 0.2 : 0;
  return clamp(v);
}

function risk_taking(f) {
  let v = 0;
  v += 0.45 * Math.min(1, f.volatility / 6);
  v += f.is_sacrifice ? 0.3 : 0;
  v += 0.25 * Math.min(1, Math.max(0, -f.material_delta) / 3);
  v += f.maintains_tension ? 0.2 : 0;
  v -= f.trades_queens ? 0.2 : 0;
  return clamp(v);
}

function materialistic(f) {
  let v = 0;
  v += 0.5 * clamp(f.material_delta / 3);
  if (f.is_capture && f.see > 0) v += 0.3;
  else if (f.initiates_trade) v += f.material_balance > 0 ? 0.25 : -0.2;
  if (f.is_sacrifice) v -= 0.4;
  if (f.material_balance > 0 && f.material_delta < 0) v -= 0.3;
  return clamp(v);
}

function counterattacking(f) {
  if (!f.was_under_pressure_before) return 0;
  let v = 0;
  v += f.creates_threat ? 0.7 : 0;
  v += f.gives_check ? 0.3 : 0;
  return clamp(v);
}

function trappy(f) {
  let v = 0.9 * clamp(f.trap_value);
  if (f.trap_value > 0.2 && !f.gives_check && !f.is_capture) v += 0.15;
  return clamp(v);
}

function human_like(f) {
  return clamp((f.policy_prob - 0.15) * 2);
}

export const DIMENSIONS = [
  { id: "aggressive", label: "Aggressive", score: aggressive },
  { id: "tactical", label: "Tactical", score: tactical },
  { id: "positional", label: "Positional", score: positional },
  { id: "strategic", label: "Strategic", score: strategic },
  { id: "defensive", label: "Defensive", score: defensive },
  { id: "solid", label: "Solid", score: solid },
  { id: "gambiteer", label: "Gambiteer", score: gambiteer },
  { id: "sacrificial", label: "Sacrificial", score: sacrificial },
  { id: "endgame_specialist", label: "Endgame Specialist", score: endgame_specialist },
  { id: "initiative", label: "Initiative", score: initiative },
  { id: "risk_taking", label: "Risk Taking", score: risk_taking },
  { id: "materialistic", label: "Materialistic", score: materialistic },
  { id: "counterattacking", label: "Counterattacking", score: counterattacking },
  { id: "trappy", label: "Trappy", score: trappy },
  { id: "human_like", label: "Human-like", score: human_like },
];

export const DIMENSION_IDS = DIMENSIONS.map((d) => d.id);
