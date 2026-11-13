/**
 * Game setup: mode, seats, names/kinds/difficulty.
 *
 * Connect6 is a two-player game, so the player count is fixed. The three rule
 * facts shown in the sidebar come from `/api/config` so the UI never drifts
 * from what the server actually adjudicates.
 */
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { getSession, requiresAuth, isSignedIn } from '../core/store.js';
import { api } from '../core/api.js';
import {
  pageHeader,
  sectionCard,
  field,
  describeError
} from '../core/ui.js';
import { seatLetter, seatColor } from '../core/format.js';
import { navigate } from '../core/router.js';
import { readStorage, writeStorage, authRequiredState } from './common.js';

const STORAGE_KEY = 'thickearth.setup.v2';
const MODES = ['local', 'ai', 'selfplay', 'arena'];
const DIFFICULTIES = ['easy', 'normal', 'hard'];
/** Connect6 is always two seats: black (0) and white (1). */
const PLAYER_COUNT = 2;

const MODE_META = {
  local: { icon: 'users', cardKey: 'setup.modeLocalDesc', hintKey: 'setup.modeHintLocal' },
  ai: { icon: 'cpu', cardKey: 'setup.modeAiDesc', hintKey: 'setup.modeHintAi' },
  selfplay: { icon: 'sparkle', cardKey: 'setup.modeSelfplayDesc', hintKey: 'setup.modeHintSelfplay' },
  arena: { icon: 'robot', cardKey: 'setup.modeArenaDesc', hintKey: 'setup.modeHintArena' }
};

function defaultSeat(index, mode) {
  if (mode === 'arena') {
    return {
      name: '',
      kind: index === 0 ? 'agent' : 'ai',
      engine: 'local',
      difficulty: 'normal'
    };
  }
  const isAi = mode === 'selfplay' || (mode === 'ai' && index > 0);
  return {
    name: '',
    kind: isAi ? 'ai' : 'human',
    engine: 'local',
    difficulty: 'normal'
  };
}

/** Arena seats are agents or local AI only; every other mode allows all three. */
function normalizeKind(kind, mode, index) {
  if (mode === 'local') return 'human';
  if (mode === 'selfplay') return 'ai';
  if (mode === 'arena') return kind === 'agent' ? 'agent' : kind === 'ai' ? 'ai' : defaultSeat(index, mode).kind;
  return kind === 'ai' || kind === 'agent' ? kind : 'human';
}

function normalizeSeats(seats, mode) {
  const result = [];
  for (let index = 0; index < PLAYER_COUNT; index += 1) {
    const source = Array.isArray(seats) ? seats[index] : null;
    const fallback = defaultSeat(index, mode);
    if (source && typeof source === 'object') {
      result.push({
        name: typeof source.name === 'string' ? source.name.slice(0, 32) : '',
        kind: normalizeKind(source.kind, mode, index),
        engine: source.engine === 'llm' ? 'llm' : 'local',
        difficulty: DIFFICULTIES.indexOf(source.difficulty) !== -1 ? source.difficulty : fallback.difficulty
      });
    } else {
      result.push(fallback);
    }
  }
  return result;
}

function seatsForMode(seats, mode) {
  return normalizeSeats(seats, mode);
}

function readInitialState(route) {
  const stored = readStorage(STORAGE_KEY, null);
  const mode = MODES.indexOf(route && route.query && route.query.mode) !== -1
    ? route.query.mode
    : stored && MODES.indexOf(stored.mode) !== -1 ? stored.mode : 'local';
  return { mode: mode, playerCount: PLAYER_COUNT, seats: seatsForMode(stored && stored.seats, mode) };
}

