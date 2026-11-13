/**
 * Shared UI primitives: toasts, dialogs, page headers, cards, badges, form
 * fields, segmented controls and loading/empty/error states.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { t, hasKey } from './i18n.js';

let toastRegion = null;
let dialogSeq = 0;

function ensureToastRegion() {
  if (toastRegion && document.body.contains(toastRegion)) return toastRegion;
  toastRegion = h('div', {
    id: 'toast-region',
    class: 'toast-region',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'false'
  });
  document.body.appendChild(toastRegion);
  return toastRegion;
}

export function toast(message, options) {
  const opts = options || {};
  const region = ensureToastRegion();
  const type = opts.type || 'info';
  const node = h('div', { class: 'toast toast--' + type, role: 'status' },
    h('span', { class: 'toast-icon', 'aria-hidden': 'true' }, icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info', 17)),
    h('span', { class: 'toast-text' }, message),
    h('button', {
      type: 'button',
      class: 'toast-close',
      'aria-label': t('common.dismiss'),
      onclick: () => removeToast(node)
    }, icon('x', 14))
  );
  region.appendChild(node);
  const timeout = opts.sticky ? 0 : opts.timeout === undefined ? 4200 : opts.timeout;
  if (timeout > 0) {
    node._timer = setTimeout(() => removeToast(node), timeout);
  }
  return node;
}

function removeToast(node) {
  if (!node || !node.parentNode) return;
  if (node._timer) clearTimeout(node._timer);
  node.classList.add('is-leaving');
  setTimeout(() => {
    if (node.parentNode) node.parentNode.removeChild(node);
  }, 180);
}

export function describeError(error) {
  if (!error) return t('common.error');
  if (typeof error === 'string') return error;
  if (error.code === 'OFFLINE' || error.status === 0) return t('common.networkError');
  if (error.code) {
    const key = 'error.' + error.code;
    if (hasKey(key)) return t(key);
  }
  if (error.status === 401) return t('error.UNAUTHORIZED');
  if (error.status === 404) return t('error.NOT_FOUND');
  if (error.status === 409) return t('error.CONFLICT');
  if (typeof error.message === 'string' && error.message && error.message.indexOf('HTTP ') !== 0) {
    return error.message;
  }
  return t('error.REQUEST_FAILED');
}

/**
 * Modal dialog. Actions may carry a fixed value or a read(dialog) callback
 * evaluated when the action is chosen. Resolves with the chosen value or null.
 */
export function openDialog(config) {
  const cfg = config || {};
  const id = 'dialog-' + (++dialogSeq);
  const titleId = id + '-title';
  const dialog = h('dialog', { class: 'dialog' + (cfg.size === 'wide' ? ' dialog--wide' : '') });
  if (cfg.title) dialog.setAttribute('aria-labelledby', titleId);
  else dialog.setAttribute('aria-label', cfg.label || t('common.confirm'));

  let settle = () => {};
  const resultPromise = new Promise((resolve) => {
    settle = (value) => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      resolve(value);
    };
  });

  const actions = h('div', { class: 'dialog-actions' });
  const actionList = cfg.actions || [{ label: t('common.close'), value: null }];
  for (const action of actionList) {
    actions.appendChild(h('button', {
      type: 'button',
      class: 'btn ' + (action.kind === 'danger' ? 'btn--danger' : action.kind === 'ghost' ? 'btn--ghost' : 'btn--primary'),
      autofocus: action.autofocus ? '' : null,
      onclick: () => {
        let value = action.value;
        if (typeof action.read === 'function') {
          try {
            value = action.read(dialog);
          } catch (error) {
            value = null;
          }
        }
        settle(value);
      }
    }, action.label));
  }

  const header = h('div', { class: 'dialog-head' },
    cfg.title ? h('h2', { class: 'dialog-title', id: titleId }, cfg.title) : h('span', { class: 'dialog-spacer' }),
    h('button', {
      type: 'button',
      class: 'icon-btn dialog-close',
      'aria-label': t('a11y.closeDialog'),
      onclick: () => settle(null)
    }, icon('x', 18))
  );

  const body = h('div', { class: 'dialog-body' },
    cfg.description ? h('p', { class: 'dialog-desc' }, cfg.description) : null,
    cfg.body || null
  );

  dialog.appendChild(header);
  dialog.appendChild(body);
  if (actionList.length) dialog.appendChild(actions);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    settle(null);
  });
  dialog.addEventListener('close', () => {
    if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
  });
  document.body.appendChild(dialog);
  if (typeof dialog.showModal === 'function') {
    try {
      dialog.showModal();
    } catch (error) {
      dialog.setAttribute('open', '');
    }
  } else {
    dialog.setAttribute('open', '');
  }
  if (typeof cfg.onOpen === 'function') cfg.onOpen(dialog);
  const focusTarget = dialog.querySelector('[autofocus]') || dialog.querySelector('textarea, input, select, button');
  if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
  return resultPromise;
}

