/**
 * Online landing view: create a room, join by code, and recent online games.
 */
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { getSession, requiresAuth, isSignedIn } from '../core/store.js';
import { api } from '../core/api.js';
import {
  pageHeader,
  sectionCard,
  segmented,
  describeError,
  emptyState,
  errorState,
  skeletonCards
} from '../core/ui.js';
import { navigate } from '../core/router.js';
import { formatDate } from '../core/format.js';
import { modeBadge, statusBadge, playersInline, resultChips, gamePath } from './common.js';

const ROOM_CODE_PATTERN = /^[A-Z0-9]{4}$/;

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

function authNotice() {
  return h('div', { class: 'online-auth-note' },
    icon('lock', 17),
    h('span', { class: 'flex-1' },
      h('strong', { style: { display: 'block', marginBottom: '2px' } }, t('online.needLogin')),
      t('online.needLoginDesc')
    ),
    h('a', { class: 'btn btn--primary btn--sm', href: '#/login?next=%23%2Fonline' }, t('auth.loginTitle')),
    h('a', { class: 'btn btn--ghost btn--sm', href: '#/register' }, t('auth.registerTitle'))
  );
}

export async function mount(container, route) {
  const session = getSession();
  const features = session.features || {};
  let disposed = false;
  let createCount = 2;
  let joinCode = '';
  let busyCreate = false;
  let busyJoin = false;
  let createError = '';
  let joinError = '';
  const authNeeded = requiresAuth() && !isSignedIn();

  function createRoom() {
    if (busyCreate || authNeeded) return;
    busyCreate = true;
    createError = '';
    render();
    api.createGame({ mode: 'online', playerCount: createCount })
      .then((response) => {
        const game = response && response.game;
        if (!game || !game.id) throw new Error('Missing game');
        navigate('/online/' + encodeURIComponent(game.id));
      })
      .catch((error) => {
        busyCreate = false;
        createError = describeError(error);
        render();
      });
  }

  function joinRoom() {
    if (busyJoin || authNeeded) return;
    const code = normalizeCode(joinCode);
    if (!ROOM_CODE_PATTERN.test(code)) {
      joinError = t('online.invalidCode');
      render();
      return;
    }
    busyJoin = true;
    joinError = '';
    render();
    api.joinGame(code)
      .then((response) => {
        const game = response && response.game;
        if (!game || !game.id) throw new Error('Missing game');
        navigate('/online/' + encodeURIComponent(game.id));
      })
      .catch((error) => {
        busyJoin = false;
        joinError = error && error.code === 'ROOM_NOT_FOUND' ? t('online.roomNotFound') : describeError(error);
        render();
      });
  }

  function renderCreateCard() {
    return sectionCard({
      title: t('online.createTitle'),
      description: t('online.createDesc'),
      content: h('div', { class: 'stack-16' },
        h('div', null,
          h('div', { class: 'player-count-label', style: { marginBottom: '8px' } }, t('online.playerCount')),
          segmented({
            block: true,
            ariaLabel: t('online.playerCount'),
            value: createCount,
            options: [2, 3, 4].map((count) => ({ value: count, label: t('setup.playerCountOption', { n: count }) })),
            onChange: (value) => {
              createCount = Number(value);
              render();
            }
          })
        ),
        createError ? h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 15), h('span', null, createError)) : null,
        h('div', null,
          h('button', {
            type: 'button',
            class: 'btn btn--primary btn--block',
            onclick: createRoom,
            disabled: busyCreate || authNeeded ? '' : null
          },
            busyCreate ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('plus', 16),
            busyCreate ? t('online.creating') : t('online.create')
          )
        ),
        h('p', { class: 'mode-hint' }, iconText(t('online.shareHint')))
      )
    });
  }

  function iconText(text) {
    return h('span', { class: 'icon-text', style: { alignItems: 'flex-start' } },
      h('span', { class: 'icon-text-icon', style: { marginTop: '2px' } }, icon('info', 13)),
      h('span', null, text)
    );
  }

  function renderJoinCard() {
    const input = h('input', {
      class: 'input input--code',
      type: 'text',
      inputmode: 'latin',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      maxlength: 4,
      placeholder: t('online.codePlaceholder'),
      'aria-label': t('online.codeLabel'),
      value: joinCode,
      oninput: (event) => {
        joinCode = normalizeCode(event.target.value);
        event.target.value = joinCode;
        if (joinError) {
          joinError = '';
        }
      },
      onkeydown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          joinRoom();
        }
      }
    });
    return sectionCard({
      title: t('online.joinTitle'),
      description: t('online.joinDesc'),
      content: h('div', { class: 'stack-16' },
        h('div', { class: 'code-input-row' },
          input,
          h('button', {
            type: 'button',
            class: 'btn btn--secondary',
            onclick: joinRoom,
            disabled: busyJoin || authNeeded ? '' : null
          },
            busyJoin ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('arrowRight', 16),
            busyJoin ? t('online.joining') : t('online.join')
          )
        ),
        joinError ? h('div', { class: 'form-banner', role: 'alert' }, icon('alert', 15), h('span', null, joinError)) : null,
        h('p', { class: 'mode-hint' }, iconText(t('online.shareHint')))
      )
    });
  }

  const recentBody = h('div', { class: 'recent-games' });
  let recentDisposed = false;

  function recentCard(game) {
    return h('a', { class: 'recent-card', href: '#' + gamePath(game) },
      h('div', { class: 'recent-card-top' },
        h('span', { class: 'row', style: { gap: '6px' } }, modeBadge(game.mode), statusBadge(game.status)),
        h('span', { class: 'faint mono', style: { fontSize: '10px' } }, formatDate(game.createdAt))
      ),
      playersInline(game.players || []),
      resultChips(game) || h('span', { class: 'muted', style: { fontSize: '12px' } }, game.roomCode ? '#' + game.roomCode : ''),
      h('div', { class: 'recent-footer' },
        h('span', null, game.roomCode ? t('online.roomCode') + ' ' + game.roomCode : t('history.playersCount', { n: game.playerCount || 0 })),
        h('span', null, game.status === 'lobby' ? t('online.waitingStart') : '')
      )
    );
  }

  async function loadRecent() {
    clear(recentBody);
    recentBody.appendChild(skeletonCards(2));
    try {
      const data = await api.listGames({ mode: 'online', limit: 4 });
      if (disposed || recentDisposed) return;
      clear(recentBody);
      const games = data && Array.isArray(data.games) ? data.games : [];
      if (!games.length) {
        recentBody.appendChild(h('div', { style: { gridColumn: '1 / -1' } },
          emptyState({
            icon: 'globe',
            title: t('online.recentEmpty'),
            description: t('online.subtitle')
          })
        ));
        return;
      }
      for (const game of games) recentBody.appendChild(recentCard(game));
    } catch (error) {
      if (disposed || recentDisposed) return;
      clear(recentBody);
      recentBody.appendChild(h('div', { style: { gridColumn: '1 / -1' } },
        errorState({ title: t('common.error'), error: error, onRetry: loadRecent })
      ));
    }
  }

  function render() {
    clear(container);
    container.appendChild(pageHeader({
      eyebrow: t('online.eyebrow'),
      title: t('online.title'),
      subtitle: t('online.subtitle')
    }));
    if (features.online === false) {
      container.appendChild(h('div', { class: 'notice notice--warn' },
        icon('alert', 16),
        h('span', null, t('common.error') + ' · ' + t('online.createError'))
      ));
    }
    if (authNeeded) container.appendChild(authNotice());
    container.appendChild(h('div', { class: 'online-layout' },
      h('div', { class: 'online-panel' }, renderCreateCard()),
      h('div', { class: 'online-panel' }, renderJoinCard())
    ));
    container.appendChild(h('section', { class: 'stack-16' },
      h('div', { class: 'home-section-head' },
        h('div', null,
          h('h2', { class: 'home-section-title' }, t('online.recentOnline')),
          h('p', { class: 'home-section-desc' }, t('online.subtitle'))
        ),
        h('a', { class: 'link-more', href: '#/history' }, t('common.viewAll'), icon('arrowRight', 14))
      ),
      recentBody
    ));
  }

  render();
  loadRecent();
  return function cleanup() {
    disposed = true;
    recentDisposed = true;
  };
}