export async function mount(container, route) {
  const session = getSession();
  const rules = (session.config && session.config.rules) || {};
  const boardSize = Number.isInteger(rules.boardSize) ? rules.boardSize : 19;
  const winLength = Number.isInteger(rules.winLength) ? rules.winLength : 6;
  const firstTurnStones = Number.isInteger(rules.firstTurnStones) ? rules.firstTurnStones : 1;
  const stonesPerTurn = Number.isInteger(rules.stonesPerTurn) ? rules.stonesPerTurn : 2;
  const ruleVersion = rules.version || 'connect6/v1';
  const state = readInitialState(route);
  if (requiresAuth() && !isSignedIn()) {
    clear(container);
    container.appendChild(pageHeader({
      eyebrow: t('setup.eyebrow'),
      title: t('setup.title'),
      subtitle: t('setup.subtitle')
    }));
    container.appendChild(authRequiredState(t('auth.loginSubtitle')));
    return function cleanup() {};
  }
  const aiConfig = {
    available: Boolean(session.features && session.features.llm),
    configured: false,
    sharedAvailable: false,
    loading: Boolean(session.features && session.features.llm),
    error: ''
  };
  let disposed = false;
  let busy = false;
  let errorMessage = '';
  let errorDetail = '';

  async function loadAiConfig() {
    if (!aiConfig.available) return;
    try {
      const data = await api.aiSettings();
      if (disposed) return;
      aiConfig.configured = Boolean(data && data.configured);
      aiConfig.sharedAvailable = Boolean(data && data.sharedAvailable);
      aiConfig.error = '';
    } catch (error) {
      if (disposed) return;
      aiConfig.configured = false;
      aiConfig.sharedAvailable = false;
      aiConfig.error = describeError(error);
    }
    aiConfig.loading = false;
    if (!aiConfig.configured && !aiConfig.sharedAvailable) {
      let changed = false;
      state.seats.forEach((seat) => {
        if (seat.engine === 'llm') {
          seat.engine = 'local';
          changed = true;
        }
      });
      if (changed) persist();
    }
    render();
  }

  function persist() {
    writeStorage(STORAGE_KEY, {
      mode: state.mode,
      seats: state.seats
    });
  }

  function seatPayload() {
    return state.seats.map((seat, index) => {
      const kind = normalizeKind(seat.kind, state.mode, index);
      const defaultName = kind === 'human'
        ? t('setup.presetPlayer', { n: index + 1 })
        : kind === 'ai'
          ? (seat.engine === 'llm' ? t('engine.llm') : t('setup.presetAi'))
          : t('setup.presetAgent');
      const name = seat.name.trim() || defaultName;
      const payload = { name: name, kind: kind };
      if (kind === 'ai') {
        payload.difficulty = seat.difficulty;
        payload.engine = seat.engine === 'llm' ? 'llm' : 'local';
      }
      return payload;
    });
  }

  function validate() {
    const seats = seatPayload();
    if (state.mode === 'ai') {
      const external = seats.filter((seat) => seat.kind !== 'ai').length;
      const ai = seats.filter((seat) => seat.kind === 'ai').length;
      if (external < 1 || ai < 1) return t('setup.validationAi');
    }
    if (state.mode === 'arena') {
      if (seats.some((seat) => seat.kind === 'human')) return t('setup.validationArena');
      if (!seats.some((seat) => seat.kind === 'agent')) return t('setup.validationArena');
    }
    if (seats.some((seat) => seat.kind === 'ai' && seat.engine === 'llm')) {
      if (!aiConfig.available || (!aiConfig.configured && !aiConfig.sharedAvailable)) return t('setup.validationLlm');
    }
    return '';
  }

  async function startGame() {
    if (busy) return;
    const validation = validate();
    if (validation) {
      errorMessage = validation;
      errorDetail = '';
      render();
      return;
    }
    busy = true;
    errorMessage = '';
    errorDetail = '';
    persist();
    render();
    try {
      const response = await api.createGame({
        mode: state.mode,
        playerCount: PLAYER_COUNT,
        seats: seatPayload()
      });
      const game = response && response.game;
      if (!game || !game.id) throw new Error('Missing game in response');
      navigate('/game/' + encodeURIComponent(game.id));
    } catch (error) {
      busy = false;
      errorMessage = t('setup.error');
      errorDetail = describeError(error);
      render();
    }
  }

  function renderModeCard() {
    const cards = MODES.map((mode) => {
      const meta = MODE_META[mode];
      const isActive = mode === state.mode;
      return h('button', {
        type: 'button',
        class: 'mode-card' + (isActive ? ' is-active' : ''),
        'aria-pressed': isActive ? 'true' : 'false',
        onclick: () => {
          if (state.mode === mode) return;
          state.mode = mode;
          state.seats = seatsForMode(state.seats, mode);
          errorMessage = '';
          errorDetail = '';
          persist();
          render();
        }
      },
        h('span', { class: 'mode-card-icon', 'aria-hidden': 'true' }, icon(meta.icon, 18)),
        h('span', { class: 'mode-card-title' }, t('mode.' + mode)),
        h('span', { class: 'mode-card-desc' }, t(meta.cardKey))
      );
    });
    return sectionCard({
      title: t('setup.modeLabel'),
      description: t('setup.subtitle'),
      content: h('div', null,
        h('div', { class: 'mode-cards mode-cards--four' }, cards),
        h('p', { class: 'mode-hint' }, t(MODE_META[state.mode].hintKey))
      )
    });
  }

  function kindOptions(mode) {
    if (mode === 'arena') return ['agent', 'ai'];
    if (mode === 'local') return ['human'];
    if (mode === 'selfplay') return ['ai'];
    return ['human', 'ai', 'agent'];
  }

  function seatRow(index) {
    const seat = state.seats[index];
    const color = seatColor(index);
    const options = kindOptions(state.mode);
    const kind = normalizeKind(seat.kind, state.mode, index);
    const forced = options.length === 1;
    const isAi = kind === 'ai';
    const isAgent = kind === 'agent';

    const nameInput = h('input', {
      class: 'input',
      type: 'text',
      maxlength: 32,
      value: seat.name,
      placeholder: isAi
        ? (seat.engine === 'llm' ? t('engine.llm') : t('setup.presetAi'))
        : isAgent ? t('setup.presetAgent') : t('setup.presetPlayer', { n: index + 1 }),
      'aria-label': t('setup.seatLabel', { letter: seatLetter(index) }) + ' · ' + t('setup.nameLabel'),
      oninput: (event) => {
        state.seats[index].name = event.target.value;
        persist();
      }
    });

    const kindIcon = (value) => (value === 'ai' ? 'cpu' : value === 'agent' ? 'robot' : 'user');
    const kindSelect = forced
      ? h('div', { class: 'static-kind', 'aria-label': t('setup.kindLabel') },
          icon(kindIcon(kind), 14),
          t('kind.' + kind)
        )
      : h('select', {
          class: 'select',
          'aria-label': t('setup.seatLabel', { letter: seatLetter(index) }) + ' · ' + t('setup.kindLabel'),
          onchange: (event) => {
            state.seats[index].kind = normalizeKind(event.target.value, state.mode, index);
            errorMessage = '';
            persist();
            render();
          }
        },
          options.map((value) => h('option', {
            value: value,
            selected: kind === value ? '' : null
          }, t('kind.' + value)))
        );

    const engineAvailable = aiConfig.available && (aiConfig.configured || aiConfig.sharedAvailable) && !aiConfig.loading;
    const engine = seat.engine === 'llm' && engineAvailable ? 'llm' : 'local';

    const engineField = isAi
      ? field({
          label: t('setup.engineLabel'),
          hint: engine === 'llm' ? t('setup.engineHint') : null,
          control: h('select', {
            class: 'select',
            'aria-label': t('setup.seatLabel', { letter: seatLetter(index) }) + ' · ' + t('setup.engineLabel'),
            disabled: aiConfig.loading ? '' : null,
            onchange: (event) => {
              state.seats[index].engine = event.target.value === 'llm' ? 'llm' : 'local';
              persist();
              render();
            }
          },
            h('option', { value: 'local', selected: engine === 'local' ? '' : null }, t('engine.local')),
            h('option', {
              value: 'llm',
              selected: engine === 'llm' ? '' : null,
              disabled: engineAvailable ? null : ''
            }, engineAvailable ? t('engine.llm') : t('engine.llm') + ' · ' + t('setup.engineLlmDisabled'))
          )
        })
      : null;

    const difficultyField = isAi
      ? field({
          label: t('setup.difficultyLabel'),
          control: h('select', {
            class: 'select',
            'aria-label': t('setup.seatLabel', { letter: seatLetter(index) }) + ' · ' + t('setup.difficultyLabel'),
            onchange: (event) => {
              state.seats[index].difficulty = event.target.value;
              persist();
            }
          }, DIFFICULTIES.map((difficulty) => h('option', {
            value: difficulty,
            selected: seat.difficulty === difficulty ? '' : null
          }, t('difficulty.' + difficulty))))
        })
      : null;

    const extraFields = [];
    if (engineField) extraFields.push(engineField);
    if (difficultyField) extraFields.push(difficultyField);

    return h('div', { class: 'seat-row' + (isAi ? ' seat-row--ai' : '') + (isAgent ? ' seat-row--agent' : '') + (engine === 'llm' ? ' seat-row--llm' : '') },
      h('span', { class: 'seat-row-letter seat-row-letter--' + color, 'aria-hidden': 'true' }, seatLetter(index)),
      h('div', { class: 'seat-row-fields' },
        field({
          label: t('setup.nameLabel'),
          control: nameInput
        }),
        field({
          label: t('setup.kindLabel'),
          control: kindSelect
        })
      ),
      extraFields.length ? h('div', { class: 'seat-row-extra' }, extraFields) : null
    );
  }

  function aiNotice() {
    const payloadSeats = seatPayload();
    const aiCount = payloadSeats.filter((seat) => seat.kind === 'ai').length;
    if (!aiCount) return null;
    let text = '';
    let tone = 'notice--warn';
    if (!aiConfig.available) {
      text = t('settingsAi.disabled');
    } else if (aiConfig.loading) {
      text = t('common.loading');
      tone = 'notice';
    } else if (!aiConfig.configured && !aiConfig.sharedAvailable) {
      text = t('setup.engineNotConfigured');
    } else if (!aiConfig.configured) {
      text = t('setup.engineShared');
      tone = 'notice';
    } else {
      return null;
    }
    return h('div', { class: 'notice ' + tone },
      icon(aiConfig.loading ? 'info' : 'alert', 15),
      h('span', { class: 'flex-1' }, text),
      aiConfig.available && !aiConfig.loading
        ? h('a', { class: 'btn btn--ghost btn--sm', href: '#/settings' }, icon('settings', 14), t('setup.engineConfigure'))
        : null
    );
  }

  function ruleFacts() {
    const facts = [
      { label: t('setup.ruleBoard'), value: t('setup.ruleBoardValue', { n: boardSize }), icon: 'grid' },
      { label: t('setup.ruleFirst'), value: t('setup.ruleFirstValue', { n: firstTurnStones }), icon: 'stone' },
      { label: t('setup.ruleTurn'), value: t('setup.ruleTurnValue', { n: stonesPerTurn }), icon: 'layers' },
      { label: t('setup.ruleWin'), value: t('setup.ruleWinValue', { n: winLength }), icon: 'trophy' }
    ];
    return h('div', { class: 'rule-facts' }, facts.map((fact) => h('div', { class: 'rule-fact' },
      h('span', { class: 'rule-fact-icon', 'aria-hidden': 'true' }, icon(fact.icon, 14)),
      h('span', { class: 'rule-fact-label' }, fact.label),
      h('strong', { class: 'rule-fact-value' }, fact.value)
    )));
  }

  function renderSeatsCard() {
    const validation = errorMessage;
    return sectionCard({
      title: t('setup.seats'),
      description: t('setup.rulesHint'),
      content: h('div', { class: 'stack-16' },
        h('div', { class: 'player-count-row' },
          h('span', { class: 'player-count-label' }, t('setup.playerCount')),
          h('span', { class: 'player-count-fixed' }, t('history.playersCount', { n: PLAYER_COUNT })),
          h('span', { class: 'piece-hint' }, t('setup.playerCountFixed'))
        ),
        h('div', { class: 'seat-list' }, state.seats.map((seat, index) => seatRow(index))),
        aiNotice(),
        validation
          ? h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 15), h('span', null, validation))
          : null,
        errorDetail
          ? h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 15), h('span', null, errorDetail))
          : null
      )
    });
  }

  function renderActions() {
    return h('div', { class: 'form-actions' },
      h('button', {
        type: 'button',
        class: 'btn btn--primary btn--lg',
        onclick: startGame,
        disabled: busy ? '' : null
      },
        busy ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('play', 16),
        busy ? t('setup.starting') : t('setup.start')
      ),
      h('a', { class: 'btn btn--ghost btn--lg', href: '#/' }, t('common.back'))
    );
  }

  function renderFlowCard() {
    const items = [
      { icon: 'stone', text: t('home.step1Desc') },
      { icon: 'layers', text: t('home.step2Desc') },
      { icon: 'trophy', text: t('home.step3Desc') }
    ];
    return sectionCard({
      title: t('setup.rulesCardTitle'),
      content: h('div', { class: 'rules-mini' },
        items.map((item) => h('div', { class: 'rules-mini-item' },
          h('span', { class: 'rules-mini-icon', 'aria-hidden': 'true' }, icon(item.icon, 15)),
          h('span', null, item.text)
        ))
      )
    });
  }

  function renderRulesCard() {
    return sectionCard({
      title: t('setup.ruleSummaryTitle'),
      content: h('div', { class: 'stack-12' },
        ruleFacts(),
        h('p', { class: 'faint', style: { fontSize: '11px', lineHeight: '1.6' } }, t('setup.ruleNote'))
      )
    });
  }

  function renderSummary() {
    const seats = seatPayload();
    const humans = seats.filter((seat) => seat.kind === 'human').length;
    const ai = seats.filter((seat) => seat.kind === 'ai').length;
    const agents = seats.filter((seat) => seat.kind === 'agent').length;
    return h('div', { class: 'setup-summary' },
      h('div', { class: 'setup-summary-row' },
        h('span', null, t('setup.modeLabel')),
        h('strong', null, t('mode.' + state.mode))
      ),
      h('div', { class: 'setup-summary-row' },
        h('span', null, t('common.players')),
        h('strong', null, t('history.playersCount', { n: PLAYER_COUNT }))
      ),
      h('div', { class: 'setup-summary-row' },
        h('span', null, t('common.seats')),
        h('strong', null, t('kind.human') + ' ' + humans + ' · ' + t('kind.ai') + ' ' + ai + (agents ? ' · ' + t('kind.agent') + ' ' + agents : ''))
      ),
      ai > 0
        ? h('div', { class: 'setup-summary-row' },
            h('span', null, t('setup.engineSummary')),
            h('strong', null, t('engine.localShort') + ' ' + seats.filter((seat) => seat.kind === 'ai' && seat.engine !== 'llm').length + ' · ' + t('engine.llmShort') + ' ' + seats.filter((seat) => seat.kind === 'ai' && seat.engine === 'llm').length)
          )
        : null,
      h('div', { class: 'setup-summary-row' },
        h('span', null, t('setup.ruleVersion')),
        h('strong', { class: 'mono', style: { fontSize: '10px' } }, ruleVersion)
      )
    );
  }

  function render() {
    clear(container);
    container.appendChild(pageHeader({
      eyebrow: t('setup.eyebrow'),
      title: t('setup.title'),
      subtitle: t('setup.subtitle')
    }));
    const main = h('div', { class: 'setup-main' },
      renderModeCard(),
      renderSeatsCard(),
      renderActions()
    );
    const aside = h('aside', { class: 'setup-aside' },
      renderSummary(),
      renderRulesCard(),
      renderFlowCard()
    );
    container.appendChild(h('div', { class: 'setup-layout' }, main, aside));
  }

  render();
  loadAiConfig();

  return function cleanup() {
    disposed = true;
  };
}
