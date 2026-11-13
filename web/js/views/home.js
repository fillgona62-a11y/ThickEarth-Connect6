/**
 * Home view: hero, primary actions, recent games, and a quick rules summary.
 */
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { getSession, requiresAuth, isSignedIn } from '../core/store.js';
import { api } from '../core/api.js';
import {
  describeError,
  emptyState,
  errorState,
  skeletonCards
} from '../core/ui.js';
import { formatDate } from '../core/format.js';
import {
  modeBadge,
  statusBadge,
  playersInline,
  resultChips,
  gamePath,
  gameFinishMeta,
  isAuthError,
  authRequiredState
} from './common.js';

function heroSection(rules) {
  const boardSize = rules.boardSize || 19;
  const playerCounts = rules.playerCounts || [2];
  const winLength = rules.winLength || 6;
  return h('section', { class: 'home-hero' },
    h('div', { class: 'home-hero-text' },
      h('p', { class: 'eyebrow' }, t('home.eyebrow')),
      h('h1', { class: 'page-title page-title--hero' }, t('home.title')),
      h('p', { class: 'home-subtitle' }, t('home.subtitle')),
      h('div', { class: 'hero-actions' },
        h('a', { class: 'btn btn--primary btn--lg', href: '#/local' }, icon('swords', 17), t('home.ctaLocal')),
        h('a', { class: 'btn btn--secondary btn--lg', href: '#/local?mode=ai' }, icon('cpu', 17), t('home.ctaAi')),
        h('a', { class: 'btn btn--secondary btn--lg', href: '#/local?mode=arena' }, icon('robot', 17), t('home.ctaArena')),
        h('a', { class: 'btn btn--ghost btn--lg', href: '#/online' }, icon('globe', 17), t('home.ctaOnline'))
      ),
      h('div', { class: 'hero-meta' },
        h('span', null, icon('grid', 13), boardSize + ' × ' + boardSize),
        h('span', null, icon('users', 13), playerCounts.join(' / ')),
        h('span', null, icon('trophy', 13), winLength + t('home.inARow')),
        h('span', null, icon('shield', 13), t('common.ruleset') + ' ' + (rules.version || rules.ruleSetVersion || 'connect6/v1')),
        h('span', null, icon('activity', 13), 'NO RNG')
      )
    ),
    h('div', { class: 'home-hero-art' },
      h('img', {
        src: 'assets/hero-board.svg',
        alt: t('home.heroBoardAlt'),
        width: 560,
        height: 480,
        loading: 'eager'
      })
    )
  );
}

function statsSection(rules) {
  const boardSize = rules.boardSize || 19;
  const counts = rules.playerCounts || [2];
  const winLength = rules.winLength || 6;
  return h('div', { class: 'home-stats' },
    h('div', { class: 'home-stat' },
      h('div', { class: 'home-stat-label' }, t('home.statBoard')),
      h('div', { class: 'home-stat-value' }, boardSize + ' × ' + boardSize),
      h('div', { class: 'home-stat-note' }, t('home.statCells', { n: boardSize * boardSize }))
    ),
    h('div', { class: 'home-stat' },
      h('div', { class: 'home-stat-label' }, t('home.statWin')),
      h('div', { class: 'home-stat-value' }, String(winLength)),
      h('div', { class: 'home-stat-note' }, t('home.statWinNote'))
    ),
    h('div', { class: 'home-stat' },
      h('div', { class: 'home-stat-label' }, t('home.statRules')),
      h('div', { class: 'home-stat-value mono' }, rules.version || rules.ruleSetVersion || 'connect6/v1'),
      h('div', { class: 'home-stat-note' }, t('home.statNote'))
    )
  );
}