export function confirmDialog(options) {
  const opts = options || {};
  return openDialog({
    title: opts.title || t('common.confirm'),
    description: opts.description || '',
    size: opts.size,
    actions: [
      { label: opts.cancelLabel || t('common.cancel'), value: false, kind: 'ghost' },
      {
        label: opts.confirmLabel || t('common.confirm'),
        value: true,
        kind: opts.danger ? 'danger' : 'primary',
        autofocus: true
      }
    ]
  }).then((value) => value === true);
}

export function loadingBlock(label) {
  return h('div', { class: 'loading-block', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('span', { class: 'loading-text' }, label || t('common.loading'))
  );
}

export function skeletonLines(count) {
  const total = count || 3;
  const wrapper = h('div', { class: 'skeleton-group', 'aria-hidden': 'true' });
  for (let index = 0; index < total; index += 1) {
    wrapper.appendChild(h('div', { class: 'skeleton skeleton--line' }));
  }
  return wrapper;
}

export function skeletonCards(count) {
  const total = count || 3;
  const wrapper = h('div', { class: 'skeleton-grid', 'aria-hidden': 'true' });
  for (let index = 0; index < total; index += 1) {
    wrapper.appendChild(h('div', { class: 'skeleton skeleton--card' }));
  }
  return wrapper;
}

export function emptyState(options) {
  const opts = options || {};
  return h('div', { class: 'state-block state-block--empty' },
    opts.icon ? h('div', { class: 'state-icon', 'aria-hidden': 'true' }, icon(opts.icon, 26)) : null,
    h('p', { class: 'state-title' }, opts.title || t('common.empty')),
    opts.description ? h('p', { class: 'state-desc' }, opts.description) : null,
    opts.action ? h('div', { class: 'state-action' }, opts.action) : null
  );
}

export function errorState(options) {
  const opts = options || {};
  const retry = opts.onRetry
    ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: opts.onRetry }, icon('refresh', 15), t('common.retry'))
    : null;
  return h('div', { class: 'state-block state-block--error', role: 'alert' },
    h('div', { class: 'state-icon', 'aria-hidden': 'true' }, icon('alert', 26)),
    h('p', { class: 'state-title' }, opts.title || t('common.error')),
    h('p', { class: 'state-desc' }, opts.message || describeError(opts.error)),
    retry ? h('div', { class: 'state-action' }, retry) : null
  );
}

export function pageHeader(options) {
  const opts = options || {};
  const main = h('div', { class: 'page-header-main' },
    opts.eyebrow ? h('p', { class: 'eyebrow' }, opts.eyebrow) : null,
    h('h1', { class: 'page-title' }, opts.title || ''),
    opts.subtitle ? h('p', { class: 'page-subtitle' }, opts.subtitle) : null
  );
  return h('header', { class: 'page-header' },
    opts.onBack ? h('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm page-header-back',
      onclick: opts.onBack
    }, icon('arrowLeft', 15), opts.backLabel || t('common.back')) : null,
    main,
    opts.actions ? h('div', { class: 'page-header-actions' }, opts.actions) : null
  );
}

export function sectionCard(options) {
  const opts = options || {};
  return h('section', { class: 'card' + (opts.className ? ' ' + opts.className : '') },
    opts.title || opts.actions
      ? h('div', { class: 'card-head' },
          h('div', { class: 'card-head-text' },
            opts.title ? h('h2', { class: 'card-title' }, opts.title) : null,
            opts.description ? h('p', { class: 'card-desc' }, opts.description) : null
          ),
          opts.actions ? h('div', { class: 'card-actions' }, opts.actions) : null
        )
      : null,
    opts.content ? h('div', { class: 'card-body' }, opts.content) : null
  );
}

export function statCard(options) {
  const opts = options || {};
  return h('div', { class: 'stat-card' + (opts.tone ? ' stat-card--' + opts.tone : '') },
    h('div', { class: 'stat-card-label' },
      opts.icon ? h('span', { class: 'stat-card-icon', 'aria-hidden': 'true' }, icon(opts.icon, 15)) : null,
      h('span', null, opts.label || '')
    ),
    h('div', { class: 'stat-card-value' }, opts.value === undefined || opts.value === null ? t('playtest.metricUnavailable') : opts.value),
    opts.hint ? h('div', { class: 'stat-card-hint' }, opts.hint) : null
  );
}

