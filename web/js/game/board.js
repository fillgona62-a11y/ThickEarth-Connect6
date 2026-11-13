/**
 * Accessible Connect6 board renderer.
 *
 * The board is a CSS grid with a roving-tabindex ARIA grid pattern: arrow keys
 * move focus, Enter/Space activates a legal point. Stones use both seat colour
 * and a distinct per-seat shape, so the position is readable without relying on
 * colour. Connect6 has no camps, no territory and no captures, so a cell is
 * either empty or owned by a seat — nothing else to draw.
 */
import { h, s, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { cellName, seatLetter, seatColor } from '../core/format.js';

const MOVE_KEYS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

const STONE_SHAPES = [
  { tag: 'circle', attrs: { cx: 50, cy: 50, r: 30 } },
  { tag: 'rect', attrs: { x: 22, y: 22, width: 56, height: 56, rx: 8, transform: 'rotate(45 50 50)' } }
];

/** Board sizes that carry the classic nine star points. */
const STAR_POINTS = new Map([
  [19, [[3, 3], [9, 3], [15, 3], [3, 9], [9, 9], [15, 9], [3, 15], [9, 15], [15, 15]]],
  [13, [[3, 3], [9, 3], [6, 6], [3, 9], [9, 9]]],
  [9, [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]]]
]);

function safeColor(seat) {
  return seatColor(seat);
}

function playerNames(state) {
  const map = new Map();
  if (!state || !Array.isArray(state.players)) return map;
  for (const player of state.players) map.set(player.seat, player.name);
  return map;
}

function nameOf(names, seat) {
  return names.get(seat) || t('game.seatN', { n: seat + 1 });
}

/** A cell holds a seat index or null; seat 0 is falsy, so never test truthiness. */
function seatAt(cells, index) {
  const value = cells ? cells[index] : null;
  return typeof value === 'number' ? value : null;
}

function actionSet(legalActions) {
  const map = new Map();
  for (const action of legalActions || []) {
    if (!action || typeof action.x !== 'number' || typeof action.y !== 'number') continue;
    map.set(action.x + ',' + action.y, action.type || 'place');
  }
  return map;
}

/** Last stone of the log, tolerant of both the points array and flat x/y. */
function lastPointOf(history) {
  const entries = Array.isArray(history) ? history : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (Array.isArray(entry.points) && entry.points.length > 0) {
      const point = entry.points[entry.points.length - 1];
      if (point && typeof point.x === 'number') return { x: point.x, y: point.y };
    }
    if (typeof entry.x === 'number' && typeof entry.y === 'number') return { x: entry.x, y: entry.y };
  }
  return null;
}

/**
 * Build the board model from an engine state plus view options.
 */
export function boardModelFromState(state, options) {
  const opts = options || {};
  if (!state || !Array.isArray(state.cells)) return null;
  const legalActions = opts.legalActions || [];
  return {
    boardSize: state.boardSize || 19,
    winLength: state.winLength || 6,
    cells: state.cells,
    players: state.players || [],
    names: playerNames(state),
    interactive: Boolean(opts.interactive),
    legal: actionSet(legalActions),
    last: opts.last || lastPointOf(state.history),
    winLine: opts.winLine || (state.result && Array.isArray(state.result.line) ? state.result.line : null),
    phase: opts.phase || (state.phase || null),
    currentSeat: typeof opts.currentSeat === 'number' ? opts.currentSeat : state.currentSeat,
    pending: Boolean(opts.pending),
    empty: Boolean(opts.empty)
  };
}

/**
 * Build the board model from a GameView (docs/API.md), where the engine state
 * is nested under "state" and legal actions under "legalActions".
 */
export function boardModelFromGame(game, options) {
  const opts = options || {};
  if (!game || !game.state) return null;
  return boardModelFromState(game.state, {
    interactive: opts.interactive,
    legalActions: opts.legalActions !== undefined ? opts.legalActions : game.legalActions,
    pending: opts.pending,
    currentSeat: game.state.currentSeat,
    winLine: opts.winLine,
    last: opts.last,
    phase: opts.phase
  });
}

