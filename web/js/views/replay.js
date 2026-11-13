/**
 * Replay viewer: steps through the canonical action log using the shared rules
 * engine imported by the browser, with a graceful final-position fallback.
 */
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { api, ApiError, saveBlob } from '../core/api.js';
import { pageHeader, errorState, loadingBlock, toast, describeError, segmented } from '../core/ui.js';
import { navigate } from '../core/router.js';
import { cellName, formatDate, seatLetter, seatColor, endReasonLabel } from '../core/format.js';
import { Board, boardModelFromState } from '../game/board.js';
import { playersInline, winnerLabel, modeBadge, statusBadge } from './common.js';

const SPEED_OPTIONS = [
  { value: 1400, label: '0.5×' },
  { value: 750, label: '1×' },
  { value: 380, label: '2×' }
];

function localizeEntry(entry) {
  if (!entry) return '';
  if (Array.isArray(entry.points) && entry.points.length > 0) {
    return entry.points.map((point) => cellName(point.x, point.y)).join(' ');
  }
  if (typeof entry.x === 'number' && typeof entry.y === 'number') {
    return cellName(entry.x, entry.y);
  }
  return entry.notation || '';
}

function extractReplay(record) {
  if (!record || typeof record !== 'object') return null;
  const root = record.replay && typeof record.replay === 'object' ? record.replay : record;
  const initialState = root.initialState || root.initial_state || record.initialState || null;
  const actions = root.actions || root.actionLog || root.action_log || record.actions || [];
  const states = root.states || root.snapshots || root.steps || record.states || null;
  const finalState = root.finalState || root.final_state || root.state || null;
  const moves = root.moves || record.moves || [];
  const meta = root.game || record.game || null;
  return {
    initialState: initialState,
    actions: Array.isArray(actions) ? actions : [],
    states: Array.isArray(states) ? states : null,
    finalState: finalState,
    moves: Array.isArray(moves) ? moves : [],
    meta: meta
  };
}

async function importRulesEngine() {
  const candidates = ['/shared/rules.js', '../shared/rules.js'];
  for (const candidate of candidates) {
    try {
      const module = await import(candidate);
      if (module && typeof module.applyAction === 'function') {
        return module;
      }
    } catch (error) {
      // try the next mount path
    }
  }
  return null;
}