export function badge(label, tone) {
  return h('span', { class: 'badge' + (tone ? ' badge--' + tone : '') }, label);
}

export function seatBadge(player, options) {
  const opts = options || {};
  const seat = player.seat;
  const color = player.color || ['amber', 'jade', 'violet', 'crimson'][seat] || 'amber';
  const letter = player._letter || String.fromCharCode(65 + seat);
  return h('span', { class: 'seat-badge seat-badge--' + color },
    h('span', { class: 'seat-badge-letter', 'aria-hidden': 'true' }, letter),
    h('span', { class: 'seat-badge-name' }, player.name || t('game.seatN', { n: seat + 1 })),
    opts.suffix ? h('span', { class: 'seat-badge-suffix' }, opts.suffix) : null
  );
}

export function segmented(options) {
  const opts = options || {};
  const group = h('div', {
    class: 'segmented' + (opts.block ? ' segmented--block' : '') + (opts.size === 'sm' ? ' segmented--sm' : ''),
    role: 'group',
    'aria-label': opts.ariaLabel || ''
  });
  let currentValue = opts.value;
  for (const option of opts.options || []) {
    const button = h('button', {
      type: 'button',
      class: 'segmented-btn' + (option.value === currentValue ? ' is-active' : ''),
      'aria-pressed': option.value === currentValue ? 'true' : 'false',
      onclick: () => {
        if (option.value === currentValue) return;
        currentValue = option.value;
        for (const child of Array.from(group.children)) {
          const active = child.dataset.value === String(option.value);
          child.classList.toggle('is-active', active);
          child.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
        if (typeof opts.onChange === 'function') opts.onChange(option.value);
      }
    }, option.label);
    button.dataset.value = String(option.value);
    if (option.title) button.title = option.title;
    group.appendChild(button);
  }
  return group;
}

export function field(options) {
  const opts = options || {};
  const id = opts.id || 'field-' + Math.random().toString(36).slice(2, 8);
  const control = opts.control;
  if (control && !control.id) control.id = id;
  return h('div', { class: 'field' + (opts.error ? ' field--error' : '') },
    h('label', { class: 'field-label', for: id },
      h('span', null, opts.label || ''),
      opts.required ? h('span', { class: 'field-required', 'aria-hidden': 'true' }, '*') : null
    ),
    control,
    opts.hint && !opts.error ? h('p', { class: 'field-hint' }, opts.hint) : null,
    opts.error ? h('p', { class: 'field-error', role: 'alert' }, opts.error) : null
  );
}

export function toggle(options) {
  const opts = options || {};
  let checked = Boolean(opts.checked);
  const control = h('button', {
    type: 'button',
    class: 'switch',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': opts.ariaLabel || opts.label || '',
    onclick: () => {
      checked = !checked;
      control.setAttribute('aria-checked', checked ? 'true' : 'false');
      control.classList.toggle('is-on', checked);
      if (typeof opts.onChange === 'function') opts.onChange(checked);
    }
  }, h('span', { class: 'switch-knob', 'aria-hidden': 'true' }));
  if (checked) control.classList.add('is-on');
  return h('div', { class: 'toggle-row' },
    h('div', { class: 'toggle-text' },
      h('span', { class: 'toggle-label' }, opts.label || ''),
      opts.description ? h('span', { class: 'toggle-desc' }, opts.description) : null
    ),
    control
  );
}

export function setLiveMessage(message) {
  let region = document.getElementById('live-region');
  if (!region) {
    region = h('div', {
      id: 'live-region',
      class: 'sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    });
    document.body.appendChild(region);
  }
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message || '';
  }, 30);
}

export function progressBar(value, max, tone) {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  return h('div', { class: 'progress' + (tone ? ' progress--' + tone : ''), role: 'img', 'aria-label': '' },
    h('span', { class: 'progress-fill', style: { width: Math.round(ratio * 100) + '%' } })
  );
}

export function iconText(name, text, className) {
  return h('span', { class: 'icon-text' + (className ? ' ' + className : '') },
    h('span', { class: 'icon-text-icon', 'aria-hidden': 'true' }, icon(name, 15)),
    h('span', null, text)
  );
}

export function pillSelect(options) {
  // Placeholder for future filters; segmented covers current needs.
  return segmented(options);
}

export function clearNode(node) {
  return clear(node);
}