export class Board {
  constructor(options) {
    this.options = options || {};
    this.onActivate = this.options.onActivate || null;
    this.onInspect = this.options.onInspect || null;
    this.model = null;
    this.focusX = 0;
    this.focusY = 0;
    this.helpId = 'board-help-' + Math.random().toString(36).slice(2, 8);
    this.root = h('div', { class: 'board-area' });
    this.shell = h('div', { class: 'board-shell' });
    this.grid = h('div', {
      class: 'board',
      role: 'grid',
      'aria-label': this.options.label || t('game.boardLabel'),
      'aria-describedby': this.options.hideHint ? null : this.helpId
    });
    this.topCoords = h('div', { class: 'coords coords--top', 'aria-hidden': 'true' });
    this.bottomCoords = h('div', { class: 'coords coords--bottom', 'aria-hidden': 'true' });
    this.leftCoords = h('div', { class: 'coords coords--left', 'aria-hidden': 'true' });
    this.rightCoords = h('div', { class: 'coords coords--right', 'aria-hidden': 'true' });
    this.shell.appendChild(h('div', { class: 'coords-corner', 'aria-hidden': 'true' }));
    this.shell.appendChild(this.topCoords);
    this.shell.appendChild(h('div', { class: 'coords-corner', 'aria-hidden': 'true' }));
    this.shell.appendChild(this.leftCoords);
    this.shell.appendChild(this.grid);
    this.shell.appendChild(this.rightCoords);
    this.shell.appendChild(h('div', { class: 'coords-corner', 'aria-hidden': 'true' }));
    this.shell.appendChild(this.bottomCoords);
    this.shell.appendChild(h('div', { class: 'coords-corner', 'aria-hidden': 'true' }));
    this.root.appendChild(this.shell);
    if (!this.options.hideHint) {
      this.root.appendChild(h('p', { class: 'board-hint', id: this.helpId },
        icon('grid', 13),
        h('span', null, t('a11y.boardHelp'))
      ));
    }
    this.grid.addEventListener('keydown', (event) => this.handleKeydown(event));
    this.grid.addEventListener('click', (event) => this.handleClick(event));
    this.grid.addEventListener('focusin', (event) => {
      const cell = event.target.closest('[role="gridcell"]');
      if (!cell) return;
      this.focusX = Number(cell.dataset.x);
      this.focusY = Number(cell.dataset.y);
      this.updateTabStops(cell);
    });
  }

  setModel(model) {
    const hadFocus = this.grid.contains(document.activeElement);
    this.model = model;
    this.render();
    if (hadFocus) this.focusCell(this.focusX, this.focusY, true);
    return this;
  }

  render() {
    clear(this.grid);
    const model = this.model;
    if (!model) return;
    const size = model.boardSize || 19;
    this.grid.style.setProperty('--board-size', String(size));
    this.shell.style.setProperty('--board-size', String(size));
    this.grid.dataset.size = String(size);
    clear(this.topCoords);
    clear(this.bottomCoords);
    clear(this.leftCoords);
    clear(this.rightCoords);
    for (let x = 0; x < size; x += 1) {
      this.topCoords.appendChild(h('span', { class: 'coord' }, String.fromCharCode(65 + x)));
      this.bottomCoords.appendChild(h('span', { class: 'coord' }, String.fromCharCode(65 + x)));
    }
    for (let y = 0; y < size; y += 1) {
      this.leftCoords.appendChild(h('span', { class: 'coord' }, String(y + 1)));
      this.rightCoords.appendChild(h('span', { class: 'coord' }, String(y + 1)));
    }
    const legalCount = model.legal ? model.legal.size : 0;
    this.grid.setAttribute('aria-rowcount', String(size));
    this.grid.setAttribute('aria-colcount', String(size));
    this.grid.classList.toggle('board--interactive', model.interactive && legalCount > 0);
    this.grid.classList.toggle('board--pending', Boolean(model.pending));

    const stars = new Set((STAR_POINTS.get(size) || []).map(([sx, sy]) => sx + ',' + sy));
    const winLine = new Set((model.winLine || []).map((point) => point.x + ',' + point.y));

    let focusPlaced = false;
    for (let y = 0; y < size; y += 1) {
      const row = h('div', { class: 'board-row', role: 'row', 'aria-rowindex': y + 1 });
      for (let x = 0; x < size; x += 1) {
        const isRoving = x === this.focusX && y === this.focusY;
        if (isRoving) focusPlaced = true;
        row.appendChild(this.renderCell(x, y, size, isRoving, stars, winLine));
      }
      this.grid.appendChild(row);
    }
    if (!focusPlaced) {
      this.focusX = 0;
      this.focusY = 0;
      this.updateTabStops(null);
    }
  }