function howSection() {
  const steps = [
    { icon: 'stone', title: t('home.step1Title'), desc: t('home.step1Desc') },
    { icon: 'layers', title: t('home.step2Title'), desc: t('home.step2Desc') },
    { icon: 'trophy', title: t('home.step3Title'), desc: t('home.step3Desc') }
  ];
  return h('section', { class: 'stack-16' },
    h('div', { class: 'home-section-head' },
      h('div', null,
        h('h2', { class: 'home-section-title' }, t('home.howTitle')),
        h('p', { class: 'home-section-desc' }, t('rules.sourceNote'))
      ),
      h('a', { class: 'link-more', href: '#/rules' }, t('nav.rules'), icon('arrowRight', 14))
    ),
    h('div', { class: 'how-grid' },
      steps.map((step, index) => h('article', { class: 'how-step', 'data-step': String(index + 1) },
        h('span', { class: 'how-step-icon', 'aria-hidden': 'true' }, icon(step.icon, 18)),
        h('h3', { class: 'how-step-title' }, step.title),
        h('p', { class: 'how-step-desc' }, step.desc)
      ))
    )
  );
}

function recentCard(game) {
  const createdAt = game.createdAt || game.finishedAt;
  return h('a', { class: 'recent-card', href: '#' + gamePath(game) },
    h('div', { class: 'recent-card-top' },
      h('span', { class: 'row', style: { gap: '6px' } }, modeBadge(game.mode), statusBadge(game.status)),
      h('span', { class: 'faint mono', style: { fontSize: '10px' } }, formatDate(createdAt))
    ),
    playersInline(game.players || []),
    h('div', null, resultChips(game) || h('span', { class: 'muted', style: { fontSize: '12px' } },
      t('history.playersCount', { n: game.playerCount || (game.players || []).length })
    )),
    h('div', { class: 'recent-footer' },
      h('span', null, t('history.playersCount', { n: game.playerCount || (game.players || []).length })),
      h('span', null, gameFinishMeta(game) || t('common.waiting'))
    )
  );
}

function recentSection() {
  const body = h('div', { class: 'recent-games' });
  let disposed = false;
  async function load() {
    clear(body);
    body.appendChild(skeletonCards(3));
    try {
      const data = await api.listGames({ limit: 6 });
      if (disposed) return;
      clear(body);
      const games = data && Array.isArray(data.games) ? data.games : [];
      if (!games.length) {
        body.appendChild(h('div', { style: { gridColumn: '1 / -1' } },
          emptyState({
            icon: 'history',
            title: t('home.recentEmpty'),
            description: t('home.recentEmptyDesc'),
            action: h('a', { class: 'btn btn--primary btn--sm', href: '#/local' }, icon('swords', 15), t('home.ctaLocal'))
          })
        ));
        return;
      }
      for (const game of games) body.appendChild(recentCard(game));
    } catch (error) {
      if (disposed) return;
      clear(body);
      body.appendChild(h('div', { style: { gridColumn: '1 / -1' } },
        isAuthError(error)
          ? authRequiredState(t('home.recentEmptyDesc'))
          : errorState({ title: t('home.recentError'), error: error, onRetry: load })
      ));
    }
  }
  const section = h('section', { class: 'stack-16' },
    h('div', { class: 'home-section-head' },
      h('div', null,
        h('h2', { class: 'home-section-title' }, t('home.recentTitle')),
        h('p', { class: 'home-section-desc' }, t('home.recentDesc'))
      ),
      h('a', { class: 'link-more', href: '#/history' }, t('common.viewAll'), icon('arrowRight', 14))
    ),
    body
  );
  return { section, load, dispose() { disposed = true; } };
}

export async function mount(container, route) {
  const session = getSession();
  const config = session.config || {};
  const rules = config.rules || {};
  let disposed = false;
  const recent = recentSection();

  container.appendChild(heroSection(rules));
  container.appendChild(statsSection(rules));
  container.appendChild(recent.section);
  container.appendChild(howSection());
  if (requiresAuth() && !isSignedIn()) {
    const body = recent.section.querySelector('.recent-games');
    if (body) body.appendChild(h('div', { style: { gridColumn: '1 / -1' } }, authRequiredState(t('home.recentEmptyDesc'))));
  } else {
    recent.load();
  }

  return function cleanup() {
    disposed = true;
    recent.dispose();
  };
}
