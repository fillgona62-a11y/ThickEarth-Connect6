/**
 * Online room lobby: room code, seats, host start, live updates via SSE with a
 * polling fallback.
 */
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { getSession } from '../core/store.js';
import { api } from '../core/api.js';
import {
  pageHeader,
  sectionCard,
  describeError,
  errorState,
  loadingBlock,
  toast,
  confirmDialog
} from '../core/ui.js';
import { navigate } from '../core/router.js';
import { copyText, seatLetter, seatColor } from '../core/format.js';
import { statusBadge, modeBadge, lobbySeatFilled, filledSeatCount, isAuthError, authRequiredState } from './common.js';

function roomInviteText(game) {
  const base = window.location.origin + window.location.pathname;
  return t('online.inviteTemplate', {
    name: t('app.name'),
    code: game.roomCode || '',
    url: base + '#/online/' + encodeURIComponent(game.id)
  });
}

export async function mount(container, route) {
  const id = route && route.params ? route.params.id : '';
  let game = null;
  let disposed = false;
  let startBusy = false;
  let leaveBusy = false;
  let loadError = null;
  let events = null;
  let pollTimer = null;
  let liveMode = 'idle';
  let liveLost = false;
  let renderQueued = false;

  function cleanupLive() {
    if (events) {
      try { events.close(); } catch (error) { /* ignore */ }
      events = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    liveMode = 'idle';
  }

  function goToGame(nextGame) {
    navigate('/game/' + encodeURIComponent(nextGame.id), { replace: true });
  }

  function applyGame(nextGame) {
    if (disposed || !nextGame) return;
    if (game && nextGame.seq !== undefined && game.seq === nextGame.seq && nextGame.status === game.status) {
      // still re-render seat changes in lobby
    }
    game = nextGame;
    if (game.status && game.status !== 'lobby') {
      cleanupLive();
      goToGame(game);
      return;
    }
    scheduleRender();
  }

  function scheduleRender() {
    if (renderQueued || disposed) return;
    renderQueued = true;
    Promise.resolve().then(() => {
      renderQueued = false;
      if (!disposed) renderLobby();
    });
  }

  function startPolling() {
    if (pollTimer || disposed) return;
    liveMode = 'poll';
    pollTimer = setInterval(async () => {
      try {
        const response = await api.getGame(id);
        if (response && response.game) applyGame(response.game);
      } catch (error) {
        if (error && (error.status === 401 || error.status === 403 || error.status === 404)) {
          cleanupLive();
          loadError = error;
          scheduleRender();
        }
      }
    }, 2400);
  }

  function startLive() {
    if (disposed || typeof window.EventSource !== 'function') {
      startPolling();
      return;
    }
    try {
      events = new EventSource(api.eventsUrl(id));
      liveMode = 'sse';
      events.addEventListener('state', (event) => {
        try {
          const payload = JSON.parse(event.data);
          applyGame(payload);
        } catch (error) {
          // ignore malformed event
        }
      });
      events.addEventListener('open', () => {
        liveLost = false;
      });
      events.onerror = () => {
        if (disposed) return;
        cleanupLive();
        liveLost = true;
        startPolling();
        scheduleRender();
      };
    } catch (error) {
      startPolling();
    }
  }

  async function startGame() {
    if (!game || startBusy) return;
    startBusy = true;
    renderLobby();
    try {
      const response = await api.startGame(game.id);
      if (response && response.game) {
        cleanupLive();
        goToGame(response.game);
      }
    } catch (error) {
      startBusy = false;
      toast(t('online.createError') + ' · ' + describeError(error), { type: 'error' });
      renderLobby();
    }
  }

  async function leaveRoom() {
    if (leaveBusy) return;
    if (game && game.viewer && game.viewer.isHost) {
      const confirmed = await confirmDialog({
        title: t('online.leave'),
        description: t('online.leaveHint'),
        confirmLabel: t('online.leave'),
        danger: true
      });
      if (!confirmed) return;
    }
    navigate('/online');
  }

  async function copyInvite() {
    if (!game) return;
    const ok = await copyText(roomInviteText(game));
    toast(ok ? t('common.copied') : t('common.copyFailed'), { type: ok ? 'success' : 'error' });
  }

  function renderSeat(player) {
    const isFilled = lobbySeatFilled(player);
    const isYou = Boolean(player.isViewer);
    const color = player.color || seatColor(player.seat);
    if (!isFilled) {
      return h('div', { class: 'lobby-seat is-empty' },
        h('span', { class: 'lobby-seat-letter', 'aria-hidden': 'true' }, seatLetter(player.seat)),
        h('div', { class: 'lobby-seat-body' },
          h('div', { class: 'lobby-seat-name' }, t('online.emptySeat')),
          h('div', { class: 'lobby-seat-meta' }, t('common.waiting'))
        )
      );
    }
    return h('div', { class: 'lobby-seat' + (isYou ? ' is-you' : '') },
      h('span', { class: 'lobby-seat-letter ' + 'lobby-seat-letter--' + color, 'aria-hidden': 'true' }, seatLetter(player.seat)),
      h('div', { class: 'lobby-seat-body' },
        h('div', { class: 'lobby-seat-name' }, player.name || t('game.seatN', { n: player.seat + 1 })),
        h('div', { class: 'lobby-seat-meta' },
          player.seat === 0 ? t('online.hostBadge') : t('kind.' + (player.kind || 'human')),
          isYou ? ' · ' + t('online.you') : ''
        )
      ),
      h('span', { class: 'badge badge--ok' }, icon('check', 12), t('common.ready'))
    );
  }

  function renderLobby() {
    clear(container);
    if (loadError) {
      container.appendChild(isAuthError(loadError)
        ? authRequiredState(t('online.needLoginDesc'))
        : errorState({
            title: t('online.lobbyError'),
            error: loadError,
            onRetry: () => window.location.reload()
          }));
      return;
    }
    if (!game) {
      container.appendChild(loadingBlock(t('online.entering')));
      return;
    }
    const viewers = game.viewer || {};
    const players = (game.players || []).slice().sort((a, b) => a.seat - b.seat);
    const total = game.playerCount || players.length || 0;
    const filled = filledSeatCount(players);
    const isHost = Boolean(viewers.isHost);
    const canStart = isHost && filled === total && !startBusy;

    container.appendChild(pageHeader({
      eyebrow: t('online.eyebrow'),
      title: t('online.lobbyTitle'),
      subtitle: t('online.subtitle'),
      onBack: () => navigate('/online'),
      backLabel: t('online.leave')
    }));
    container.appendChild(h('div', { class: 'game-topbar' },
      modeBadge(game.mode),
      statusBadge(game.status),
      h('span', { class: 'chip mono' }, '#' + (game.roomCode || '----')),
      h('div', { class: 'game-topbar-meta' },
        h('span', { class: 'lobby-status' },
          h('span', { class: 'dot', style: { width: '5px', height: '5px', borderRadius: '50%', background: liveMode === 'sse' ? 'var(--jade)' : 'var(--amber)' } }),
          liveMode === 'sse' ? t('common.live').toUpperCase() : liveMode === 'poll' ? t('common.polling').toUpperCase() : t('common.waiting')
        )
      )
    ));

    const codeCard = h('div', { class: 'card room-code-card' },
      h('p', { class: 'room-code-label' }, t('online.roomCode')),
      h('p', { class: 'room-code-value', 'aria-live': 'polite' }, game.roomCode || '----'),
      h('p', { class: 'room-code-hint' }, t('online.shareHint')),
      h('div', { class: 'room-code-actions' },
        h('button', { type: 'button', class: 'btn btn--primary', onclick: copyInvite },
          icon('copy', 16), t('online.copyCode')),
        h('button', { type: 'button', class: 'btn btn--ghost', onclick: leaveRoom },
          icon('arrowLeft', 15), t('online.leave'))
      )
    );

    const seatsCard = sectionCard({
      title: t('online.seatList'),
      description: t('online.filledSeats', { filled: filled, total: total }),
      content: h('div', { class: 'stack-16' },
        h('div', { class: 'lobby-seats' }, players.map((player) => renderSeat(player))),
        h('div', { class: 'lobby-progress' },
          h('div', { class: 'progress' },
            h('span', { class: 'progress-fill', style: { width: Math.round((filled / Math.max(1, total)) * 100) + '%' } })
          ),
          h('span', { class: 'faint mono', style: { fontSize: '10px' } }, t('online.filledSeats', { filled: filled, total: total }))
        )
      )
    });

    const statusCard = sectionCard({
      title: t('online.waitingStart'),
      content: h('div', { class: 'stack-16' },
        h('div', { class: 'lobby-status' },
          h('span', { class: 'turn-pulse', 'aria-hidden': 'true' }),
          isHost
            ? (filled === total ? t('online.startGame') : t('online.waitingPlayers'))
            : t('online.waitingHost')
        ),
        liveLost ? h('div', { class: 'notice notice--warn' }, icon('alert', 15), h('span', null, t('game.syncLost'))) : null,
        h('div', { class: 'lobby-actions' },
          isHost
            ? h('button', {
                type: 'button',
                class: 'btn btn--primary btn--block',
                onclick: startGame,
                disabled: canStart ? null : ''
              },
                startBusy ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('play', 16),
                startBusy ? t('online.starting') : t('online.startGame')
              )
            : null,
          !isHost ? h('p', { class: 'mode-hint', style: { marginTop: 0 } }, t('online.hostOnly')) : null
        ),
        h('p', { class: 'mode-hint' }, t('online.leaveHint'))
      )
    });

    container.appendChild(h('div', { class: 'lobby-layout' },
      h('div', { class: 'stack-20' }, codeCard, seatsCard),
      h('aside', { class: 'stack-16' }, statusCard, h('div', { class: 'card' },
        h('div', { class: 'card-body' },
          h('div', { class: 'kv-list' },
            h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('common.mode')), h('span', { class: 'kv-value' }, t('mode.online'))),
            h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('online.playerCount')), h('span', { class: 'kv-value' }, String(total))),
            h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('common.host')), h('span', { class: 'kv-value' }, isHost ? t('online.you') : (players[0] && players[0].name) || '-')),
            h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('online.role')), h('span', { class: 'kv-value' }, viewers.control === 'spectator' ? t('game.spectator') : t('online.you')))
          )
        )
      ))
    ));
  }

  async function load() {
    try {
      const response = await api.getGame(id);
      if (disposed) return;
      if (!response || !response.game) throw new Error('Missing game');
      game = response.game;
      if (game.status && game.status !== 'lobby') {
        goToGame(game);
        return;
      }
      renderLobby();
      startLive();
    } catch (error) {
      if (disposed) return;
      loadError = error;
      renderLobby();
    }
  }

  clear(container);
  container.appendChild(loadingBlock(t('online.entering')));
  load();

  return function cleanup() {
    disposed = true;
    cleanupLive();
  };
}