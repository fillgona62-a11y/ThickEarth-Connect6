/**
 * Game view: board, turn state, move log, live sync for online games, result
 * panel, notes, agent-seat tokens and post-game analysis.
 */
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t, getLang } from '../core/i18n.js';
import { getSession } from '../core/store.js';
import { api, saveBlob } from '../core/api.js';
import {
  describeError,
  errorState,
  loadingBlock,
  openDialog,
  toast,
  iconText,
  setLiveMessage
} from '../core/ui.js';
import { navigate } from '../core/router.js';
import {
  formatDuration,
  endReasonLabel,
  seatLetter,
  seatColor,
  cellName,
  formatDate,
  scoreRows
} from '../core/format.js';
import { Board, boardModelFromGame } from '../game/board.js';
import {
  modeBadge,
  statusBadge,
  winnerLabel,
  gameFinishMeta,
  humanKey,
  listOfStrings
} from './common.js';

function playerColor(player) {
  return (player && player.color) || seatColor(player ? player.seat : 0);
}

function historyEntryLabel(entry) {
  if (!entry) return '';
  if (Array.isArray(entry.points) && entry.points.length > 0) {
    return entry.points.map((point) => cellName(point.x, point.y)).join(' ');
  }
  if (typeof entry.x === 'number' && typeof entry.y === 'number') {
    return cellName(entry.x, entry.y);
  }
  return entry.notation || '';
}

function liveClass(mode) {
  return mode === 'sse' ? 'is-live' : mode === 'poll' ? 'is-poll' : '';
}

