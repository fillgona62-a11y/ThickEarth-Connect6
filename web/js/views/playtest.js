/**
 * Playtest dashboard: aggregate metrics, distribution charts, CSV export and
 * per-game hardest-decision notes.
 */
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { api, saveBlob } from '../core/api.js';
import {
  pageHeader,
  sectionCard,
  statCard,
  describeError,
  errorState,
  loadingBlock,
  skeletonCards,
  openDialog,
  toast
} from '../core/ui.js';
import { formatDate, formatDuration, formatNumber, formatPercent, endReasonLabel } from '../core/format.js';
import { getSession, requiresAuth, isSignedIn } from '../core/store.js';
import { modeBadge, humanKey, firstNumber, isAuthError, authRequiredState } from './common.js';

function durationOrDash(value) {
  return typeof value === 'number' ? formatDuration(value) : undefined;
}

export async function mount(container, route) {
  let disposed = false;
  let loading = true;
  let summary = null;
  let summaryError = null;
  let games = [];
  let gamesLoading = true;
  let gamesError = null;
  const noteCache = new Map();
  let busyNoteId = '';
  const authBlocked = requiresAuth() && !isSignedIn();

  function metricsView(model) {
    if (!model) return null;
    const totals = model.totals || {};
    const averages = model.averages || {};
    const gameCount = firstNumber(model, ['gameCount', 'completedGames', 'games']) || 0;
    const avgDuration = firstNumber(averages, ['durationMs']);
    const winRate = firstNumber(model, ['firstPlayerWinRate', 'firstPlayerWinrate']);
    const noteCount = firstNumber(model, ['noteCount']) || 0;
    const avgTurns = firstNumber(averages, ['turns']);
    const avgDecisions = firstNumber(averages, ['decisions']);
    const avgStones = firstNumber(averages, ['stones']);
    const avgWinLine = firstNumber(averages, ['winningLineLength']);
    return {
      gameCount: gameCount,
      avgDuration: durationOrDash(avgDuration),
      avgTurns: typeof avgTurns === 'number' ? formatNumber(avgTurns) : undefined,
      avgDecisions: typeof avgDecisions === 'number' ? formatNumber(avgDecisions) : undefined,
      avgStones: typeof avgStones === 'number' ? formatNumber(avgStones) : undefined,
      avgWinLine: typeof avgWinLine === 'number' ? formatNumber(avgWinLine) : undefined,
      totalDecisions: typeof totals.decisions === 'number' ? formatNumber(totals.decisions) : undefined,
      winRate: typeof winRate === 'number' ? formatPercent(winRate) : undefined,
      noteCount: noteCount,
      endReasons: model.endReasons || {},
      byPlayerCount: model.byPlayerCount || {}
    };
  }

  async function exportCsv() {
    try {
      const file = await api.download(api.playtestExportUrl());
      saveBlob(file.blob, file.filename);
    } catch (error) {
      toast(describeError(error), { type: 'error' });
    }
  }

  function distributionList(map, labelFor) {
    const entries = Object.keys(map || {})
      .map((key) => ({ key: key, value: map[key] }))
      .filter((entry) => typeof entry.value === 'number');
    if (!entries.length) {
      return h('p', { class: 'faint', style: { fontSize: '12px' } }, t('playtest.noData'));
    }
    entries.sort((a, b) => b.value - a.value);
    const max = Math.max.apply(null, entries.map((entry) => entry.value).concat([1]));
    return h('div', { class: 'distribution-list' },
      entries.map((entry) => h('div', { class: 'distribution-row' },
        h('span', { class: 'distribution-label', title: labelFor(entry.key) }, labelFor(entry.key)),
        h('div', { class: 'progress' },
          h('span', { class: 'progress-fill', style: { width: Math.round((entry.value / max) * 100) + '%' } })
        ),
        h('span', { class: 'distribution-value' }, String(entry.value))
      ))
    );
  }

  function endReasonLabelFor(key) {
    const value = endReasonLabel(key);
    return value === key ? humanKey(key) : value;
  }

  function buildSummarySection() {
    const body = h('div', { class: 'stack-20' });
    if (authBlocked) {
      body.appendChild(authRequiredState(t('playtest.subtitle')));
      return body;
    }
    if (summaryError && isAuthError(summaryError)) {
      body.appendChild(authRequiredState(t('playtest.subtitle')));
      return body;
    }
    if (summaryError) {
      body.appendChild(errorState({ title: t('playtest.loadError'), error: summaryError, onRetry: loadSummary }));
      return body;
    }
    if (loading) {
      body.appendChild(skeletonCards(4));
      return body;
    }
    const view = metricsView(summary) || {};
    const stats = h('div', { class: 'stat-grid' },
      statCard({ label: t('playtest.completedGames'), value: view.gameCount, icon: 'flag', tone: 'amber' }),
      statCard({ label: t('playtest.avgDuration'), value: view.avgDuration, icon: 'clock' }),
      statCard({ label: t('playtest.avgTurns'), value: view.avgTurns, icon: 'layers' }),
      statCard({ label: t('playtest.avgDecisions'), value: view.avgDecisions, icon: 'grid' }),
      statCard({ label: t('playtest.avgStones'), value: view.avgStones, icon: 'seat' }),
      statCard({ label: t('playtest.firstPlayerWinRate'), value: view.winRate, icon: 'trophy', tone: 'jade' })
    );
    body.appendChild(stats);
    const averagesRows = [
      { key: t('playtest.avgTurns'), value: view.avgTurns },
      { key: t('playtest.avgDecisions'), value: view.avgDecisions },
      { key: t('playtest.avgStones'), value: view.avgStones },
      { key: t('playtest.avgWinLine'), value: view.avgWinLine },
      { key: t('playtest.totalDecisions'), value: view.totalDecisions }
    ].filter((row) => row.value !== undefined);

    const distributions = h('div', { class: 'grid-2' },
      sectionCard({
        title: t('playtest.endReasons'),
        content: distributionList(view.endReasons, endReasonLabelFor)
      }),
      sectionCard({
        title: t('playtest.averages'),
        content: averagesRows.length
          ? h('div', { class: 'kv-list' }, averagesRows.map((row) => h('div', { class: 'kv-row' },
              h('span', { class: 'kv-key' }, row.key),
              h('span', { class: 'kv-value mono' }, String(row.value))
            )))
          : h('p', { class: 'faint', style: { fontSize: '12px' } }, t('playtest.noData'))
      })
    );
    body.appendChild(distributions);
    if (view.noteCount) {
      body.appendChild(h('div', { class: 'notice' }, icon('info', 15),
        h('span', null, t('game.noteTitle') + ': ' + String(view.noteCount))
      ));
    }
    body.appendChild(h('details', { class: 'faint', style: { fontSize: '11px' } },
      h('summary', { style: { cursor: 'pointer' } }, t('playtest.rawSummary')),
      h('pre', { class: 'raw-json' }, JSON.stringify(summary, null, 2))
    ));
    return body;
  }

  async function loadSummary() {
    if (authBlocked) {
      loading = false;
      summaryError = null;
      render();
      return;
    }
    loading = true;
    summaryError = null;
    render();
    try {
      const data = await api.playtestSummary();
      if (disposed) return;
      summary = data || {};
      loading = false;
      render();
    } catch (error) {
      if (disposed) return;
      loading = false;
      summaryError = error;
      render();
    }
  }

  async function loadGames() {
    if (authBlocked) {
      gamesLoading = false;
      gamesError = null;
      render();
      return;
    }
    gamesLoading = true;
    gamesError = null;
    render();
    try {
      const data = await api.listGames({ limit: 50, offset: 0 });
      if (disposed) return;
      games = (data && Array.isArray(data.games) ? data.games : []).filter((game) => game.status === 'finished');
      gamesLoading = false;
      render();
    } catch (error) {
      if (disposed) return;
      gamesLoading = false;
      gamesError = error;
      render();
    }
  }

  async function fetchExistingNote(game) {
    try {
      const file = await api.download(api.exportUrl(game.id, 'json'));
      const text = await file.blob.text();
      const record = JSON.parse(text);
      const metrics = record && record.metrics ? record.metrics : null;
      if (metrics && typeof metrics.hardestDecisionNote === 'string') return metrics.hardestDecisionNote;
    } catch (error) {
      // missing export data simply means no prefill
    }
    return '';
  }

  async function openNoteDialog(game) {
    if (busyNoteId) return;
    busyNoteId = game.id;
    render();
    const existing = noteCache.has(game.id) ? noteCache.get(game.id) : await fetchExistingNote(game);
    busyNoteId = '';
    if (disposed) return;
    render();
    const textarea = h('textarea', {
      class: 'textarea',
      maxlength: '280',
      placeholder: t('playtest.notePlaceholder'),
      'aria-label': t('playtest.noteTitle')
    }, existing);
    const counter = h('span', { class: 'char-count' }, String(existing.length) + ' / 280');
    textarea.addEventListener('input', () => {
      counter.textContent = String(textarea.value.length) + ' / 280';
    });
    const body = h('div', { class: 'stack-12' },
      h('p', { class: 'dialog-desc' }, t('playtest.noteDesc')),
      textarea,
      h('div', { class: 'note-meta' }, h('span', { class: 'faint', style: { fontSize: '11px' } }, game.id || ''), counter)
    );
    const result = await openDialog({
      title: t('playtest.noteTitle'),
      body: body,
      actions: [
        { label: t('common.cancel'), value: null, kind: 'ghost' },
        { label: t('common.save'), value: 'save', kind: 'primary', read: () => textarea.value.trim() }
      ],
      onOpen: (dialog) => {
        setTimeout(() => textarea.focus(), 10);
      }
    });
    if (result === null || result === undefined) return;
    try {
      const response = await api.hardestDecision(game.id, result);
      noteCache.set(game.id, result);
      if (response && response.metrics && typeof response.metrics.hardestDecisionNote === 'string') {
        noteCache.set(game.id, response.metrics.hardestDecisionNote);
      }
      toast(t('playtest.noteSaved'), { type: 'success' });
      loadSummary();
      render();
    } catch (error) {
      toast(describeError(error), { type: 'error' });
    }
  }

  function buildGamesSection() {
    if (authBlocked) return authRequiredState(t('playtest.gamesDesc'));
    if (gamesLoading) return skeletonCards(2);
    if (gamesError && isAuthError(gamesError)) return authRequiredState(t('playtest.gamesDesc'));
    if (gamesError) return errorState({ title: t('playtest.error'), error: gamesError, onRetry: loadGames });
    if (!games.length) {
      return h('div', { class: 'state-block' },
        h('p', { class: 'state-title' }, t('playtest.empty')),
        h('p', { class: 'state-desc' }, t('playtest.emptyDesc')),
        h('a', { class: 'btn btn--primary btn--sm', href: '#/local' }, icon('swords', 15), t('setup.start'))
      );
    }
    const table = h('table', { class: 'data-table' },
      h('caption', null, t('playtest.gamesTitle')),
      h('thead', null,
        h('tr', null,
          h('th', null, t('common.date')),
          h('th', null, t('common.mode')),
          h('th', null, t('common.players')),
          h('th', null, t('game.endReason')),
          h('th', null, t('common.result')),
          h('th', { style: { textAlign: 'right' } }, t('common.note'))
        )
      ),
      h('tbody', null, games.map((game) => {
        const note = noteCache.get(game.id);
        return h('tr', null,
          h('td', null, h('span', { class: 'history-date' }, formatDate(game.createdAt))),
          h('td', null, modeBadge(game.mode)),
          h('td', null, t('history.playersCount', { n: game.playerCount || (game.players || []).length })),
          h('td', null, game.result ? endReasonLabel(game.result.endReason) : t('history.noResult')),
          h('td', null, game.result && game.result.scores ? game.result.scores.join(' / ') : '-'),
          h('td', null,
            h('div', { class: 'playtest-note-cell', style: { justifyContent: 'flex-end' } },
              note
                ? h('span', { class: 'playtest-note-text', title: note }, note)
                : h('span', { class: 'playtest-note-empty' }, t('playtest.noNote')),
              h('button', {
                type: 'button',
                class: 'btn btn--ghost btn--sm',
                disabled: busyNoteId ? '' : null,
                onclick: () => openNoteDialog(game)
              },
                busyNoteId === game.id ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : icon('plus', 14),
                note ? t('playtest.editNote') : t('playtest.addNote')
              )
            )
          )
        );
      }))
    );
    return h('div', { class: 'card' }, h('div', { class: 'card-body', style: { padding: '4px 0 0' } },
      h('div', { class: 'table-wrap' }, table)
    ));
  }

  function render() {
    if (disposed) return;
    clear(container);
    container.appendChild(pageHeader({
      eyebrow: t('nav.playtest'),
      title: t('playtest.title'),
      subtitle: t('playtest.subtitle'),
      actions: [
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => { loadSummary(); loadGames(); } },
          icon('refresh', 15), t('common.refresh')),
        h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: exportCsv },
          icon('download', 15), t('playtest.csvExport'))
      ]
    }));

    const main = h('div', { class: 'playtest-main' },
      sectionCard({ title: t('playtest.overview'), content: buildSummarySection() }),
      h('section', { class: 'stack-16' },
        h('div', { class: 'home-section-head' },
          h('div', null,
            h('h2', { class: 'home-section-title' }, t('playtest.gamesTitle')),
            h('p', { class: 'home-section-desc' }, t('playtest.gamesDesc'))
          )
        ),
        buildGamesSection()
      )
    );
    const aside = h('aside', { class: 'playtest-aside' },
      sectionCard({
        title: t('playtest.instrumentationTitle'),
        content: h('p', { class: 'card-desc', style: { marginTop: 0 } }, t('playtest.instrumentationBody'))
      }),
      sectionCard({
        title: t('playtest.privacyTitle'),
        content: h('p', { class: 'card-desc', style: { marginTop: 0 } }, t('playtest.privacyBody'))
      })
    );
    container.appendChild(h('div', { class: 'playtest-layout' }, main, aside));
  }

  render();
  loadSummary();
  loadGames();

  return function cleanup() {
    disposed = true;
  };
}