  renderCell(x, y, size, isRoving, stars, winLine) {
    const model = this.model;
    const index = y * size + x;
    const seat = seatAt(model.cells, index);
    const legalType = model.legal ? model.legal.get(x + ',' + y) : undefined;
    const actionable = Boolean(model.interactive && legalType);
    const isLast = Boolean(model.last && model.last.x === x && model.last.y === y);
    const key = x + ',' + y;
    const isStar = stars ? stars.has(key) : false;
    const inWinLine = winLine ? winLine.has(key) : false;

    const classes = ['cell'];
    if (seat !== null) classes.push('cell--occupied');
    if (actionable) classes.push('cell--legal');
    if (isLast) classes.push('cell--last');
    if (isStar) classes.push('cell--star');
    if (inWinLine) classes.push('cell--win');
    if (model.pending) classes.push('cell--pending');

    const label = this.cellLabel(x, y, seat, legalType, isLast, inWinLine);
    const cell = h('div', {
      class: classes.join(' '),
      role: 'gridcell',
      tabindex: isRoving ? '0' : '-1',
      'data-x': x,
      'data-y': y,
      'aria-colindex': x + 1,
      'aria-label': label,
      'aria-disabled': model.interactive ? (actionable ? 'false' : 'true') : null
    });
    if (isLast) cell.dataset.last = 'true';
    if (isStar) cell.appendChild(h('span', { class: 'cell-star', 'aria-hidden': 'true' }));

    if (seat !== null) {
      cell.appendChild(this.renderPiece(seat));
    } else if (actionable) {
      cell.appendChild(h('span', { class: 'cell-marker cell-marker--place cell-marker--hover', 'aria-hidden': 'true' },
        icon('plus', 12)
      ));
    }
    if (isLast) {
      cell.appendChild(h('span', { class: 'cell-last-mark', 'aria-hidden': 'true' }));
    }
    return cell;
  }

  renderPiece(seat) {
    const color = safeColor(seat);
    const letter = seatLetter(seat);
    const svg = s('svg', {
      viewBox: '0 0 100 100',
      class: 'piece piece--' + color + ' piece--stone',
      'aria-hidden': 'true',
      focusable: 'false'
    });
    const shape = STONE_SHAPES[seat] || STONE_SHAPES[0];
    svg.appendChild(s(shape.tag, Object.assign({}, shape.attrs, { class: 'piece-shape' })));
    svg.appendChild(s('text', {
      class: 'piece-letter',
      x: 50,
      y: 62,
      'text-anchor': 'middle'
    }, letter));
    return svg;
  }

  cellLabel(x, y, seat, legalType, isLast, inWinLine) {
    const model = this.model;
    const name = seat !== null ? nameOf(model.names, seat) : '';
    const cell = cellName(x, y);
    const joiner = t('common.listSeparator');
    let label;
    if (legalType) label = t('game.cellAriaLegal', { cell: cell, action: t('notation.place') });
    else if (seat !== null) label = t('game.cellAriaStone', { cell: cell, name: name });
    else label = t('game.cellAriaEmpty', { cell: cell });
    if (isLast) label = label + joiner + t('game.cellAriaLast');
    if (inWinLine) label = label + joiner + t('game.cellAriaWin');
    return label;
  }