export async function mount(container, route) {
  const id = route && route.params ? route.params.id : '';
  const uiState = {
    game: null,
    loadError: null,
    loading: true,
    pending: false,
    lastActionError: '',
    liveMode: 'idle',
    liveLost: false,
    noteSaving: false,
    noteSaved: false,
    noteError: '',
    analysisState: 'idle',
    analysis: null,
    analysisError: '',
    analysisBusy: false,
    agentTokens: {},
    agentTokenBusy: -1,
    agentTokenError: '',
    coach: {
      loading: false,
      loaded: false,
      error: '',
      report: null,
      messages: [],
      config: null,
      generating: false,
      sending: false,
      chatError: '',
      chatDraft: '',
      chatUsage: null,
      cached: false
    }
  };
  let disposed = false;
  let boardRef = null;
  let events = null;
  let pollTimer = null;
  let lastLogLength = 0;

  function canViewerAct() {
    const game = uiState.game;
    if (!game || game.status === 'finished') return false;
    return Boolean(game.viewer && game.viewer.canAct);
  }

  function legalGroups() {
    const game = uiState.game;
    const actions = (game && game.legalActions) || [];
    return {
      placements: actions.filter((action) => action.type === 'place')
    };
  }

  /** Stones the seat on the clock still owes this turn (1 on the opening turn). */
  function stonesLeft() {
    const game = uiState.game;
    const state = game && game.state;
    if (!state || game.status === 'finished') return 0;
    const perTurn = state.options && state.options.stonesPerTurn ? state.options.stonesPerTurn : 2;
    const firstTurn = state.options && state.options.firstTurnStones ? state.options.firstTurnStones : 1;
    const owed = (state.turn || 1) <= 1 ? firstTurn : perTurn;
    return Math.max(0, owed - (state.placedThisTurn || 0));
  }

  /** Stones a seat has on the board; falls back to the result snapshot. */
  function stonesForSeat(seat) {
    const player = statePlayers()[seat];
    if (player && Number.isInteger(player.stones)) return player.stones;
    const result = gameResult();
    const counts = result && result.stoneCounts;
    return counts && Number.isInteger(counts[seat]) ? counts[seat] : 0;
  }

  /** Decisions a seat has made so far, counted from the action log. */
  function decisionsForSeat(seat) {
    const game = uiState.game;
    const history = (game && game.state && game.state.history) || [];
    return history.filter((entry) => entry.seat === seat).length;
  }

  function statePlayers() {
    const game = uiState.game;
    return (game && game.state && game.state.players) || (game && game.players) || [];
  }

  function currentPlayer() {
    const game = uiState.game;
    if (!game || !game.state) return null;
    const seat = game.state.currentSeat;
    if (seat === null || seat === undefined) return null;
    return statePlayers()[seat] || null;
  }

  function gameResult() {
    const game = uiState.game;
    if (!game) return null;
    return game.result || (game.state && game.state.result) || null;
  }

  /* Live updates ---------------------------------------------------------- */

  function cleanupLive() {
    if (events) {
      try { events.close(); } catch (error) { /* ignore */ }
      events = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    uiState.liveMode = 'idle';
  }

  function startPolling() {
    if (pollTimer || disposed) return;
    uiState.liveMode = 'poll';
    pollTimer = setInterval(async () => {
      try {
        const response = await api.getGame(id);
        if (response && response.game) applyRemote(response.game);
      } catch (error) {
        // keep polling silently
      }
    }, 3000);
  }

  function startLive() {
    const game = uiState.game;
    if (!game || game.mode !== 'online' || game.status === 'finished' || disposed) return;
    if (typeof window.EventSource !== 'function') {
      startPolling();
      return;
    }
    try {
      events = new EventSource(api.eventsUrl(id));
      uiState.liveMode = 'sse';
      events.addEventListener('state', (event) => {
        try {
          const payload = JSON.parse(event.data);
          applyRemote(payload);
        } catch (error) {
          // ignore malformed event
        }
      });
      events.addEventListener('open', () => {
        if (uiState.liveLost) {
          uiState.liveLost = false;
          render();
        }
      });
      events.onerror = () => {
        if (disposed || uiState.game && uiState.game.status === 'finished') return;
        cleanupLive();
        uiState.liveLost = true;
        startPolling();
        render();
      };
    } catch (error) {
      startPolling();
    }
  }

  function applyRemote(nextGame) {
    if (!nextGame || disposed) return;
    const current = uiState.game;
    if (current && current.state && nextGame.state) {
      const currentSeq = current.state.seq || 0;
      const nextSeq = nextGame.state.seq || 0;
      if (nextSeq < currentSeq) return;
      if (nextSeq === currentSeq && nextGame.status === current.status) return;
    }
    uiState.game = nextGame;
    if (nextGame.status === 'finished') {
      cleanupLive();
      loadAnalysis();
      loadCoach();
    }
    render();
  }

  /* Actions --------------------------------------------------------------- */

  function submitAction(action) {
    if (uiState.pending || disposed) return;
    const focused = boardRef && boardRef.grid.contains(document.activeElement);
    uiState.pending = true;
    uiState.lastActionError = '';
    render();
    api.submitAction(id, action)
      .then((response) => {
        if (disposed) return;
        if (!response || !response.game) throw new Error('Missing game');
        uiState.game = response.game;
        uiState.pending = false;
        if (uiState.game.status === 'finished') {
          cleanupLive();
          loadAnalysis();
        }
        render();
        if (focused && boardRef) boardRef.focusBoard();
        announceLastMove();
      })
      .catch((error) => {
        if (disposed) return;
        uiState.pending = false;
        uiState.lastActionError = describeError(error);
        render();
        toast(uiState.lastActionError, { type: 'error' });
        if (focused && boardRef) boardRef.focusBoard();
      });
  }

  function announceLastMove() {
    const game = uiState.game;
    if (!game || !game.state) return;
    const history = game.state.history || [];
    const entry = history[history.length - 1];
    if (!entry) return;
    const player = statePlayers()[entry.seat];
    setLiveMessage((player ? player.name + ' ' : '') + historyEntryLabel(entry));
  }

  async function exportGame() {
    const format = await openDialog({
      title: t('game.export'),
      description: t('playtest.subtitle'),
      actions: [
        { label: t('common.cancel'), value: null, kind: 'ghost' },
        { label: 'JSON', value: 'json', kind: 'secondary' },
        { label: 'Markdown', value: 'md', kind: 'secondary' },
        { label: 'TXT', value: 'txt', kind: 'primary' }
      ]
    });
    if (!format) return;
    try {
      const file = await api.download(api.exportUrl(id, format));
      saveBlob(file.blob, file.filename);
      toast(t('common.copied'), { type: 'success', timeout: 1600 });
    } catch (error) {
      toast(describeError(error), { type: 'error' });
    }
  }

  async function saveNote(note) {
    if (uiState.noteSaving) return;
    if (note.length > 280) {
      toast(t('game.noteTooLong'), { type: 'error' });
      return;
    }
    uiState.noteSaving = true;
    uiState.noteError = '';
    try {
      const response = await api.hardestDecision(id, note);
      if (response && response.metrics && uiState.game) {
        uiState.game = Object.assign({}, uiState.game, { metrics: response.metrics });
      }
      uiState.noteSaved = true;
      uiState.noteSaving = false;
      toast(t('game.noteSaved'), { type: 'success' });
      render();
    } catch (error) {
      uiState.noteSaving = false;
      uiState.noteError = describeError(error);
      render();
    }
  }

  async function loadAnalysis() {
    if (uiState.analysisState === 'loading' || uiState.analysisBusy) return;
    const game = uiState.game;
    if (!game || game.status !== 'finished') return;
    uiState.analysisState = 'loading';
    render();
    try {
      const response = await api.getAnalysis(id);
      if (disposed) return;
      if (response && response.analysis) {
        uiState.analysis = response.analysis;
        uiState.analysisState = 'ready';
      } else {
        uiState.analysis = null;
        uiState.analysisState = 'idle';
      }
    } catch (error) {
      uiState.analysisState = 'error';
      uiState.analysisError = describeError(error);
    }
    render();
  }

  async function generateAnalysis() {
    if (uiState.analysisBusy) return;
    uiState.analysisBusy = true;
    uiState.analysisError = '';
    render();
    try {
      const response = await api.generateAnalysis(id);
      if (disposed) return;
      uiState.analysis = response && response.analysis ? response.analysis : null;
      uiState.analysisState = uiState.analysis ? 'ready' : 'idle';
    } catch (error) {
      uiState.analysisError = describeError(error);
      uiState.analysisState = 'error';
    }
    uiState.analysisBusy = false;
    render();
  }

  function refreshGame() {
    api.getGame(id)
      .then((response) => {
        if (disposed) return;
        if (response && response.game) {
          uiState.game = response.game;
          if (uiState.game.status === 'finished') cleanupLive();
          render();
        }
      })
      .catch((error) => toast(describeError(error), { type: 'error' }));
  }

  /* Rendering ------------------------------------------------------------- */

  function buildTopbar() {
    const game = uiState.game;
    const players = game.players || [];
    return h('div', { class: 'game-topbar' },
      h('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: () => navigate('/history')
      }, icon('arrowLeft', 15), t('game.backHistory')),
      h('div', { class: 'game-title' },
        h('h1', null, t('app.name') + ' · ' + t('title.game')),
        h('span', { class: 'game-title-sub' }, (game.id || '').slice(0, 14) + (players.length ? ' · ' + t('history.playersCount', { n: game.playerCount || players.length }) : ''))
      ),
      h('div', { class: 'game-topbar-meta' },
        modeBadge(game.mode),
        statusBadge(game.status),
        game.roomCode ? h('span', { class: 'chip mono' }, '#' + game.roomCode) : null,
        game.mode === 'online'
          ? h('span', { class: 'lobby-status' },
              h('span', { class: 'dot', style: { width: '5px', height: '5px', borderRadius: '50%', background: uiState.liveMode === 'sse' ? 'var(--jade)' : 'var(--amber)' } }),
              uiState.liveMode === 'sse' ? t('common.live').toUpperCase() : uiState.liveLost ? t('game.syncLost') : t('common.waiting')
            )
          : null,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('common.refresh'), title: t('common.refresh'), onclick: refreshGame }, icon('refresh', 16)),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('game.export'), title: t('game.export'), onclick: exportGame }, icon('download', 16))
      )
    );
  }

  function buildTurnBanner() {
    const game = uiState.game;
    if (game.status === 'finished') {
      return h('div', { class: 'turn-banner is-waiting' },
        h('span', { class: 'turn-banner-name' }, t('game.resultTitle')),
        h('span', { class: 'turn-banner-sub' }, winnerLabel(game) || t('game.noWinner'))
      );
    }
    const player = currentPlayer();
    const canAct = canViewerAct();
    const isAi = player && player.kind === 'ai';
    const isAgent = player && player.kind === 'agent';
    const name = player ? player.name : '-';
    const left = stonesLeft();
    let sub;
    if (canAct) sub = t('game.yourTurn');
    else if (isAi) sub = engineForSeat(player.seat) === 'llm' ? t('game.llmTurn') : t('game.aiTurn');
    else if (isAgent) sub = t('game.agentTurn');
    else sub = t('game.waitingTurn', { name: name });
    return h('div', { class: 'turn-banner' + (canAct ? '' : ' is-waiting') },
      h('span', { class: 'turn-pulse', 'aria-hidden': 'true' }),
      h('span', { class: 'turn-banner-letter turn-banner-letter--' + playerColor(player), 'aria-hidden': 'true' }, seatLetter(player ? player.seat : 0)),
      h('div', { class: 'turn-banner-body' },
        h('div', { class: 'turn-banner-name' }, name),
        h('div', { class: 'turn-banner-sub' }, sub)
      ),
      h('div', { class: 'turn-banner-chips' },
        left > 0 ? h('span', { class: 'chip chip--stones' }, left === 1 ? t('game.stonesLeftOne') : t('game.stonesLeft', { n: left })) : null,
        h('span', { class: 'chip mono' }, t('game.turnCount', { n: game.state.turn || 0 }))
      )
    );
  }

  function buildPlayersPanel() {
    const players = statePlayers();
    const game = uiState.game;
    const currentSeat = game.state ? game.state.currentSeat : null;
    return h('div', { class: 'game-panel' },
      h('div', { class: 'game-panel-head' },
        h('span', { class: 'game-panel-title' }, icon('users', 13), t('common.players')),
        h('span', { class: 'faint mono', style: { fontSize: '9.5px' } }, String(players.length))
      ),
      h('div', { class: 'game-panel-body' },
        h('div', { class: 'player-list' },
          players.map((player) => {
            const color = playerColor(player);
            const isCurrent = player.seat === currentSeat && game.status !== 'finished';
            const isViewerSeat = game.viewer && game.viewer.seat === player.seat;
            const meta = [];
            meta.push(t('kind.' + (player.kind || 'human')));
            if (player.kind === 'ai') {
              const engine = engineForSeat(player.seat);
              if (engine) meta.push(t(engine === 'llm' ? 'engine.llmShort' : 'engine.localShort'));
            }
            if (player.kind === 'agent' && player.fallbackCount) {
              meta.push(t('game.agentFallback', { n: player.fallbackCount }));
            }
            const stones = stonesForSeat(player.seat);
            if (isCurrent && stonesLeft() > 0) meta.push(t('game.stonesLeft', { n: stonesLeft() }));
            return h('div', { class: 'player-row' + (isCurrent ? ' is-current' : '') },
              h('span', { class: 'player-row-letter player-row-letter--' + color, 'aria-hidden': 'true' }, seatLetter(player.seat)),
              h('div', { class: 'player-row-body' },
                h('div', { class: 'player-row-name' },
                  player.name || t('game.seatN', { n: player.seat + 1 }),
                  isViewerSeat ? h('span', { class: 'faint', style: { fontWeight: '400', fontSize: '10px', marginLeft: '6px' } }, '· ' + t('online.you')) : null
                ),
                h('div', { class: 'player-row-meta' }, meta.join(' · '))
              ),
              h('span', { class: 'player-hand', title: t('game.colStones') },
                h('span', { class: 'player-hand-label' }, t('game.colStones')),
                String(stones)
              )
            );
          })
        )
      )
    );
  }

  function buildMetaPanel() {
    const game = uiState.game;
    const viewers = game.viewer || {};
    const control = viewers.control || 'local';
    const controlLabel = control === 'spectator'
      ? t('game.controlSpectator')
      : control === 'local' ? t('game.controlLocal') : t('game.controlSeat');
    return h('div', { class: 'game-panel' },
      h('div', { class: 'game-panel-body' },
        h('div', { class: 'kv-list' },
          h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('common.mode')), h('span', { class: 'kv-value' }, t('mode.' + game.mode))),
          h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('game.viewerControl')), h('span', { class: 'kv-value' }, controlLabel)),
          h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('common.date')), h('span', { class: 'kv-value' }, formatDate(game.startedAt || game.createdAt)))
        )
      )
    );
  }

  function agentSeats() {
    const players = (uiState.game && uiState.game.players) || [];
    return players.filter((player) => player.kind === 'agent');
  }

  function agentTimeLabel(player) {
    if (!Number.isInteger(player.timeLimitMs)) return '';
    if (player.timeLimitMs <= 0) return t('game.agentNoLimit');
    return t('game.agentTimeLimit', { s: Math.round(player.timeLimitMs / 1000) });
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('common.copied'), { type: 'success', timeout: 1600 });
    } catch (error) {
      toast(describeError(error), { type: 'error' });
    }
  }

  async function mintAgentToken(seat) {
    if (uiState.agentTokenBusy >= 0) return;
    uiState.agentTokenBusy = seat;
    uiState.agentTokenError = '';
    render();
    try {
      const response = await api.mintAgentSeatToken(id, seat);
      const token = response && typeof response.token === 'string' ? response.token : '';
      if (!token) throw new Error(t('game.agentTokenError'));
      uiState.agentTokens[seat] = token;
    } catch (error) {
      uiState.agentTokenError = describeError(error);
    } finally {
      uiState.agentTokenBusy = -1;
      render();
    }
  }

  /**
   * Agent seats are playable by an external process, so the useful thing to show
   * here is the credential: mint it, show it once, and hand over the command that
   * uses it.
   */
  function buildAgentPanel() {
    const seats = agentSeats();
    if (seats.length === 0) return null;
    const rows = seats.map((player) => {
      const token = uiState.agentTokens[player.seat];
      const busy = uiState.agentTokenBusy === player.seat;
      const meta = [agentTimeLabel(player)];
      if (player.fallbackCount) meta.push(t('game.agentFallback', { n: player.fallbackCount }));
      return h('div', { style: { marginBottom: '10px' } },
        h('div', { class: 'kv-row' },
          h('span', { class: 'kv-key' }, seatLetter(player.seat) + ' · ' + player.name),
          h('span', { class: 'kv-value faint' }, meta.filter(Boolean).join(' · '))
        ),
        token
          ? h('div', { style: { marginTop: '6px' } },
              h('input', {
                class: 'input mono',
                type: 'text',
                readonly: '',
                value: token,
                style: { fontSize: '10px' },
                onfocus: (event) => event.target.select()
              }),
              h('div', { style: { display: 'flex', gap: '6px', marginTop: '5px' } },
                h('button', {
                  class: 'btn btn--secondary btn--sm',
                  type: 'button',
                  onclick: () => copyToClipboard(token)
                }, t('game.agentCopy'))
              ),
              h('div', { class: 'faint mono', style: { fontSize: '9.5px', marginTop: '5px', wordBreak: 'break-all' } },
                t('game.agentRunHint') + ' node agents/example-client.mjs ' + window.location.origin
              )
            )
          : h('div', { style: { marginTop: '6px' } },
              h('button', {
                class: 'btn btn--primary btn--sm',
                type: 'button',
                disabled: busy ? '' : null,
                onclick: () => mintAgentToken(player.seat)
              }, busy ? t('game.agentMinting') : t('game.agentMint'))
            )
      );
    });
    return h('div', { class: 'game-panel' },
      h('div', { class: 'game-panel-head' },
        h('span', { class: 'game-panel-title' }, icon('cpu', 13), t('game.agentPanelTitle'))
      ),
      h('div', { class: 'game-panel-body' },
        h('div', { class: 'faint', style: { fontSize: '10.5px', lineHeight: '1.5', marginBottom: '8px' } }, t('game.agentPanelHint')),
        rows,
        uiState.agentTokenError
          ? h('div', { class: 'text-danger', style: { fontSize: '10px' } }, uiState.agentTokenError)
          : null
      )
    );
  }

  function buildBoardColumn() {
    const game = uiState.game;
    const result = gameResult();
    const groups = legalGroups();
    const canAct = canViewerAct();
    const placements = groups.placements;
    const boardLegal = canAct && !uiState.pending ? placements : [];
    const interactive = boardLegal.length > 0;

    const model = boardModelFromGame(game, {
      interactive: interactive,
      legalActions: boardLegal,
      pending: uiState.pending,
      winLine: result && Array.isArray(result.line) ? result.line : null
    });

    const phaseText = game.status === 'finished' ? t('status.finished') : t('status.play');
    const lastEntry = game.state.history && game.state.history.length
      ? game.state.history[game.state.history.length - 1]
      : null;
    const left = stonesLeft();

    const toolbar = h('div', { class: 'board-toolbar' },
      h('div', { class: 'board-toolbar-left' },
        h('span', { class: 'game-phase' }, h('strong', null, phaseText), '·', t('game.turnCount', { n: game.state.turn || 0 })),
        lastEntry
          ? h('span', { class: 'last-move' }, t('game.lastMove') + ':', h('strong', null, historyEntryLabel(lastEntry)))
          : null
      ),
      h('div', { class: 'board-toolbar-right' },
        canAct && !uiState.pending && left > 0
          ? h('span', { class: 'badge badge--amber' }, icon('layers', 12), left === 1 ? t('game.stonesLeftOne') : t('game.stonesLeft', { n: left }))
          : null
      )
    );

    const boardColumn = h('div', { class: 'game-board' }, toolbar);
    boardRef = new Board({
      onActivate: (payload) => {
        if (!payload || !payload.type || uiState.pending) return;
        submitAction({ type: payload.type, x: payload.x, y: payload.y });
      }
    });
    boardRef.setModel(model);
    boardColumn.appendChild(boardRef.root);
    return boardColumn;
  }

  function buildActionPanel() {
    const game = uiState.game;
    const groups = legalGroups();
    const canAct = canViewerAct();
    const player = currentPlayer();
    const pending = uiState.pending;
    const left = stonesLeft();

    const children = [];
    if (pending) {
      children.push(h('div', { class: 'notice' }, h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }), h('span', null, t('game.actionPending'))));
    } else if (!canAct) {
      children.push(h('div', { class: 'action-hint' }, player ? t('game.waitingTurn', { name: player.name }) : t('game.spectator')));
    } else if (groups.placements.length > 0) {
      children.push(h('div', { class: 'action-hint action-hint--warn' }, iconText('layers', t('game.mustPlace'))));
      children.push(h('p', { class: 'mode-hint' },
        (left > 0 ? (left === 1 ? t('game.stonesLeftOne') : t('game.stonesLeft', { n: left })) + ' · ' : '') + t('game.legalCount', { n: groups.placements.length })));
    } else {
      children.push(h('div', { class: 'action-hint action-hint--warn' },
        h('strong', { style: { display: 'block', marginBottom: '3px' } }, t('game.noPlacement')),
        t('game.noPlacementDesc')
      ));
    }

    if (uiState.lastActionError) {
      children.push(h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 15), h('span', null, uiState.lastActionError)));
    }

    return h('div', { class: 'game-panel' },
      h('div', { class: 'game-panel-head' },
        h('span', { class: 'game-panel-title' }, icon('swords', 13), t('common.turn')),
        player ? h('span', { class: 'seat-badge seat-badge--' + playerColor(player) },
          h('span', { class: 'seat-badge-letter', 'aria-hidden': 'true' }, seatLetter(player.seat)),
          h('span', { class: 'seat-badge-name' }, player.name)
        ) : null
      ),
      h('div', { class: 'game-panel-body' }, h('div', { class: 'stack-12' }, children))
    );
  }

  function seatNameFor(seat) {
    const players = (uiState.game && uiState.game.players) || [];
    return (players[seat] && players[seat].name) || t('game.seatN', { n: seat + 1 });
  }

  function buildNoteForm() {
    const game = uiState.game;
    const metrics = (game && game.metrics) || {};
    const noteValue = metrics.hardestDecisionNote || '';
    return h('div', { class: 'note-form' },
      h('div', null,
        h('div', { class: 'settings-row-title' }, t('game.noteTitle')),
        h('p', { class: 'settings-row-desc' }, t('game.noteDesc'))
      ),
      h('textarea', {
        class: 'textarea',
        maxlength: '280',
        placeholder: t('game.notePlaceholder'),
        'aria-label': t('game.noteTitle'),
        id: 'hardest-decision-note'
      }, noteValue),
      h('div', { class: 'note-meta' },
        h('span', { class: 'char-count' }, String(noteValue.length) + ' / 280'),
        h('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          disabled: uiState.noteSaving ? '' : null,
          onclick: () => {
            const area = document.getElementById('hardest-decision-note');
            saveNote(area ? area.value.trim() : '');
          }
        },
          uiState.noteSaving ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('check', 14),
          uiState.noteSaving ? t('game.noteSaving') : t('game.noteSave'))
      ),
      uiState.noteSaved ? h('p', { class: 'faint', style: { fontSize: '11px' } }, t('game.noteSaved')) : null,
      uiState.noteError ? h('p', { class: 'field-error' }, uiState.noteError) : null
    );
  }

  function buildResultSidebar(result) {
    const game = uiState.game;
    const winners = (result && result.winnerSeats) || [];
    const rows = scoreRows(game);
    const scoreLine = rows.slice().sort((a, b) => a.seat - b.seat).map((row) => h('div', {
      class: 'result-mini-row' + (winners.indexOf(row.seat) !== -1 ? ' is-winner' : '')
    },
      h('span', { class: 'seat-badge seat-badge--' + (row.color || seatColor(row.seat)) },
        h('span', { class: 'seat-badge-letter', 'aria-hidden': 'true' }, seatLetter(row.seat)),
        h('span', { class: 'seat-badge-name' }, seatNameFor(row.seat))
      ),
      h('span', { class: 'result-mini-score' }, String(row.score))
    ));
    return h('div', { class: 'game-panel result-panel result-panel--compact' },
      h('div', { class: 'game-panel-head' },
        h('span', { class: 'game-panel-title' }, icon('trophy', 13), t('game.resultTitle')),
        h('span', { class: 'faint mono', style: { fontSize: '9.5px' } }, game.finishedAt ? formatDate(game.finishedAt) : '')
      ),
      h('div', { class: 'game-panel-body' },
        h('div', { class: 'stack-12' },
          h('div', { class: 'winner-banner winner-banner--compact' + (winners.length ? ' has-winners' : '') },
            h('div', { class: 'winner-title' }, winnerLabel(game) || t('game.noWinner')),
            h('div', { class: 'winner-sub' }, endReasonLabel(result && result.endReason))
          ),
          h('div', { class: 'result-mini-list' }, scoreLine),
          h('button', {
            type: 'button',
            class: 'btn btn--primary btn--block btn--sm',
            onclick: () => navigate('/replay/' + encodeURIComponent(game.id))
          }, icon('play', 15), t('game.replay')),
          h('p', { class: 'mode-hint', style: { marginTop: 0 } }, t('game.resultDetailsBelow'))
        )
      )
    );
  }

  function buildPostgameSummary(result) {
    const game = uiState.game;
    const players = game.players || [];
    const winners = (result && result.winnerSeats) || [];
    const rows = scoreRows(game);
    const children = [];

    if (result && rows.length) {
      children.push(h('div', { class: 'table-wrap' },
        h('table', { class: 'score-table postgame-score-table' },
          h('caption', { class: 'sr-only' }, t('game.scoreTableCaption')),
          h('thead', null,
            h('tr', null,
              h('th', null, t('game.colSeat')),
              h('th', null, t('game.colStones')),
              h('th', null, t('game.colDecisions')),
              h('th', null, t('game.colOutcome'))
            )
          ),
          h('tbody', null, rows.slice().sort((a, b) => b.stones - a.stones).map((row) => h('tr', null,
            h('td', null,
              h('span', { class: 'seat-badge seat-badge--' + (row.color || seatColor(row.seat)) },
                h('span', { class: 'seat-badge-letter', 'aria-hidden': 'true' }, seatLetter(row.seat)),
                h('span', { class: 'seat-badge-name' }, seatNameFor(row.seat))
              )
            ),
            h('td', { class: 'score-main' + (winners.indexOf(row.seat) !== -1 ? ' score-winner' : '') }, String(row.stones)),
            h('td', null, String(decisionsForSeat(row.seat))),
            h('td', { class: winners.indexOf(row.seat) !== -1 ? 'score-winner' : null },
              winners.indexOf(row.seat) !== -1
                ? t('game.outcomeWin')
                : (winners.length ? t('game.outcomeLoss') : t('game.outcomeDraw')))
          )))
        )
      ));
    }

    if (result) {
      const facts = [];
      if (Number.isInteger(result.turns)) facts.push(t('game.factsTurns', { n: result.turns }));
      if (Number.isInteger(result.decisions)) facts.push(t('game.factsDecisions', { n: result.decisions }));
      if (Number.isInteger(result.totalStones)) facts.push(t('game.factsStones', { n: result.totalStones }));
      const line = Array.isArray(result.line) ? result.line.length : 0;
      if (line > 0) facts.push(t('game.factsWinLine', { n: line }));
      children.push(h('div', { class: 'result-meta' },
        h('div', { class: 'result-meta-row' }, h('span', null, t('game.endReason')), h('strong', null, endReasonLabel(result.endReason))),
        facts.length ? h('p', { class: 'analysis-facts' }, facts.join(' · ')) : null
      ));
    }

    children.push(h('div', { class: 'postgame-actions' },
      h('button', {
        type: 'button',
        class: 'btn btn--primary',
        onclick: () => navigate('/replay/' + encodeURIComponent(game.id))
      }, icon('play', 15), t('game.replay')),
      h('button', { type: 'button', class: 'btn btn--secondary', onclick: exportGame },
        icon('download', 15), t('game.export')),
      h('button', {
        type: 'button',
        class: 'btn btn--ghost',
        onclick: () => navigate(game.mode === 'online' ? '/online' : '/local')
      }, icon('refresh', 15), t('game.newGame'))
    ));

    children.push(buildNoteForm());

    return h('section', { class: 'card postgame-card postgame-summary' },
      h('div', { class: 'card-head' },
        h('div', { class: 'card-head-text' },
          h('h2', { class: 'card-title' }, icon('trophy', 16), t('game.scores')),
          h('p', { class: 'card-desc' }, t('game.scoreTableCaption'))
        ),
        h('div', { class: 'card-actions' },
          h('span', { class: 'badge badge--muted' }, modeBadgeLabel(game)),
          h('span', { class: 'faint mono', style: { fontSize: '10px' } }, game.id ? String(game.id).slice(0, 14) : '')
        )
      ),
      h('div', { class: 'card-body' }, h('div', { class: 'postgame-summary-body' }, children))
    );
  }

  function modeBadgeLabel(game) {
    return t('mode.' + game.mode);
  }

  function analysisText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return '';
  }

  /** Cell columns run A..S on a 19-wide board, so the pattern must cover them all. */
  const CELL_TOKEN = '[A-S]\\d{1,2}';

  function localizeAnalysisText(text) {
    if (!text || getLang() !== 'zh') return text;
    let output = String(text);
    const placeVerb = t('notation.place');
    // Chinese analysis prose often embeds an English verb before a cell token;
    // drop that verb after a localized preposition so the cell token reads
    // naturally in the Chinese sentence.
    const prepositionPattern = t('analysis.cellPrepositions');
    output = output.replace(
      new RegExp('(' + prepositionPattern + ')\\s*place\\s+(' + CELL_TOKEN + ')', 'gi'),
      function (match, preposition, cell) {
        return preposition + ' ' + cell;
      }
    );
    // Standalone action + cell tokens become localized action + cell name.
    output = output.replace(new RegExp('\\bplace\\s+(' + CELL_TOKEN + ')', 'gi'), placeVerb + ' $1');
    output = output.replace(/\bplacing\b/gi, placeVerb);
    output = output.replace(/\bplaces\b/gi, placeVerb);
    output = output.replace(/\bplaced\b/gi, placeVerb);
    output = output.replace(/\bplace\b/gi, placeVerb);
    return output;
  }

  function localizedAnalysisField(object, base) {
    if (!object || typeof object !== 'object') return '';
    const isZh = getLang() === 'zh';
    const candidates = isZh ? [base + 'Zh', base] : [base, base + 'Zh'];
    for (const key of candidates) {
      const text = analysisText(object[key]);
      if (text) return localizeAnalysisText(text);
    }
    return '';
  }

  function analysisSeatName(analysis, seat) {
    const summary = analysis && analysis.summary;
    const rows = summary && Array.isArray(summary.scores) ? summary.scores : [];
    const row = rows.find((item) => item && item.seat === seat);
    if (row && typeof row.name === 'string' && row.name) return row.name;
    return seatNameFor(seat);
  }

  function severityBadge(item) {
    const severity = item && (item.severity || item.priority);
    if (!severity || typeof severity !== 'string') return null;
    const normalized = severity.toLowerCase();
    const key = 'severity.' + normalized;
    const label = t(key) === key ? humanKey(severity) : t(key);
    const tone = normalized === 'high' || normalized === 'critical' ? 'crimson'
      : normalized === 'medium' ? 'amber'
        : normalized === 'low' ? 'muted' : 'neutral';
    return h('span', { class: 'badge badge--' + tone + ' analysis-severity' }, label);
  }

  function analysisObjectList(items, options) {
    const opts = options || {};
    if (!Array.isArray(items) || !items.length) return null;
    const list = h('ul', { class: 'analysis-objects' });
    for (const raw of items.slice(0, 8)) {
      const item = raw && typeof raw === 'object' ? raw : { detail: analysisText(raw) };
      const seatName = typeof item.seat === 'number' ? analysisSeatName(uiState.analysis, item.seat) : '';
      const headText = localizedAnalysisField(item, 'title');
      const detail = localizedAnalysisField(item, 'detail');
      const alternative = localizedAnalysisField(item, 'alternative');
      if (!headText && !detail && !alternative) continue;
      const metaParts = [];
      if (typeof item.turn === 'number') metaParts.push(t('replay.turnLabel', { n: item.turn }));
      if (typeof item.notation === 'string' && item.notation) metaParts.push(localizeAnalysisText(item.notation));
      if (typeof item.impact === 'number') metaParts.push((item.impact > 0 ? '+' : '') + String(item.impact));
      list.appendChild(h('li', { class: 'analysis-object' },
        h('div', { class: 'analysis-object-head' },
          seatName && opts.withSeat !== false ? h('span', { class: 'analysis-object-seat' }, seatName) : null,
          headText ? h('span', { class: 'analysis-object-title' }, headText) : null,
          severityBadge(item),
          metaParts.length ? h('span', { class: 'analysis-object-meta' }, metaParts.join(' · ')) : null
        ),
        detail ? h('p', { class: 'analysis-item-detail' }, detail) : null,
        alternative ? h('p', { class: 'analysis-item-alt' }, t('game.analysisAlternative') + ': ' + alternative) : null
      ));
    }
    return list.childNodes.length ? list : null;
  }

  function buildAnalysisSummary(summaryValue) {
    const children = [];
    if (typeof summaryValue === 'string') {
      const textContent = localizeAnalysisText(summaryValue);
      if (textContent) children.push(h('p', { class: 'analysis-text' }, textContent));
      return children;
    }
    if (!summaryValue || typeof summaryValue !== 'object') return children;
    const headline = localizedAnalysisField(summaryValue, 'headline');
    const resultLine = localizedAnalysisField(summaryValue, 'resultLine');
    if (headline) children.push(h('p', { class: 'analysis-headline' }, headline));
    if (resultLine) children.push(h('p', { class: 'analysis-text' }, resultLine));
    if (Array.isArray(summaryValue.scores) && summaryValue.scores.length) {
      children.push(h('div', { class: 'analysis-score-list' },
        summaryValue.scores.map((row) => {
          if (!row || typeof row !== 'object') return null;
          const color = row.color || seatColor(row.seat || 0);
          return h('div', { class: 'analysis-score-row' + (row.won ? ' is-winner' : '') },
            h('span', { class: 'analysis-score-seat' },
              h('span', { class: 'seat-badge-letter seat-badge-letter--' + color, 'aria-hidden': 'true' }, seatLetter(row.seat || 0)),
              h('span', null, typeof row.name === 'string' ? row.name : t('game.seatN', { n: (row.seat || 0) + 1 }))
            ),
            h('span', { class: 'analysis-score-value' }, String(row.score !== undefined ? row.score : '-')),
            row.rank ? h('span', { class: 'analysis-score-rank' }, '#' + row.rank) : null
          );
        }).filter(Boolean)
      ));
    }
    const facts = [];
    if (typeof summaryValue.turns === 'number') facts.push(t('game.factsTurns', { n: summaryValue.turns }));
    if (typeof summaryValue.decisions === 'number') facts.push(t('game.factsDecisions', { n: summaryValue.decisions }));
    if (typeof summaryValue.totalStones === 'number') facts.push(t('game.factsStones', { n: summaryValue.totalStones }));
    if (Array.isArray(summaryValue.winnerNames) && summaryValue.winnerNames.length) {
      facts.push(t('common.winner') + ': ' + summaryValue.winnerNames.join(t('common.listSeparator')));
    }
    if (typeof summaryValue.scoreMargin === 'number') {
      facts.push(t('game.analysisMargin') + ': ' + summaryValue.scoreMargin);
    }
    if (facts.length) children.push(h('p', { class: 'analysis-facts' }, facts.join(' · ')));
    return children;
  }

  function analysisColumn(title, list) {
    return h('div', { class: 'analysis-column' },
      h('h3', { class: 'analysis-column-title' }, title),
      list
    );
  }

  function buildAnalysisBody() {
    const game = uiState.game;
    if (!game || game.status !== 'finished') return null;
    if (uiState.analysisBusy || uiState.analysisState === 'loading') {
      return h('div', { class: 'row' },
        h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }),
        h('span', { class: 'faint' }, t('game.analysisGenerating'))
      );
    }
    if (uiState.analysisState === 'error' && !uiState.analysis) {
      return h('div', { class: 'stack-12' },
        h('div', { class: 'form-banner' }, icon('alert', 14), h('span', null, uiState.analysisError || t('game.analysisError'))),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: generateAnalysis }, icon('refresh', 14), t('common.retry'))
      );
    }
    if (!uiState.analysis) {
      return h('div', { class: 'analysis-empty' },
        h('p', { class: 'analysis-text' }, t('game.analysisEmpty')),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: generateAnalysis },
          icon('sparkle', 14), t('game.analysisGenerate'))
      );
    }
    const analysis = uiState.analysis;
    const summaryChildren = buildAnalysisSummary(analysis.summary);
    const momentList = analysisObjectList(analysis.keyMoments, { withSeat: true });
    const weaknessList = analysisObjectList(analysis.weaknesses, { withSeat: true });
    const recommendationList = analysisObjectList(analysis.recommendations, { withSeat: true });

    const columns = h('div', { class: 'analysis-columns' });
    if (momentList) columns.appendChild(analysisColumn(t('game.analysisMoments'), momentList));
    if (weaknessList) columns.appendChild(analysisColumn(t('game.analysisWeaknesses'), weaknessList));
    if (recommendationList) columns.appendChild(analysisColumn(t('game.analysisRecommendations'), recommendationList));

    const children = [];
    if (summaryChildren.length) {
      children.push(h('div', { class: 'analysis-summary-block' },
        h('h3', { class: 'analysis-column-title' }, t('game.analysisSummary')),
        summaryChildren
      ));
    }
    if (columns.childNodes.length) children.push(columns);
    if (!children.length) children.push(h('p', { class: 'analysis-text' }, t('game.analysisEmpty')));
    children.push(h('div', { class: 'analysis-actions' },
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: generateAnalysis },
        icon('refresh', 14), t('game.analysisGenerate'))
    ));
    return h('div', { class: 'analysis-layout' }, children);
  }

  function buildAnalysisCard() {
    return h('section', { class: 'card postgame-card postgame-analysis' },
      h('div', { class: 'card-head' },
        h('div', { class: 'card-head-text' },
          h('h2', { class: 'card-title' }, icon('sparkle', 16), t('game.analysisTitle')),
          h('p', { class: 'card-desc' }, t('game.analysisDesc'))
        )
      ),
      h('div', { class: 'card-body' }, buildAnalysisBody())
    );
  }

  function engineForSeat(seat) {
    const game = uiState.game;
    const rows = (game && game.players) || [];
    const row = rows.find((item) => item && item.seat === seat);
    if (!row || row.kind !== 'ai') return null;
    return row.engine === 'llm' ? 'llm' : 'local';
  }

  /* AI coach --------------------------------------------------------------- */

  function coachEnabled() {
    const session = getSession();
    return Boolean(session.features && session.features.llm);
  }

  function coachSeatRow(seat) {
    const players = (uiState.game && uiState.game.players) || [];
    return players[seat] || { seat: seat, name: t('game.seatN', { n: seat + 1 }), color: seatColor(seat) };
  }

  function coachSeatChip(seat) {
    const player = coachSeatRow(seat);
    const color = player.color || seatColor(seat);
    return h('span', { class: 'seat-badge seat-badge--' + color },
      h('span', { class: 'seat-badge-letter', 'aria-hidden': 'true' }, seatLetter(seat)),
      h('span', { class: 'seat-badge-name' }, player.name || t('game.seatN', { n: seat + 1 }))
    );
  }

  function coachLocalizedText(value) {
    if (typeof value !== 'string') return '';
    return localizeAnalysisText(value);
  }

  function coachErrorMessage(error) {
    const code = error && error.code ? error.code : '';
    if (code === 'AI_NOT_CONFIGURED') return t('coach.notConfiguredTitle');
    if (code === 'AI_DISABLED') return t('coach.disabled');
    if (code === 'AI_QUOTA_EXCEEDED') return t('coach.quotaExceeded');
    if (code === 'AI_PROVIDER_ERROR') return t('coach.providerError');
    if (code === 'AI_INVALID_RESPONSE') return t('coach.invalidResponse');
    if (code === 'GAME_NOT_FINISHED') return t('coach.notFinished');
    if (code === 'COACH_REPORT_REQUIRED') return t('coach.chatRequiresReport');
    return describeError(error);
  }

  async function loadCoach() {
    if (!coachEnabled() || disposed) return;
    const coach = uiState.coach;
    if (coach.loading || coach.loaded) return;
    coach.loading = true;
    coach.error = '';
    render();
    try {
      const data = await api.getCoach(id);
      if (disposed) return;
      coach.report = data && data.report ? data.report : null;
      coach.messages = data && Array.isArray(data.messages) ? data.messages : [];
      coach.config = data && data.config ? data.config : null;
      coach.error = '';
    } catch (error) {
      if (disposed) return;
      coach.error = coachErrorMessage(error);
    }
    coach.loading = false;
    coach.loaded = true;
    render();
  }

  async function generateCoachReport(force) {
    if (!coachEnabled() || disposed) return;
    const coach = uiState.coach;
    if (coach.generating) return;
    coach.generating = true;
    coach.error = '';
    render();
    try {
      const data = await api.generateCoach(id, { force: Boolean(force), language: getLang() });
      if (disposed) return;
      if (data && data.report) {
        coach.report = data.report;
        coach.cached = Boolean(data.cached);
        coach.config = Object.assign({}, coach.config || {}, { configured: true });
        coach.error = '';
      }
    } catch (error) {
      if (disposed) return;
      coach.error = coachErrorMessage(error);
      if (error && (error.code === 'AI_NOT_CONFIGURED' || error.code === 'AI_DISABLED')) {
        coach.config = Object.assign({}, coach.config || {}, { configured: false });
      }
    }
    coach.generating = false;
    render();
  }

  function mergeCoachMessages(existing, incoming) {
    const merged = new Map();
    for (const message of existing || []) {
      if (message && message.id !== undefined) merged.set(String(message.id), message);
    }
    for (const message of incoming || []) {
      if (message && message.id !== undefined) merged.set(String(message.id), message);
    }
    return Array.from(merged.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }

  async function sendCoachChat() {
    if (!coachEnabled() || disposed) return;
    const coach = uiState.coach;
    if (coach.sending) return;
    const draft = String(coach.chatDraft || '').trim();
    if (!draft) {
      coach.chatError = t('coach.chatRequired');
      render();
      return;
    }
    if (draft.length > 600) {
      coach.chatError = t('coach.chatTooLong');
      render();
      return;
    }
    coach.sending = true;
    coach.chatError = '';
    render();
    try {
      const data = await api.sendCoachMessage(id, draft, getLang());
      if (disposed) return;
      if (data && Array.isArray(data.messages)) {
        coach.messages = mergeCoachMessages(coach.messages, data.messages);
      } else if (data && typeof data.reply === 'string') {
        const now = Date.now();
        coach.messages = coach.messages.concat([
          { id: 'local-user-' + now, role: 'user', content: draft, createdAt: now },
          { id: 'local-assistant-' + (now + 1), role: 'assistant', content: data.reply, createdAt: now + 1 }
        ]);
      }
      coach.chatUsage = data && data.usage ? data.usage : null;
      coach.chatDraft = '';
    } catch (error) {
      if (disposed) return;
      coach.chatError = error && error.code === 'AI_QUOTA_EXCEEDED'
        ? t('coach.quotaExceeded')
        : t('coach.chatError') + ' · ' + describeError(error);
    }
    coach.sending = false;
    render();
  }

  function coachItemHead(item, title) {
    return h('div', { class: 'coach-item-head' },
      item && typeof item.seat === 'number' ? coachSeatChip(item.seat) : null,
      title ? h('span', { class: 'coach-item-title' }, title) : null,
      severityBadge(item)
    );
  }

  function buildCoachItem(item) {
    if (!item || typeof item !== 'object') return null;
    const title = coachLocalizedText(item.title);
    const detail = coachLocalizedText(item.detail);
    if (!title && !detail) return null;
    const node = h('li', { class: 'coach-item' },
      coachItemHead(item, title),
      detail ? h('p', { class: 'coach-item-detail' }, detail) : null
    );
    return node;
  }

  function buildCoachWeakness(item) {
    const node = buildCoachItem(item);
    if (!node || !item) return node;
    const meta = [];
    if (typeof item.turn === 'number') meta.push(t('coach.turn', { n: item.turn }));
    if (Array.isArray(item.cells) && item.cells.length) meta.push(item.cells.join(' '));
    if (meta.length) node.appendChild(h('p', { class: 'coach-item-meta' }, meta.join(' · ')));
    return node;
  }

  function buildCoachMistake(item) {
    if (!item || typeof item !== 'object') return null;
    const meta = [];
    if (typeof item.turn === 'number') meta.push(t('coach.turn', { n: item.turn }));
    const actual = coachLocalizedText(item.actual);
    const better = coachLocalizedText(item.better);
    const reason = coachLocalizedText(item.reason);
    const gain = typeof item.gain === 'number' ? t('coach.gain', { n: item.gain }) : '';
    return h('li', { class: 'coach-item coach-item--mistake' },
      h('div', { class: 'coach-item-head' },
        typeof item.seat === 'number' ? coachSeatChip(item.seat) : null,
        meta.length ? h('span', { class: 'coach-item-meta' }, meta.join(' · ')) : null,
        gain ? h('span', { class: 'badge badge--muted' }, gain) : null
      ),
      actual || better
        ? h('div', { class: 'coach-mistake-moves' },
            actual ? h('span', { class: 'coach-move coach-move--actual' },
              h('span', { class: 'coach-move-label' }, t('coach.actual') + ': '),
              actual
            ) : null,
            actual && better ? h('span', { class: 'coach-move-arrow', 'aria-hidden': 'true' }, '→') : null,
            better ? h('span', { class: 'coach-move coach-move--better' },
              h('span', { class: 'coach-move-label' }, t('coach.better') + ': '),
              better
            ) : null
          )
        : null,
      reason ? h('p', { class: 'coach-item-detail' }, reason) : null
    );
  }

  function coachSection(title, items, builder) {
    if (!Array.isArray(items) || !items.length) return null;
    const list = h('ul', { class: 'coach-list' });
    for (const item of items) {
      const node = builder(item);
      if (node && node.childNodes.length) list.appendChild(node);
    }
    if (!list.childNodes.length) return null;
    return h('div', { class: 'coach-section' },
      h('h3', { class: 'analysis-column-title' }, title),
      list
    );
  }

  function buildCoachTrainingPlan(plan) {
    if (!Array.isArray(plan) || !plan.length) return null;
    const items = plan
      .map((step) => coachLocalizedText(step))
      .filter((step) => Boolean(step));
    if (!items.length) return null;
    return h('div', { class: 'coach-section coach-training' },
      h('h3', { class: 'analysis-column-title' }, t('coach.trainingPlan')),
      h('ol', { class: 'coach-training-list' }, items.map((step) => h('li', null, step)))
    );
  }

  function buildCoachBubble(message) {
    const role = message && message.role === 'user' ? 'user' : 'assistant';
    return h('div', { class: 'coach-bubble coach-bubble--' + role },
      h('div', { class: 'coach-bubble-role' }, role === 'user' ? t('coach.roleUser') : t('coach.roleCoach')),
      h('div', { class: 'coach-bubble-content' }, String((message && message.content) || '')),
      message && message.createdAt ? h('div', { class: 'coach-bubble-time' }, formatDate(message.createdAt)) : null
    );
  }

  function buildCoachChat() {
    const coach = uiState.coach;
    const transcript = h('div', {
      class: 'coach-transcript',
      tabindex: '0',
      role: 'log',
      'aria-label': t('coach.chatTitle')
    });
    if (!coach.messages.length) {
      transcript.appendChild(h('p', { class: 'coach-chat-empty' }, t('coach.chatEmpty')));
    } else {
      coach.messages.forEach((message) => transcript.appendChild(buildCoachBubble(message)));
    }
    const input = h('textarea', {
      class: 'textarea coach-chat-input',
      maxlength: '600',
      rows: '2',
      placeholder: t('coach.chatPlaceholder'),
      'aria-label': t('coach.chatPlaceholder'),
      value: coach.chatDraft || '',
      disabled: coach.sending ? '' : null,
      oninput: (event) => { uiState.coach.chatDraft = event.target.value; },
      onkeydown: (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendCoachChat();
        }
      }
    });
    const sendButton = h('button', {
      type: 'button',
      class: 'btn btn--primary',
      disabled: coach.sending ? '' : null,
      onclick: sendCoachChat
    },
      coach.sending ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('send', 15),
      coach.sending ? t('coach.chatSending') : t('coach.chatSend')
    );
    const chatUsage = coach.chatUsage
      ? h('p', { class: 'coach-chat-usage' }, t('coach.usage', {
          input: coach.chatUsage.inputTokens || 0,
          output: coach.chatUsage.outputTokens || 0
        }))
      : null;
    return h('div', { class: 'coach-chat' },
      h('div', { class: 'coach-chat-head' },
        h('h3', { class: 'analysis-column-title' }, t('coach.chatTitle')),
        h('p', { class: 'coach-chat-desc' }, t('coach.chatDesc'))
      ),
      transcript,
      coach.chatError
        ? h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 14), h('span', null, coach.chatError))
        : null,
      h('div', { class: 'coach-chat-row' }, input, sendButton),
      h('p', { class: 'coach-chat-hint' }, t('coach.chatHint')),
      chatUsage
    );
  }

  function buildCoachReport(report, options) {
    const opts = options || {};
    const meta = [];
    if (report.provider || report.model) {
      meta.push(t('coach.meta', { provider: report.provider || '-', model: report.model || '-' }));
    }
    if (report.generatedAt) meta.push(formatDate(report.generatedAt));
    if (report.usage && (report.usage.inputTokens || report.usage.outputTokens)) {
      meta.push(t('coach.usage', {
        input: report.usage.inputTokens || 0,
        output: report.usage.outputTokens || 0
      }));
    }
    const headline = coachLocalizedText(report.headline);
    const summary = coachLocalizedText(report.summary);

    const head = h('div', { class: 'coach-report-head' },
      h('div', { class: 'coach-report-meta' },
        h('span', { class: 'badge ' + (report.source === 'llm' ? 'badge--violet' : 'badge--muted') },
          report.source === 'llm' ? t('coach.sourceLlm') : t('coach.sourceFallback')
        ),
        meta.length ? h('span', { class: 'coach-report-meta-text' }, meta.join(' · ')) : null
      ),
      headline ? h('h3', { class: 'coach-headline' }, headline) : null,
      summary ? h('p', { class: 'coach-summary' }, summary) : null
    );

    const grid = h('div', { class: 'coach-grid' });
    const strengths = coachSection(t('coach.strengths'), report.strengths, buildCoachItem);
    const weaknesses = coachSection(t('coach.weaknesses'), report.weaknesses, buildCoachWeakness);
    const mistakes = coachSection(t('coach.keyMistakes'), report.keyMistakes, buildCoachMistake);
    const recommendations = coachSection(t('coach.recommendations'), report.recommendations, buildCoachItem);
    if (strengths) grid.appendChild(strengths);
    if (weaknesses) grid.appendChild(weaknesses);
    if (mistakes) grid.appendChild(mistakes);
    if (recommendations) grid.appendChild(recommendations);

    const sections = [head];
    if (grid.childNodes.length) sections.push(grid);
    const training = buildCoachTrainingPlan(report.trainingPlan);
    if (training) sections.push(training);
    if (opts.includeChat !== false) sections.push(buildCoachChat());
    return h('div', { class: 'coach-report' }, sections);
  }

  function buildCoachBody() {
    const coach = uiState.coach;
    const config = coach.config || {};
    const configured = Boolean(config.configured);
    if (coach.loading) return loadingBlock(t('common.loading'));
    if (!configured && coach.error) {
      return h('div', { class: 'stack-12' },
        h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 15), h('span', null, coach.error)),
        h('div', { class: 'row' },
          h('a', { class: 'btn btn--primary btn--sm', href: '#/settings' },
            icon('settings', 14), t('coach.openSettings')),
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: loadCoach },
            icon('refresh', 14), t('common.retry'))
        )
      );
    }
    if (!configured && !coach.report) {
      return h('div', { class: 'coach-empty-state' },
        h('div', { class: 'state-icon', 'aria-hidden': 'true' }, icon('robot', 26)),
        h('p', { class: 'state-title' }, t('coach.notConfiguredTitle')),
        h('p', { class: 'state-desc' }, t('coach.notConfiguredBody')),
        h('a', { class: 'btn btn--primary btn--sm', href: '#/settings' },
          icon('settings', 14), t('coach.openSettings'))
      );
    }
    if (!coach.report) {
      return h('div', { class: 'stack-16' },
        coach.error
          ? h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 15), h('span', null, coach.error))
          : null,
        h('div', { class: 'coach-empty-state' },
          h('div', { class: 'state-icon', 'aria-hidden': 'true' }, icon('message', 26)),
          h('p', { class: 'state-title' }, t('coach.empty')),
          h('p', { class: 'state-desc' }, t('coach.emptyDesc')),
          h('button', {
            type: 'button',
            class: 'btn btn--primary btn--sm',
            disabled: coach.generating ? '' : null,
            onclick: () => generateCoachReport(false)
          },
            coach.generating ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('sparkle', 14),
            coach.generating ? t('coach.generating') : t('coach.generate'))
        )
      );
    }
    const children = [];
    if (!configured) {
      children.push(h('div', { class: 'notice notice--warn' },
        icon('alert', 15),
        h('span', { class: 'flex-1' }, t('coach.notConfiguredBody')),
        h('a', { class: 'btn btn--ghost btn--sm', href: '#/settings' },
          icon('settings', 14), t('coach.openSettings'))
      ));
    }
    children.push(buildCoachReport(coach.report, { includeChat: configured }));
    if (coach.error) {
      children.push(h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 15), h('span', null, coach.error)));
    }
    if (coach.report.source !== 'llm') {
      children.push(h('div', { class: 'notice notice--warn' }, icon('info', 15), h('span', null, t('coach.fallbackNotice'))));
    }
    return h('div', { class: 'stack-16' }, children);
  }

  function buildCoachCard() {
    const coach = uiState.coach;
    const actions = [];
    if (coach.cached) actions.push(h('span', { class: 'badge badge--muted' }, t('coach.cached')));
    if (coach.report) {
      actions.push(h('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        disabled: coach.generating ? '' : null,
        onclick: () => generateCoachReport(true)
      },
        coach.generating ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('refresh', 14),
        coach.generating ? t('coach.generating') : t('coach.regenerate')));
    }
    return h('section', { class: 'card postgame-card postgame-coach coach-card' },
      h('div', { class: 'card-head' },
        h('div', { class: 'card-head-text' },
          h('h2', { class: 'card-title' }, icon('message', 16), t('coach.title')),
          h('p', { class: 'card-desc' }, t('coach.desc'))
        ),
        actions.length ? h('div', { class: 'card-actions' }, actions) : null
      ),
      h('div', { class: 'card-body' }, buildCoachBody())
    );
  }

  function buildPostgameSection(result) {
    const cards = [buildPostgameSummary(result), buildAnalysisCard()];
    if (coachEnabled()) cards.push(buildCoachCard());
    return h('section', { class: 'game-postgame' }, cards);
  }

  function buildMoveLog() {
    const game = uiState.game;
    const history = (game.state && game.state.history) || [];
    const log = h('div', { class: 'move-log' });
    if (!history.length) {
      log.appendChild(h('div', { class: 'log-empty' }, t('game.moveLogEmpty')));
    } else {
      history.forEach((entry, index) => {
        const player = statePlayers()[entry.seat];
        const color = playerColor(player);
        log.appendChild(h('div', { class: 'move-log-item' + (index === history.length - 1 ? ' is-last' : '') },
          h('span', { class: 'move-log-seq' }, String(index + 1)),
          h('span', { class: 'move-log-letter move-log-letter--' + color, 'aria-hidden': 'true' }, seatLetter(entry.seat)),
          h('span', { class: 'move-log-notation' }, historyEntryLabel(entry)),
          h('span', { class: 'move-log-turn' }, entry.turn ? 'T' + entry.turn : '')
        ));
      });
    }
    const logCard = h('div', { class: 'game-panel' },
      h('div', { class: 'game-panel-head' },
        h('span', { class: 'game-panel-title' }, icon('history', 13), t('game.moveLog')),
        h('span', { class: 'faint mono', style: { fontSize: '9.5px' } }, String(history.length))
      ),
      h('div', { class: 'game-panel-body' }, log)
    );
    return logCard;
  }

  function render() {
    clear(container);
    if (uiState.loading) {
      container.appendChild(loadingBlock(t('game.loading')));
      return;
    }
    if (uiState.loadError || !uiState.game) {
      container.appendChild(errorState({
        title: t('game.notFound'),
        message: uiState.loadError ? describeError(uiState.loadError) : t('game.notFoundDesc'),
        onRetry: () => loadGame()
      }));
      return;
    }
    const game = uiState.game;
    container.appendChild(buildTopbar());
    const left = h('aside', { class: 'game-left' },
      buildTurnBanner(),
      buildPlayersPanel(),
      buildAgentPanel(),
      buildMetaPanel()
    );
    const boardColumn = buildBoardColumn();
    const finished = game.status === 'finished';
    const right = h('aside', { class: 'game-right' },
      finished ? buildResultSidebar(gameResult()) : buildActionPanel(),
      buildMoveLog()
    );
    container.appendChild(h('div', { class: 'game-layout' }, left, boardColumn, right));
    if (finished) container.appendChild(buildPostgameSection(gameResult()));

    const logNode = container.querySelector('.move-log');
    const historyLength = (game.state && game.state.history && game.state.history.length) || 0;
    if (logNode && historyLength) {
      logNode.scrollTop = logNode.scrollHeight;
    }
    lastLogLength = historyLength;
    const transcript = container.querySelector('.coach-transcript');
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }

  async function loadGame() {
    uiState.loading = true;
    uiState.loadError = null;
    render();
    try {
      const response = await api.getGame(id);
      if (disposed) return;
      if (!response || !response.game) throw new Error('Missing game');
      uiState.game = response.game;
      uiState.loading = false;
      if (uiState.game.status === 'lobby') {
        navigate('/online/' + encodeURIComponent(uiState.game.id), { replace: true });
        return;
      }
      render();
      if (uiState.game.status === 'finished') {
        loadAnalysis();
        loadCoach();
      } else {
        startLive();
      }
    } catch (error) {
      if (disposed) return;
      uiState.loading = false;
      uiState.loadError = error;
      render();
    }
  }

  clear(container);
  container.appendChild(loadingBlock(t('game.loading')));
  loadGame();

  return function cleanup() {
    disposed = true;
    cleanupLive();
    boardRef = null;
  };
}