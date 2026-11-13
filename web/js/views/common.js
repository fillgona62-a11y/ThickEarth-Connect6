/**
 * Shared view helpers: seat presentation, badges, result summaries and small
 * persistence helpers.
 */
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { badge } from '../core/ui.js';
import {
  seatLetter,
  seatColor,
  modeLabel,
  statusLabel,
  winnerText,
  formatDate,
  formatDuration
} from '../core/format.js';

const MODE_TONES = { local: 'amber', ai: 'violet', selfplay: 'muted', arena: 'jade', online: 'jade' };
const STATUS_TONES = { lobby: 'warn', play: 'jade', finished: 'muted' };

export function letterDot(seat, player) {
  const color = (player && player.color) || seatColor(seat);
  return h('span', {
    class: 'player-row-letter player-row-letter--' + color,
    'aria-hidden': 'true'
  }, seatLetter(seat));
}

export function seatDot(seat, player) {
  const color = (player && player.color) || seatColor(seat);
  return h('span', { class: 'seat-badge seat-badge--' + color },
    h('span', { class: 'seat-badge-letter', 'aria-hidden': 'true' }, seatLetter(seat)),
    h('span', { class: 'seat-badge-name' }, player && player.name ? player.name : t('game.seatN', { n: seat + 1 }))
  );
}

export function playersInline(players, options) {
  const opts = options || {};
  if (!players || !players.length) return h('span', { class: 'muted' }, '-');
  const list = opts.limit ? players.slice(0, opts.limit) : players;
  return h('span', { class: 'recent-players' },
    list.map((player) => seatDot(player.seat, player))
  );
}

export function modeBadge(mode) {
  return badge(modeLabel(mode), MODE_TONES[mode] || 'muted');
}

export function statusBadge(status) {
  const tone = STATUS_TONES[status] || 'muted';
  return h('span', { class: 'badge badge--' + tone },
    status === 'play' ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null,
    statusLabel(status)
  );
}

export function resultChips(game) {
  if (!game || !game.result || !game.result.scores) return null;
  const players = game.players || [];
  const winners = game.result.winnerSeats || [];
  return h('span', { class: 'recent-score' },
    game.result.scores.map((score, seat) => {
      const player = players[seat] || { seat: seat };
      const color = player.color || seatColor(seat);
      const isWinner = winners.indexOf(seat) !== -1;
      return h('span', {
        class: 'score-chip score-chip--' + color + (isWinner ? ' is-winner' : ''),
        title: (player.name || t('game.seatN', { n: seat + 1 })) + ' · ' + score
      },
        h('span', { 'aria-hidden': 'true' }, seatLetter(seat)),
        h('span', null, String(score))
      );
    })
  );
}

export function winnerLabel(game) {
  if (!game || !game.result) return t('history.noResult');
  return winnerText(game.result, game.players || []);
}

export function gamePath(game) {
  if (!game) return '/';
  if (game.status === 'lobby') return '/online/' + encodeURIComponent(game.id);
  return '/game/' + encodeURIComponent(game.id);
}

export function isLobbyGame(game) {
  return Boolean(game && game.status === 'lobby');
}

export function lobbySeatFilled(player) {
  if (!player) return false;
  if (player.userId) return true;
  if (player.isViewer) return true;
  if (player.kind === 'ai') return true;
  return false;
}

export function filledSeatCount(players) {
  return (players || []).filter(lobbySeatFilled).length;
}

export function gameFinishMeta(game) {
  if (!game) return '';
  if (game.result && game.result.endReason) {
    const keys = {
      six_in_a_row: 'endReason.six_in_a_row',
      board_full: 'endReason.board_full'
    };
    return t(keys[game.result.endReason] || 'endReason.unknown');
  }
  if (game.status === 'finished' && game.finishedAt) return formatDate(game.finishedAt);
  return '';
}

export function durationText(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return '';
  return formatDuration(finishedAt - startedAt);
}

export function emptyBoardImage(className) {
  return h('img', {
    src: 'assets/empty-board.svg',
    alt: '',
    width: 160,
    height: 160,
    class: className || 'empty-board-img'
  });
}

/* Auth-required state ------------------------------------------------------ */

export function isAuthError(error) {
  if (!error) return false;
  if (error.status === 401 || error.status === 403) return true;
  return Boolean(error.code && String(error.code).toUpperCase().indexOf('UNAUTH') !== -1);
}

export function authRequiredState(description) {
  const back = window.location.hash && window.location.hash !== '#/login' ? window.location.hash : '#/';
  return h('div', { class: 'state-block state-block--empty' },
    h('div', { class: 'state-icon', 'aria-hidden': 'true' }, icon('lock', 26)),
    h('p', { class: 'state-title' }, t('online.needLogin')),
    h('p', { class: 'state-desc' }, description || t('online.needLoginDesc')),
    h('div', { class: 'state-action row' },
      h('a', { class: 'btn btn--primary btn--sm', href: '#/login?next=' + encodeURIComponent(back) }, icon('lock', 14), t('auth.loginTitle')),
      h('a', { class: 'btn btn--ghost btn--sm', href: '#/register' }, t('auth.registerTitle'))
    )
  );
}

/* Persistence helpers ------------------------------------------------------ */

export function readStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

export function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // storage is best effort
  }
}

export function clearStorage(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    // ignore
  }
}

/* Metric helpers ----------------------------------------------------------- */

export function pickPath(source, path) {
  if (!source) return undefined;
  const parts = path.split('.');
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

export function firstNumber(source, paths) {
  for (const path of paths) {
    const value = pickPath(source, path);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

export function firstValue(source, paths) {
  for (const path of paths) {
    const value = pickPath(source, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export function humanKey(key) {
  if (!key) return '';
  const spaced = String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function iconLabel(name, text) {
  return h('span', { class: 'icon-text' },
    h('span', { class: 'icon-text-icon', 'aria-hidden': 'true' }, icon(name, 15)),
    h('span', null, text)
  );
}

export function listOfStrings(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        return item.text || item.summary || item.description || item.title || item.note || JSON.stringify(item);
      }
      return String(item);
    }).filter(Boolean);
  }
  if (typeof value === 'string') return value.split(/\n+/).filter(Boolean);
  return [String(value)];
}
