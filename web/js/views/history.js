/**
 * Game history: filterable list from the API with open, replay, export and
 * delete actions plus pagination.
 */
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { api, saveBlob } from '../core/api.js';
import {
  pageHeader,
  describeError,
  emptyState,
  errorState,
  skeletonLines,
  skeletonCards,
  segmented,
  confirmDialog,
  toast
} from '../core/ui.js';
import { navigate } from '../core/router.js';
import { getSession, requiresAuth, isSignedIn } from '../core/store.js';
import { formatDate } from '../core/format.js';
import {
  modeBadge,
  statusBadge,
  playersInline,
  resultChips,
  winnerLabel,
  gamePath,
  gameFinishMeta,
  isAuthError,
  authRequiredState
} from './common.js';

const PAGE_SIZE = 20;
const MODE_FILTERS = ['all', 'local', 'ai', 'selfplay', 'online'];

export async function mount(container, route) {
  const query = (route && route.query) || {};
  let mode = MODE_FILTERS.indexOf(query.mode) !== -1 ? query.mode : 'all';
  let offset = 0;
  let games = [];
  let total = 0;
  let loading = true;
  let error = null;
  let disposed = false;
  let requestToken = 0;
  let openDropdown = null;
  const authBlocked = requiresAuth() && !isSignedIn();

  function closeDropdown() {
    if (openDropdown && openDropdown.parentNode) openDropdown.remove();
    openDropdown = null;
  }

  function onDocumentClick(event) {
    if (!openDropdown) return;
    const menuButton = event.target.closest('[data-export-toggle]');
    if (menuButton) return;
    if (openDropdown.contains(event.target)) return;
    closeDropdown();
  }

  document.addEventListener('click', onDocumentClick);

  async function fetchGames() {
    if (authBlocked) {
      loading = false;
      games = [];
      total = 0;
      render();
      return;
    }
    const token = ++requestToken;
    loading = true;
    error = null;
    render();
    try {
      const params = { limit: PAGE_SIZE, offset: offset };
      if (mode !== 'all') params.mode = mode;
      const data = await api.listGames(params);
      if (disposed || token !== requestToken) return;
      games = data && Array.isArray(data.games) ? data.games : [];
      total = data && typeof data.total === 'number' ? data.total : games.length;
      loading = false;
      render();
    } catch (err) {
      if (disposed || token !== requestToken) return;
      loading = false;
      error = err;
      games = [];
      render();
    }
  }

  function pageNumber() {
    return Math.floor(offset / PAGE_SIZE) + 1;
  }

  function totalPages() {
    return Math.max(1, Math.ceil(total / PAGE_SIZE));
  }

  async function deleteGame(game) {
    const confirmed = await confirmDialog({
      title: t('history.deleteTitle'),
      description: t('history.deleteBody'),
      confirmLabel: t('history.delete'),
      danger: true
    });
    if (!confirmed) return;
    try {
      await api.deleteGame(game.id);
      toast(t('history.deleted'), { type: 'success' });
      if (games.length === 1 && offset > 0) offset = Math.max(0, offset - PAGE_SIZE);
      fetchGames();
    } catch (err) {
      toast(describeError(err), { type: 'error' });
    }
  }

  async function exportGame(game, format) {
    closeDropdown();
    try {
      const file = await api.download(api.exportUrl(game.id, format));
      saveBlob(file.blob, file.filename);
    } catch (err) {
      toast(describeError(err), { type: 'error' });
    }
  }

  function exportMenu(game) {
    const panel = h('div', { class: 'dropdown-panel', role: 'menu' },
      h('button', { type: 'button', class: 'dropdown-item', role: 'menuitem', onclick: () => exportGame(game, 'json') },
        icon('download', 14), t('history.exportJson')),
      h('button', { type: 'button', class: 'dropdown-item', role: 'menuitem', onclick: () => exportGame(game, 'md') },
        icon('download', 14), t('history.exportMd')),
      h('button', { type: 'button', class: 'dropdown-item', role: 'menuitem', onclick: () => exportGame(game, 'txt') },
        icon('download', 14), t('history.exportTxt'))
    );
    const wrapper = h('div', { class: 'dropdown-menu' });
    const button = h('button', {
      type: 'button',
      class: 'icon-btn',
      'aria-label': t('common.export'),
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'data-export-toggle': 'true',
      onclick: (event) => {
        event.stopPropagation();
        if (openDropdown && openDropdown.parentNode && wrapper.contains(openDropdown)) {
          closeDropdown();
          button.setAttribute('aria-expanded', 'false');
          return;
        }
        closeDropdown();
        wrapper.appendChild(panel);
        openDropdown = panel;
        button.setAttribute('aria-expanded', 'true');
      }
    }, icon('download', 16));
    wrapper.appendChild(button);
    return wrapper;
  }

  function resultCell(game) {
    if (!game.result) {
      return h('span', { class: 'faint', style: { fontSize: '11.5px' } }, t('history.noResult'));
    }
    return h('div', { class: 'history-result' },
      h('span', { class: 'history-result-winner' }, icon('trophy', 13), winnerLabel(game)),
      resultChips(game)
    );
  }

  function buildRow(game) {
    return h('tr', null,
      h('td', null,
        h('a', { class: 'history-date', href: '#' + gamePath(game) }, formatDate(game.createdAt)),
        h('div', { class: 'history-id' }, game.id || '')
      ),
      h('td', null,
        h('div', { class: 'stack-8', style: { gap: '5px' } },
          modeBadge(game.mode),
          h('span', { class: 'faint', style: { fontSize: '10.5px' } }, t('history.playersCount', { n: game.playerCount || (game.players || []).length }))
        )
      ),
      h('td', null, playersInline(game.players || [])),
      h('td', null, statusBadge(game.status)),
      h('td', null, resultCell(game)),
      h('td', null,
        h('div', { class: 'cell-actions' },
          h('a', {
            class: 'btn btn--ghost btn--sm',
            href: '#' + gamePath(game),
            'aria-label': t('history.open') + ' ' + (game.id || '')
          }, icon('arrowRight', 14), t('history.open')),
          game.status === 'finished'
            ? h('button', {
                type: 'button',
                class: 'icon-btn',
                'aria-label': t('history.replay') + ' ' + (game.id || ''),
                title: t('history.replay'),
                onclick: () => navigate('/replay/' + encodeURIComponent(game.id))
              }, icon('play', 15))
            : null,
          exportMenu(game),
          h('button', {
            type: 'button',
            class: 'icon-btn',
            'aria-label': t('history.delete') + ' ' + (game.id || ''),
            title: t('history.delete'),
            onclick: () => deleteGame(game)
          }, icon('trash', 15))
        )
      )
    );
  }

  function buildTable() {
    if (authBlocked) return authRequiredState(t('history.emptyDesc'));
    if (loading) {
      return h('div', { class: 'card' }, h('div', { class: 'card-body' }, skeletonLines(4)));
    }
    if (error) {
      return isAuthError(error)
        ? authRequiredState(t('history.emptyDesc'))
        : errorState({ title: t('history.error'), error: error, onRetry: fetchGames });
    }
    if (!games.length) {
      return emptyState({
        icon: 'history',
        title: t('history.empty'),
        description: t('history.emptyDesc'),
        action: h('a', { class: 'btn btn--primary btn--sm', href: '#/local' }, icon('swords', 15), t('setup.start'))
      });
    }
    const table = h('table', { class: 'data-table history-table' },
      h('caption', null, t('history.title')),
      h('thead', null,
        h('tr', null,
          h('th', null, t('history.colDate')),
          h('th', null, t('history.colMode')),
          h('th', null, t('history.colPlayers')),
          h('th', null, t('history.colStatus')),
          h('th', null, t('history.colResult')),
          h('th', { style: { textAlign: 'right' } }, t('history.colActions'))
        )
      ),
      h('tbody', null, games.map(buildRow))
    );
    return h('div', { class: 'history-table-wrap' }, h('div', { class: 'table-wrap' }, table));
  }

  function buildPagination() {
    if (loading || error || total <= PAGE_SIZE) return null;
    return h('div', { class: 'pagination' },
      h('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        disabled: pageNumber() <= 1 ? '' : null,
        onclick: () => {
          offset = Math.max(0, offset - PAGE_SIZE);
          fetchGames();
        }
      }, icon('chevronLeft', 14), t('history.prevPage')),
      h('span', { class: 'pagination-info' }, t('history.pageInfo', { page: pageNumber(), total: totalPages() })),
      h('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        disabled: pageNumber() >= totalPages() ? '' : null,
        onclick: () => {
          offset = offset + PAGE_SIZE;
          fetchGames();
        }
      }, t('history.nextPage'), icon('chevronRight', 14))
    );
  }

  function render() {
    if (disposed) return;
    closeDropdown();
    clear(container);
    container.appendChild(pageHeader({
      eyebrow: t('playtest.gamesTitle'),
      title: t('history.title'),
      subtitle: t('history.subtitle'),
      actions: [
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: fetchGames }, icon('refresh', 15), t('common.refresh')),
        h('a', { class: 'btn btn--primary btn--sm', href: '#/local' }, icon('plus', 15), t('home.ctaLocal'))
      ]
    }));
    container.appendChild(h('div', { class: 'history-toolbar' },
      h('div', { class: 'history-toolbar-left' },
        h('span', { class: 'player-count-label' }, t('history.filterMode')),
        segmented({
          size: 'sm',
          ariaLabel: t('history.filterMode'),
          value: mode,
          options: MODE_FILTERS.map((value) => ({
            value: value,
            label: value === 'all' ? t('history.filterAll') : t('mode.' + value)
          })),
          onChange: (value) => {
            mode = value;
            offset = 0;
            fetchGames();
          }
        })
      ),
      h('div', { class: 'history-toolbar-right' },
        h('span', { class: 'chip mono' }, t('history.totalCount', { n: total }))
      )
    ));
    container.appendChild(buildTable());
    const pagination = buildPagination();
    if (pagination) container.appendChild(pagination);
  }

  render();
  fetchGames();

  return function cleanup() {
    disposed = true;
    document.removeEventListener('click', onDocumentClick);
    closeDropdown();
  };
}
