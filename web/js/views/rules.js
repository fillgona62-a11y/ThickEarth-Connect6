/**
 * Rules view: readable bilingual summary of the Connect6 rules, plus a small
 * diagram showing what six in a row looks like.
 */
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { getSession } from '../core/store.js';
import { pageHeader, sectionCard, badge } from '../core/ui.js';
import { staticBoard } from '../game/board.js';

const SECTION_KEYS = ['overview', 'board', 'turn', 'win', 'strategy', 'agent', 'records'];

/** A six-stone run on a 9x9 sample board, with the two points that would extend it. */
function rowExample() {
  const stones = [];
  for (let x = 1; x <= 6; x += 1) stones.push({ x, y: 4, seat: 0 });
  stones.push({ x: 6, y: 3, seat: 1 });
  stones.push({ x: 6, y: 5, seat: 1 });
  const winLine = [];
  for (let x = 1; x <= 6; x += 1) winLine.push({ x, y: 4 });
  return {
    size: 9,
    stones,
    winLine,
    highlight: [[0, 4], [7, 4]]
  };
}

export async function mount(container) {
  const session = getSession();
  const rules = (session.config && session.config.rules) || {};
  const version = rules.version || rules.ruleSetVersion || 'connect6/v1';
  const boardSize = rules.boardSize || 19;
  const winLength = rules.winLength || 6;
  const stonesPerTurn = rules.stonesPerTurn || 2;
  const firstTurnStones = rules.firstTurnStones || 1;
  const counts = rules.playerCounts || [2];
  const example = rowExample();
  let disposed = false;

  const sections = [];

  function section(index, key, content) {
    const id = 'rule-' + key;
    const el = h('section', { class: 'card rules-section', id: id, tabindex: '-1' },
      h('div', { class: 'rules-section-head' },
        h('span', { class: 'rules-index' }, String(index).padStart(2, '0')),
        h('h2', { class: 'rules-section-title' }, t('rules.' + key + 'Title'))
      ),
      content
    );
    sections.push({ key: key, id: id, title: t('rules.' + key + 'Title'), element: el });
    return el;
  }

  section(1, 'overview', h('div', null,
    h('p', { class: 'rules-p' }, t('rules.overviewBody')),
    h('div', { class: 'rules-note' }, t('rules.overviewNote'))
  ));

  section(2, 'board', h('div', null,
    h('p', { class: 'rules-p' }, t('rules.boardBody')),
    h('div', { class: 'rules-note' }, t('rules.boardNote'))
  ));

  section(3, 'turn', h('div', null,
    h('p', { class: 'rules-p' }, t('rules.turnBody')),
    h('p', { class: 'rules-formula' }, firstTurnStones + ' → ' + stonesPerTurn + ' → ' + stonesPerTurn + ' → …'),
    h('div', { class: 'rules-note' }, t('rules.turnNote'))
  ));

  section(4, 'win', h('div', null,
    h('p', { class: 'rules-p' }, t('rules.winBody')),
    h('ul', { class: 'rules-list' },
      h('li', null, t('rules.winDraw'))
    ),
    h('div', { class: 'rules-note' }, t('rules.winNote'))
  ));

  section(5, 'strategy', h('div', null,
    h('p', { class: 'rules-p' }, t('rules.strategyBody')),
    h('ul', { class: 'rules-list' },
      h('li', null, t('rules.strategyDouble')),
      h('li', null, t('rules.strategyBlock')),
      h('li', null, t('rules.strategyCentre')),
      h('li', null, t('rules.strategyJoin'))
    )
  ));

  section(6, 'agent', h('div', null,
    h('p', { class: 'rules-p' }, t('rules.agentBody')),
    h('div', { class: 'rules-note mono', style: { fontSize: '11px' } },
      'POST /api/games → GET /api/agent/game → POST /api/agent/actions'),
    h('div', { class: 'rules-note' }, t('rules.agentNote'))
  ));

  section(7, 'records', h('div', null,
    h('p', { class: 'rules-p' }, t('rules.recordsBody')),
    h('div', { class: 'rules-note' }, t('rules.recordsNote')),
    h('div', { class: 'rules-note' }, t('rules.sourceNote'))
  ));

  function buildToc() {
    const list = h('div', { class: 'toc-list' });
    sections.forEach((item, index) => {
      list.appendChild(h('button', {
        type: 'button',
        class: 'toc-link',
        onclick: () => {
          const target = document.getElementById(item.id);
          if (!target) return;
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setTimeout(() => target.focus({ preventScroll: true }), 320);
        }
      },
        h('span', { class: 'toc-index' }, String(index + 1).padStart(2, '0')),
        h('span', null, item.title)
      ));
    });
    return list;
  }

  function buildExampleCard() {
    return sectionCard({
      title: t('rules.exampleTitle'),
      description: t('rules.exampleDesc'),
      content: h('div', { class: 'stack-12' },
        h('div', { style: { display: 'flex', justifyContent: 'center' } },
          staticBoard({
            size: example.size,
            stones: example.stones,
            winLine: example.winLine,
            highlight: example.highlight,
            label: t('rules.exampleCaption')
          })
        ),
        h('div', { class: 'rules-legend' },
          h('div', { class: 'rules-legend-item' },
            h('span', { class: 'legend-swatch legend-swatch--legal', 'aria-hidden': 'true' }), t('rules.boardLegend'))
        ),
        h('p', { class: 'faint', style: { fontSize: '11px', lineHeight: '1.6' } }, t('rules.exampleCaption'))
      )
    });
  }

  function buildAside() {
    const facts = h('div', { class: 'kv-list' },
      h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('rules.factBoard')), h('span', { class: 'kv-value' }, boardSize + ' × ' + boardSize)),
      h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('rules.factWin')), h('span', { class: 'kv-value' }, String(winLength))),
      h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('rules.factStones')), h('span', { class: 'kv-value' }, firstTurnStones + ' → ' + stonesPerTurn)),
      h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('rules.factPlayers')), h('span', { class: 'kv-value' }, counts.join(' / '))),
      h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('rules.factDecision')), h('span', { class: 'kv-value' }, '10 s')),
      h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, t('common.ruleset')), h('span', { class: 'kv-value mono' }, version))
    );
    const metaCard = sectionCard({
      title: t('rules.versionBadge'),
      content: h('div', { class: 'stack-12' },
        facts,
        h('a', { class: 'btn btn--ghost btn--sm', href: '#/settings' }, icon('settings', 14), t('nav.settings'))
      )
    });
    return h('aside', { class: 'rules-aside' },
      sectionCard({ title: t('rules.tocTitle'), content: buildToc() }),
      buildExampleCard(),
      metaCard
    );
  }

  clear(container);
  container.appendChild(pageHeader({
    eyebrow: t('nav.rules'),
    title: t('rules.title'),
    subtitle: t('rules.subtitle', { version: version }),
    actions: [
      badge(version, 'amber'),
      h('button', {
        type: 'button',
        class: 'btn btn--secondary btn--sm',
        onclick: () => {
          const first = document.getElementById('rule-overview');
          if (first) first.scrollIntoView({ behavior: 'smooth' });
        }
      }, icon('book', 15), t('rules.overviewTitle'))
    ]
  }));
  container.appendChild(h('div', { class: 'rules-layout' },
    h('div', { class: 'rules-main' }, sections.map((item) => item.element)),
    buildAside()
  ));

  return function cleanup() {
    disposed = true;
  };
}