export async function mount(container, route) {
  const id = route && route.params ? route.params.id : '';
  let disposed = false;
  let game = null;
  let replayData = null;
  let engine = null;
  let snapshots = [];
  let step = 0;
  let playing = false;
  let speed = 750;
  let playTimer = null;
  let error = null;
  let loading = true;
  let boardRef = null;
  let note = '';

  function totalSteps() {
    return Math.max(0, snapshots.length - 1);
  }

  function stopPlaying() {
    playing = false;
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
    }
  }

  function setStep(next, options) {
    const total = totalSteps();
    step = Math.max(0, Math.min(total, next));
    if (step >= total) stopPlaying();
    render();
    if (options && options.focusBoard && boardRef) boardRef.focusBoard();
  }

  function togglePlay() {
    if (totalSteps() === 0) return;
    if (playing) {
      stopPlaying();
      render();
      return;
    }
    if (step >= totalSteps()) step = 0;
    playing = true;
    playTimer = setInterval(() => {
      if (disposed) return;
      if (step >= totalSteps()) {
        stopPlaying();
        render();
        return;
      }
      step += 1;
      render();
    }, speed);
    render();
  }

  function handleKeydown(event) {
    const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      stopPlaying();
      setStep(step - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      stopPlaying();
      setStep(step + 1);
    } else if (event.key === ' ' && tag !== 'button' && tag !== 'a') {
      event.preventDefault();
      togglePlay();
    }
  }

  async function exportRecord() {
    try {
      const file = await api.download(api.exportUrl(id, 'json'));
      saveBlob(file.blob, file.filename);
    } catch (err) {
      toast(describeError(err), { type: 'error' });
    }
  }

  function buildControls() {
    const total = totalSteps();
    const slider = h('input', {
      class: 'range',
      type: 'range',
      min: '0',
      max: String(total),
      step: '1',
      value: String(step),
      'aria-label': t('replay.stepOf', { step: step, total: total }),
      oninput: (event) => {
        stopPlaying();
        setStep(Number(event.target.value));
      }
    });
    const label = step === 0 ? t('replay.start') : step >= total ? t('replay.final') : t('replay.turnLabel', { n: step });
    const buttons = [
      { icon: 'first', label: t('replay.first'), onclick: () => { stopPlaying(); setStep(0); }, disabled: step === 0 },
      { icon: 'prev', label: t('replay.prev'), onclick: () => { stopPlaying(); setStep(step - 1); }, disabled: step === 0 },
      {
        icon: playing ? 'pause' : 'play',
        label: playing ? t('replay.pause') : t('replay.play'),
        onclick: togglePlay,
        primary: true,
        disabled: total === 0
      },
      { icon: 'next', label: t('replay.next'), onclick: () => { stopPlaying(); setStep(step + 1); }, disabled: step >= total },
      { icon: 'last', label: t('replay.last'), onclick: () => { stopPlaying(); setStep(total); }, disabled: step >= total }
    ];
    return h('div', { class: 'card' },
      h('div', { class: 'card-body' }, h('div', { class: 'replay-controls' },
        h('div', { class: 'replay-status' },
          h('span', { class: 'replay-step' }, t('replay.stepOf', { step: step, total: total })),
          h('span', null, label)
        ),
        h('div', { class: 'replay-buttons' }, buttons.map((button) => h('button', {
          type: 'button',
          class: 'btn ' + (button.primary ? 'btn--primary' : 'btn--secondary') + ' btn--sm',
          'aria-label': button.label,
          title: button.label,
          disabled: button.disabled ? '' : null,
          onclick: button.onclick
        }, button.icon ? icon(button.icon, 15) : null, button.primary ? h('span', null, button.label) : null))),
        h('div', { class: 'replay-slider' }, slider),
        h('div', { class: 'row-between' },
          h('span', { class: 'replay-speed-label' }, t('replay.speed')),
          segmented({
            size: 'sm',
            value: speed,
            ariaLabel: t('replay.speed'),
            options: SPEED_OPTIONS,
            onChange: (value) => {
              speed = value;
              if (playing) {
                stopPlaying();
                togglePlay();
              } else {
                render();
              }
            }
          })
        )
      ))
    );
  }

  function buildLog() {
    const moves = replayData && replayData.moves.length ? replayData.moves : [];
    const history = snapshots.length ? (snapshots[snapshots.length - 1].history || []) : [];
    const entries = moves.length ? moves : history;
    const list = h('div', { class: 'move-log replay-log' });
    if (!entries.length && totalSteps() === 0) {
      list.appendChild(h('div', { class: 'log-empty' }, t('game.moveLogEmpty')));
    } else {
      const startItem = h('button', {
        type: 'button',
        class: 'move-log-item is-clickable' + (step === 0 ? ' is-current' : ''),
        onclick: () => { stopPlaying(); setStep(0); }
      }, h('span', { class: 'move-log-seq' }, '0'), h('span', { class: 'move-log-letter' }), h('span', { class: 'move-log-notation' }, t('replay.start')), h('span', { class: 'move-log-turn' }));
      list.appendChild(startItem);
      entries.forEach((entry, index) => {
        const itemStep = index + 1;
        if (itemStep > totalSteps()) return;
        const player = (game && game.players && game.players[entry.seat]) || null;
        const color = (player && player.color) || seatColor(entry.seat);
        list.appendChild(h('button', {
          type: 'button',
          class: 'move-log-item is-clickable' + (step === itemStep ? ' is-current' : '') + (itemStep === totalSteps() ? ' is-last' : ''),
          onclick: () => { stopPlaying(); setStep(itemStep); }
        },
          h('span', { class: 'move-log-seq' }, String(itemStep)),
          h('span', { class: 'move-log-letter move-log-letter--' + color, 'aria-hidden': 'true' }, seatLetter(entry.seat)),
          h('span', { class: 'move-log-notation' }, localizeEntry(entry)),
          h('span', { class: 'move-log-turn' }, entry.turn ? 'T' + entry.turn : '')
        ));
      });
    }
    return h('div', { class: 'game-panel' },
      h('div', { class: 'game-panel-head' },
        h('span', { class: 'game-panel-title' }, icon('history', 13), t('replay.moveList')),
        h('span', { class: 'faint mono', style: { fontSize: '9.5px' } }, t('replay.actions', { n: totalSteps() }))
      ),
      h('div', { class: 'game-panel-body' }, list)
    );
  }

  function buildInfoCard() {
    if (!game) return null;
    const result = game.result || (game.state && game.state.result);
    const rows = [];
    if (result) {
      rows.push(h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('common.winner')), h('span', { class: 'kv-value' }, winnerLabel(game))));
      rows.push(h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('game.endReason')), h('span', { class: 'kv-value' }, endReasonLabel(result.endReason))));
      if (Number.isInteger(result.turns)) {
        rows.push(h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('game.factsTurns', { n: result.turns })), h('span', { class: 'kv-value' }, '')));
      }
      if (Number.isInteger(result.decisions)) {
        rows.push(h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('game.factsDecisions', { n: result.decisions })), h('span', { class: 'kv-value' }, '')));
      }
    }
    return h('div', { class: 'game-panel' },
      h('div', { class: 'game-panel-head' },
        h('span', { class: 'game-panel-title' }, icon('info', 13), t('common.result'))
      ),
      h('div', { class: 'game-panel-body' }, h('div', { class: 'stack-12' },
        game.players ? h('div', null, playersInline(game.players)) : null,
        rows.length ? h('div', { class: 'kv-list' }, rows) : null,
        h('div', { class: 'kv-list' },
          h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('common.date')), h('span', { class: 'kv-value' }, formatDate(game.finishedAt || game.createdAt)))
        )
      ))
    );
  }

  function buildBoardColumn() {
    const currentState = snapshots[Math.min(step, snapshots.length - 1)];
    const lastEntry = currentState && currentState.history && currentState.history.length
      ? currentState.history[currentState.history.length - 1]
      : null;
    const atFinal = step >= totalSteps();
    const toolbar = h('div', { class: 'board-toolbar' },
      h('div', { class: 'board-toolbar-left' },
        h('span', { class: 'game-phase' },
          icon('clock', 13),
          h('strong', null, step === 0 ? t('replay.start') : atFinal ? t('replay.final') : t('replay.turnLabel', { n: step }))
        ),
        lastEntry ? h('span', { class: 'last-move' }, t('game.lastMove') + ':', h('strong', null, localizeEntry(lastEntry))) : null
      )
    );
    const column = h('div', { class: 'replay-board' }, toolbar);
    if (currentState) {
      boardRef = new Board({ hideHint: false });
      const model = boardModelFromState(currentState, {
        interactive: false,
        legalActions: [],
        winLine: atFinal ? (currentState.result && currentState.result.line) || null : null,
        last: lastEntry && typeof lastEntry.x === 'number' ? { x: lastEntry.x, y: lastEntry.y } : null
      });
      boardRef.setModel(model);
      column.appendChild(boardRef.root);
    } else {
      column.appendChild(h('p', { class: 'muted' }, t('replay.exportUnavailable')));
    }
    if (note) {
      column.appendChild(h('div', { class: 'notice notice--warn' }, icon('info', 15), h('span', null, note)));
    }
    return column;
  }

  function render() {
    if (disposed) return;
    clear(container);
    if (loading) {
      container.appendChild(loadingBlock(t('replay.loading')));
      return;
    }
    if (error) {
      container.appendChild(errorState({
        title: t('replay.notFound'),
        message: describeError(error),
        onRetry: () => window.location.reload()
      }));
      container.appendChild(h('div', { class: 'row', style: { justifyContent: 'center' } },
        h('a', { class: 'btn btn--ghost', href: '#/game/' + encodeURIComponent(id) }, icon('arrowLeft', 15), t('replay.backGame'))
      ));
      return;
    }
    container.appendChild(pageHeader({
      eyebrow: t('nav.history'),
      title: t('replay.title'),
      subtitle: game ? t('history.playersCount', { n: game.playerCount || (game.players || []).length }) + ' · ' + formatDate(game.createdAt) : '',
      onBack: () => navigate('/game/' + encodeURIComponent(id)),
      backLabel: t('replay.backGame'),
      actions: [
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: exportRecord }, icon('download', 15), t('common.export'))
      ]
    }));
    const left = buildBoardColumn();
    const aside = h('aside', { class: 'stack-16' }, buildControls(), buildLog(), buildInfoCard());
    container.appendChild(h('div', { class: 'replay-layout' }, left, aside));
  }

  async function setup() {
    try {
      const [gameResponse, exportFile] = await Promise.all([
        api.getGame(id),
        api.download(api.exportUrl(id, 'json')).catch(() => null)
      ]);
      if (disposed) return;
      game = gameResponse && gameResponse.game ? gameResponse.game : null;
      if (!game) throw new ApiError('Missing game', { status: 404, code: 'NOT_FOUND' });
      let record = null;
      if (exportFile) {
        try {
          record = JSON.parse(await exportFile.blob.text());
        } catch (parseError) {
          record = null;
        }
      }
      replayData = extractReplay(record) || extractReplay({ finalState: game.state });
      if (record && record.game && record.game.players) {
        game = Object.assign({}, game, { players: record.game.players });
      }
      const hasInitial = replayData && replayData.initialState;
      const actions = (replayData && replayData.actions) || [];
      engine = await importRulesEngine();
      if (disposed) return;
      if (engine && hasInitial && actions.length) {
        snapshots = [replayData.initialState];
        let cursor = replayData.initialState;
        let broken = false;
        for (const action of actions) {
          try {
            const result = engine.applyAction(cursor, action);
            cursor = result.state;
            snapshots.push(cursor);
          } catch (applyError) {
            broken = true;
            break;
          }
        }
        if (broken && snapshots.length > 1) {
          note = t('replay.exportUnavailable');
          replayData.actions = replayData.actions.slice(0, snapshots.length - 1);
        }
      } else if (replayData && replayData.states && replayData.states.length > 1) {
        snapshots = replayData.states;
        note = engine ? '' : t('replay.engineUnavailable');
      } else if (game.state && engine) {
        snapshots = [game.state];
        note = t('replay.exportUnavailable');
      } else if (game.state) {
        snapshots = [game.state];
        note = t('replay.engineUnavailable');
      } else {
        throw new ApiError('Replay unavailable', { status: 404, code: 'NOT_FOUND' });
      }
      loading = false;
      step = snapshots.length - 1;
      render();
    } catch (err) {
      if (disposed) return;
      loading = false;
      error = err;
      render();
    }
  }

  clear(container);
  container.appendChild(loadingBlock(t('replay.loading')));
  window.addEventListener('keydown', handleKeydown);
  setup();

  return function cleanup() {
    disposed = true;
    stopPlaying();
    window.removeEventListener('keydown', handleKeydown);
    boardRef = null;
  };
}
