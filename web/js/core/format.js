/**
 * Localized formatting helpers plus labels shared across views.
 */
import { getLang, t } from './i18n.js';

export const SEAT_LETTERS = ['A', 'B'];
export const SEAT_COLORS = ['black', 'white'];
export const SEAT_SHAPES = ['circle', 'diamond'];

export function seatLetter(seat) {
  return SEAT_LETTERS[seat] || String(seat + 1);
}

export function seatColor(seat) {
  return SEAT_COLORS[seat] || 'black';
}

export function seatShape(seat) {
  return SEAT_SHAPES[seat] || 'circle';
}

export function cellName(x, y) {
  return String.fromCharCode(65 + x) + String(y + 1);
}

export function locale() {
  return getLang() === 'zh' ? 'zh-CN' : 'en-GB';
}

export function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return new Intl.NumberFormat(locale()).format(value);
}

export function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 }).format(value);
}

export function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

export function formatDateShort(timestamp) {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-';
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return t('duration.hoursMinutes', { h: hours, m: minutes });
  if (minutes > 0) return t('duration.minutesSeconds', { m: minutes, s: seconds });
  return t('duration.seconds', { s: seconds });
}

export function modeLabel(mode) {
  const key = 'mode.' + mode;
  const value = t(key);
  return value === key ? String(mode || '-') : value;
}

export function statusLabel(status) {
  const key = 'status.' + status;
  const value = t(key);
  return value === key ? String(status || '-') : value;
}

export function endReasonLabel(reason) {
  const key = 'endReason.' + reason;
  const value = t(key);
  return value === key ? String(reason || '-') : value;
}

export function tiebreakLabel(tiebreak) {
  const key = 'tiebreak.' + tiebreak;
  const value = t(key);
  return value === key ? String(tiebreak || '-') : value;
}

export function difficultyLabel(difficulty) {
  const key = 'difficulty.' + difficulty;
  const value = t(key);
  return value === key ? String(difficulty || '-') : value;
}

export function kindLabel(kind) {
  const key = 'kind.' + kind;
  const value = t(key);
  return value === key ? String(kind || '-') : value;
}

export function winnerText(result, players) {
  if (!result) return '';
  const seats = result.winnerSeats || [];
  const names = seats.map((seat) => {
    const player = players && players[seat];
    return player ? player.name : t('game.seatN', { n: seat + 1 });
  });
  if (names.length === 0) return t('game.noWinner');
  if (result.tiebreak === 'shared' || seats.length > 1) {
    return t('game.sharedWin', { names: names.join(t('common.listSeparator')) });
  }
  return t('game.winBanner', { name: names[0] });
}

export function shortId(id) {
  if (!id) return '';
  return id.length > 10 ? id.slice(0, 10) : id;
}

export function actionNotation(action) {
  if (!action) return '';
  // Connect6 has one action type: a single stone. Notation is just the point.
  const points = Array.isArray(action.points) ? action.points : null;
  if (points && points.length > 0) {
    return points.map((point) => cellName(point.x, point.y)).join(' ');
  }
  if (typeof action.x === 'number' && typeof action.y === 'number') {
    return cellName(action.x, action.y);
  }
  return '';
}

export function historyNotation(entry) {
  if (!entry) return '';
  if (entry.notation) return entry.notation;
  return actionNotation(entry);
}

export async function copyText(value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (error) {
    // fall through to legacy path
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch (error) {
    return false;
  }
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function scoreRows(game) {
  const state = game && game.state;
  const result = game && game.result;
  if (!state) return [];
  return state.players.map((player, seat) => {
    const stones = result && result.stoneCounts
      ? result.stoneCounts[seat]
      : (Number.isInteger(player.stones) ? player.stones : 0);
    return {
      seat,
      name: player.name,
      color: player.color,
      stones,
      score: stones
    };
  });
}