  updateTabStops(activeCell) {
    const cells = this.grid.querySelectorAll('[role="gridcell"]');
    for (const cell of cells) cell.setAttribute('tabindex', '-1');
    const target = activeCell || this.grid.querySelector('[data-x="' + this.focusX + '"][data-y="' + this.focusY + '"]') || cells[0];
    if (target) target.setAttribute('tabindex', '0');
  }

  focusCell(x, y, silent) {
    const size = this.model ? this.model.boardSize : 19;
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    this.focusX = x;
    this.focusY = y;
    const cell = this.grid.querySelector('[data-x="' + x + '"][data-y="' + y + '"]');
    if (!cell) return;
    cell.setAttribute('tabindex', '0');
    if (!silent && typeof cell.focus === 'function') cell.focus();
  }

  handleKeydown(event) {
    const cell = event.target.closest('[role="gridcell"]');
    if (!cell) return;
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    const size = this.model ? this.model.boardSize : 19;
    const delta = MOVE_KEYS[event.key];
    if (delta) {
      event.preventDefault();
      let nextX = x + delta[0];
      let nextY = y + delta[1];
      nextX = Math.max(0, Math.min(size - 1, nextX));
      nextY = Math.max(0, Math.min(size - 1, nextY));
      this.focusCell(nextX, nextY);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      this.focusCell(0, y);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      this.focusCell(size - 1, y);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      this.activate(x, y);
    }
  }

  handleClick(event) {
    const cell = event.target.closest('[role="gridcell"]');
    if (!cell) return;
    this.activate(Number(cell.dataset.x), Number(cell.dataset.y));
  }

  activate(x, y) {
    if (!this.model) return;
    const legalType = this.model.legal ? this.model.legal.get(x + ',' + y) : undefined;
    const payload = { x: x, y: y, type: legalType || null };
    if (this.model.interactive && legalType) {
      if (this.onActivate) this.onActivate(payload);
      return;
    }
    if (this.onInspect) this.onInspect(payload);
  }

  focusBoard() {
    this.focusCell(this.focusX, this.focusY);
  }

  destroy() {
    this.onActivate = null;
    this.onInspect = null;
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }
}

/**
 * Small static board diagram used in the rules view. Not interactive.
 *
 * @param {{size?: number, stones?: Array<{x: number, y: number, seat: number}>, highlight?: Array<[number, number]>, winLine?: Array<{x: number, y: number}>, label?: string}} options
 */
export function staticBoard(options) {
  const opts = options || {};
  const size = opts.size || 9;
  const stones = Array.isArray(opts.stones) ? opts.stones : [];
  const stoneAt = new Map(stones.map((stone) => [stone.x + ',' + stone.y, stone.seat]));
  const winLine = new Set((opts.winLine || []).map((point) => point.x + ',' + point.y));
  const highlight = new Set((opts.highlight || []).map(([x, y]) => x + ',' + y));
  const stars = new Set((STAR_POINTS.get(size) || []).map(([x, y]) => x + ',' + y));
  const grid = h('div', {
    class: 'board board--static',
    role: 'img',
    'aria-label': opts.label || t('rules.exampleCaption')
  });
  grid.style.setProperty('--board-size', String(size));
  for (let y = 0; y < size; y += 1) {
    const row = h('div', { class: 'board-row', 'aria-hidden': 'true' });
    for (let x = 0; x < size; x += 1) {
      const key = x + ',' + y;
      const classes = ['cell', 'cell--static'];
      if (stars.has(key)) classes.push('cell--star');
      if (highlight.has(key)) classes.push('cell--legal');
      if (winLine.has(key)) classes.push('cell--win');
      const seat = stoneAt.has(key) ? stoneAt.get(key) : null;
      const children = [];
      if (stars.has(key)) children.push(h('span', { class: 'cell-star' }));
      if (seat !== null) {
        children.push(h('span', { class: 'stone-token stone-token--' + safeColor(seat) }, seatLetter(seat)));
      }
      row.appendChild(h('div', { class: classes.join(' ') }, children));
    }
    grid.appendChild(row);
  }
  return grid;
}
