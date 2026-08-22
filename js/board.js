const FILES = "abcdefgh";
const PIECE_SYMBOL_ID = {
  w: { p: "pc-wP", n: "pc-wN", b: "pc-wB", r: "pc-wR", q: "pc-wQ", k: "pc-wK" },
  b: { p: "pc-bP", n: "pc-bN", b: "pc-bB", r: "pc-bR", q: "pc-bQ", k: "pc-bK" },
};
const PIECE_NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const SVG_NS = "http://www.w3.org/2000/svg";

export class Board {
  constructor(container, { onUserMove, announce } = {}) {
    this.container = container;
    this.onUserMove = onUserMove || (() => {});
    this.announceFn = announce || (() => {});
    this.flipped = false;
    this.selected = null; // square name like "e2"
    this.legalTargets = new Set();
    this.lastMove = null; // {from, to}
    this.checkSquare = null;
    this.squares = new Map(); // name -> button element
    this.arrows = []; // [{from, to, kind}]
    this._buildGrid();
  }

  _buildGrid() {
    this.container.innerHTML = "";
    this.container.setAttribute("role", "grid");
    this.container.setAttribute("aria-label", "Chess board");
    for (let rankRow = 0; rankRow < 8; rankRow++) {
      const rowEl = document.createElement("div");
      rowEl.className = "board-row";
      rowEl.setAttribute("role", "row");
      for (let fileCol = 0; fileCol < 8; fileCol++) {
        const { file, rank } = this._displayToBoard(fileCol, rankRow);
        const name = FILES[file] + String(rank + 1);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "square " + ((file + rank) % 2 === 0 ? "dark" : "light");
        btn.dataset.square = name;
        btn.setAttribute("role", "gridcell");
        btn.tabIndex = -1;
        btn.addEventListener("click", () => this._onSquareActivate(name));
        btn.addEventListener("keydown", (e) => this._onKeyDown(e, fileCol, rankRow));
        rowEl.appendChild(btn);
        this.squares.set(name, btn);
      }
      this.container.appendChild(rowEl);
    }
    // Arrow overlay: one SVG stretched over the grid, pointer-events off so
    // it can never intercept a tap meant for a square.
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "arrow-layer");
    svg.setAttribute("viewBox", "0 0 8 8");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    this.arrowLayer = svg;
    this.container.appendChild(svg);
    this._renderArrows();
    // one square participates in the tab order; arrow keys move focus (roving tabindex)
    this.squares.get(this.flipped ? "h8" : "a1").tabIndex = 0;
  }

  _displayToBoard(col, row) {
    // row 0 = top of the visual grid
    if (!this.flipped) return { file: col, rank: 7 - row };
    return { file: 7 - col, rank: row };
  }

  setFlipped(flipped) {
    this.flipped = flipped;
    this._buildGrid();
    this.render(this._chess);
  }

  _onKeyDown(e, col, row) {
    const moves = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (moves[e.key]) {
      e.preventDefault();
      let [dc, dr] = moves[e.key];
      let nc = col + dc,
        nr = row + dr;
      if (nc < 0 || nc > 7 || nr < 0 || nr > 7) return;
      const { file, rank } = this._displayToBoard(nc, nr);
      const name = FILES[file] + String(rank + 1);
      this._focusSquare(name);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const { file, rank } = this._displayToBoard(col, row);
      this._onSquareActivate(FILES[file] + String(rank + 1));
    }
  }

  _focusSquare(name) {
    for (const btn of this.squares.values()) btn.tabIndex = -1;
    const btn = this.squares.get(name);
    btn.tabIndex = 0;
    btn.focus();
  }

  _onSquareActivate(name) {
    this._pendingActivate?.(name);
  }

  // Called by app.js to wire interaction against the live chess.js instance.
  bindInteraction(chess, { isMyTurn }) {
    this._chess = chess;
    this._pendingActivate = (name) => {
      if (!isMyTurn()) return;
      if (this.selected === name) {
        this.selected = null;
        this.legalTargets.clear();
        this.render(chess);
        return;
      }
      if (this.selected && this.legalTargets.has(name)) {
        this._completeMove(this.selected, name, chess);
        return;
      }
      const piece = chess.get(name);
      if (piece && piece.color === chess.turn()) {
        this.selected = name;
        const moves = chess.moves({ square: name, verbose: true });
        this.legalTargets = new Set(moves.map((m) => m.to));
        this.render(chess);
        this.announceFn(`${PIECE_NAME[piece.type]} on ${name} selected. ${moves.length} legal move${moves.length === 1 ? "" : "s"}.`);
      } else if (this.selected) {
        this.selected = null;
        this.legalTargets.clear();
        this.render(chess);
      }
    };
  }

  async _completeMove(from, to, chess) {
    const piece = chess.get(from);
    let promotion;
    const isPromotion = piece.type === "p" && (to[1] === "8" || to[1] === "1");
    if (isPromotion) {
      promotion = await this._askPromotion(chess.turn());
      if (!promotion) {
        this.selected = null;
        this.legalTargets.clear();
        this.render(chess);
        return;
      }
    }
    this.selected = null;
    this.legalTargets.clear();
    this.onUserMove({ from, to, promotion });
  }

  _askPromotion(color) {
    return new Promise((resolve) => {
      const dialog = document.getElementById("promo-dialog");
      const btnRow = dialog.querySelector(".promo-choices");
      btnRow.innerHTML = "";
      const controller = new AbortController();
      for (const p of ["q", "r", "b", "n"]) {
        const b = document.createElement("button");
        b.className = "promo-choice";
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", "0 0 45 45");
        svg.setAttribute("class", "piece piece-" + color);
        const use = document.createElementNS(SVG_NS, "use");
        use.setAttribute("href", "#" + PIECE_SYMBOL_ID[color][p]);
        svg.appendChild(use);
        b.appendChild(svg);
        b.setAttribute("aria-label", `Promote to ${PIECE_NAME[p]}`);
        b.addEventListener(
          "click",
          () => {
            controller.abort();
            dialog.close();
            resolve(p);
          },
          { signal: controller.signal }
        );
        btnRow.appendChild(b);
      }
      dialog.addEventListener(
        "cancel",
        () => {
          controller.abort();
          resolve(null);
        },
        { once: true, signal: controller.signal }
      );
      dialog.showModal();
    });
  }

  render(chess) {
    this._chess = chess;
    for (const [name, btn] of this.squares.entries()) {
      const piece = chess.get(name);
      btn.innerHTML = "";
      btn.classList.toggle("selected", this.selected === name);
      btn.classList.toggle("legal-target", this.legalTargets.has(name));
      btn.classList.toggle("has-piece-target", this.legalTargets.has(name) && !!piece);
      btn.classList.toggle("last-move", !!this.lastMove && (this.lastMove.from === name || this.lastMove.to === name));
      btn.classList.toggle("in-check", this.checkSquare === name);

      let label = name;
      if (piece) {
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", "0 0 45 45");
        svg.setAttribute("class", "piece piece-" + piece.color);
        svg.setAttribute("aria-hidden", "true");
        const use = document.createElementNS(SVG_NS, "use");
        use.setAttribute("href", "#" + PIECE_SYMBOL_ID[piece.color][piece.type]);
        svg.appendChild(use);
        btn.appendChild(svg);
        label = `${name}, ${piece.color === "w" ? "white" : "black"} ${PIECE_NAME[piece.type]}`;
      } else {
        label = `${name}, empty`;
      }
      if (this.legalTargets.has(name)) label += ", legal move";
      btn.setAttribute("aria-label", label);
    }
  }

  // Slide the piece that just moved from its origin to its destination.
  // Implemented as a transform on the already-rendered destination piece
  // rather than by moving DOM around: the board never reflows, so it stays
  // smooth on a phone and cannot disturb layout.
  animateMove(from, to) {
    if (!from || !to || this._reducedMotion()) return;
    const fromBtn = this.squares.get(from);
    const toBtn = this.squares.get(to);
    if (!fromBtn || !toBtn) return;
    const piece = toBtn.querySelector(".piece");
    if (!piece) return;
    const a = fromBtn.getBoundingClientRect();
    const b = toBtn.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (!dx && !dy) return;
    piece.style.transition = "none";
    piece.style.transform = `translate(${dx}px, ${dy}px)`;
    // Two frames: one to commit the start transform, one to animate from it.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        piece.style.transition = "transform 160ms cubic-bezier(0.22, 0.61, 0.36, 1)";
        piece.style.transform = "translate(0, 0)";
        const clear = () => {
          piece.style.transition = "";
          piece.style.transform = "";
        };
        piece.addEventListener("transitionend", clear, { once: true });
        setTimeout(clear, 400); // belt and braces if the event is missed
      });
    });
  }

  _reducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  setLastMove(from, to) {
    this.lastMove = { from, to };
  }

  setCheckSquare(square) {
    this.checkSquare = square;
  }

  // arrows: [{ from: "e2", to: "e4", kind: "best" | "alt" }]
  setArrows(arrows) {
    this.arrows = Array.isArray(arrows) ? arrows : [];
    this._renderArrows();
  }

  _squareCenter(name) {
    const file = FILES.indexOf(name[0]);
    const rank = Number(name[1]) - 1;
    const col = this.flipped ? 7 - file : file;
    const row = this.flipped ? rank : 7 - rank;
    return { x: col + 0.5, y: row + 0.5 };
  }

  _renderArrows() {
    if (!this.arrowLayer) return;
    this.arrowLayer.textContent = "";
    if (!this.arrows.length) return;
    for (let i = 0; i < this.arrows.length; i++) {
      const a = this.arrows[i];
      if (!a || !a.from || !a.to) continue;
      const p1 = this._squareCenter(a.from);
      const p2 = this._squareCenter(a.to);
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      // Stop short of the destination centre so the arrowhead sits on the
      // square rather than covering the piece standing there.
      const head = 0.34;
      const ex = p2.x - ux * head;
      const ey = p2.y - uy * head;
      const sx = p1.x + ux * 0.28;
      const sy = p1.y + uy * 0.28;
      const cls = "arrow arrow-" + (a.kind || "alt");

      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", sx);
      line.setAttribute("y1", sy);
      line.setAttribute("x2", ex);
      line.setAttribute("y2", ey);
      line.setAttribute("class", cls);
      this.arrowLayer.appendChild(line);

      const px = -uy;
      const py = ux;
      const w = 0.15;
      const tip = `${p2.x - ux * 0.12},${p2.y - uy * 0.12}`;
      const left = `${ex + px * w},${ey + py * w}`;
      const right = `${ex - px * w},${ey - py * w}`;
      const poly = document.createElementNS(SVG_NS, "polygon");
      poly.setAttribute("points", `${tip} ${left} ${right}`);
      poly.setAttribute("class", cls + " arrow-head");
      this.arrowLayer.appendChild(poly);
    }
  }
}
