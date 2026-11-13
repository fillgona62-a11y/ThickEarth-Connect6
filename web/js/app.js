/**
 * Application bootstrap: session, header/footer chrome, and hash routing.
 * Views are loaded lazily and mounted with a cleanup contract.
 */
import { h, clear, qs } from './core/dom.js';
import { icon, iconButton } from './core/icons.js';
import { applyDocumentLang, getLang, onLangChange, setLang, t, LANGUAGES } from './core/i18n.js';
import { setRoutes, startRouter, onRouteChange, resolve, navigate, currentPath } from './core/router.js';
import {
  loadSession,
  getSession,
  onSessionChange,
  setLanguage,
  requiresAuth,
  isSignedIn,
  UNKNOWN_VERSION
} from './core/store.js';
import { onUnauthorized } from './core/api.js';
import {
  toast,
  describeError,
  errorState,
  loadingBlock,
  segmented,
  openDialog,
  badge
} from './core/ui.js';

function startDesktopHeartbeat() {
  const session = getSession();
  const mode = session.mode || (session.config && session.config.mode);
  if (mode !== 'desktop') return;
  const beat = () => {
    fetch('/api/desktop/heartbeat', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store'
    }).catch(() => {});
  };
  beat();
  window.setInterval(beat, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) beat();
  });
  window.addEventListener('online', beat);
}

const ROUTES = [
  { name: 'home', path: '/', meta: { titleKey: 'title.home' } },
  { name: 'local', path: '/local', meta: { titleKey: 'title.local' } },
  { name: 'online', path: '/online', meta: { titleKey: 'title.online' } },
  { name: 'online-lobby', path: '/online/:id', meta: { titleKey: 'title.onlineLobby' } },
  { name: 'login', path: '/login', meta: { titleKey: 'title.login' } },
  { name: 'register', path: '/register', meta: { titleKey: 'title.register' } },
  { name: 'game', path: '/game/:id', meta: { titleKey: 'title.game' } },
  { name: 'replay', path: '/replay/:id', meta: { titleKey: 'title.replay' } },
  { name: 'history', path: '/history', meta: { titleKey: 'title.history' } },
  { name: 'playtest', path: '/playtest', meta: { titleKey: 'title.playtest' } },
  { name: 'rules', path: '/rules', meta: { titleKey: 'title.rules' } },
  { name: 'settings', path: '/settings', meta: { titleKey: 'title.settings' } }
];

const VIEW_LOADERS = {
  home: () => import('./views/home.js'),
  local: () => import('./views/local-setup.js'),
  online: () => import('./views/online.js'),
  'online-lobby': () => import('./views/online-lobby.js'),
  login: () => import('./views/auth.js'),
  register: () => import('./views/auth.js'),
  game: () => import('./views/game.js'),
  replay: () => import('./views/replay.js'),
  history: () => import('./views/history.js'),
  playtest: () => import('./views/playtest.js'),
  rules: () => import('./views/rules.js'),
  settings: () => import('./views/settings.js')
};

const NAV_ITEMS = [
  { name: 'home', path: '/', icon: 'home' },
  { name: 'local', path: '/local', icon: 'swords' },
  { name: 'online', path: '/online', icon: 'globe' },
  { name: 'history', path: '/history', icon: 'history' },
  { name: 'playtest', path: '/playtest', icon: 'chart' },
  { name: 'rules', path: '/rules', icon: 'book' },
  { name: 'settings', path: '/settings', icon: 'settings' }
];

let currentCleanup = null;
let currentRoute = null;
let renderToken = 0;
let menuOpen = false;
let notifiedOffline = false;
let headerReady = false;
let lastSessionSnapshot = '';

function appVersion() {
  const session = getSession();
  return (session.config && session.config.version) || UNKNOWN_VERSION;
}

function rulesetVersion() {
  const session = getSession();
  const rules = session.config && session.config.rules;
  return (rules && (rules.version || rules.ruleSetVersion)) || 'connect6/v1';
}

/* Header ------------------------------------------------------------------ */

function buildLangToggle() {
  return segmented({
    ariaLabel: t('a11y.langToggle'),
    size: 'sm',
    value: getLang(),
    options: LANGUAGES.map((language) => ({ value: language.code, label: language.short })),
    onChange: (value) => {
      if (value === getLang()) return;
      setLanguage(value);
    }
  });
}

function navigateAndCloseMenu(path) {
  closeMenu();
  navigate(path);
}

function buildHeader() {
  const session = getSession();
  const header = document.getElementById('app-header');
  if (!header) return;
  headerReady = true;
  const activeName = currentRoute ? currentRoute.name : 'home';
  const onlineActive = activeName === 'online' || activeName === 'online-lobby';
  const navActive = (item) => {
    if (item.name === 'online') return onlineActive;
    return activeName === item.name;
  };

  const nav = h('nav', {
    class: 'main-nav' + (menuOpen ? ' is-open' : ''),
    'aria-label': t('nav.primary')
  });
  for (const item of NAV_ITEMS) {
    const isActive = navActive(item);
    nav.appendChild(h('a', {
      class: 'nav-link' + (isActive ? ' is-active' : ''),
      href: '#' + item.path,
      'aria-current': isActive ? 'page' : null,
      onclick: () => closeMenu()
    }, icon(item.icon, 15), h('span', null, t('nav.' + item.name))));
  }

  const menuButton = h('button', {
    type: 'button',
    class: 'icon-btn menu-btn',
    'aria-label': t('common.menu'),
    'aria-expanded': menuOpen ? 'true' : 'false',
    onclick: () => {
      menuOpen = !menuOpen;
      nav.classList.toggle('is-open', menuOpen);
      menuButton.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
    }
  }, icon('menu', 19));

  const right = h('div', { class: 'header-right' });
  right.appendChild(buildLangToggle());
  right.appendChild(h('span', { class: 'header-divider', 'aria-hidden': 'true' }));

  if (session.offline) {
    right.appendChild(h('span', { class: 'mode-chip mode-chip--offline' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      t('common.local') + ' · ' + t('common.offline')
    ));
  } else if (requiresAuth()) {
    right.appendChild(h('span', { class: 'mode-chip' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      t('app.mode.web')
    ));
  } else {
    right.appendChild(h('span', { class: 'mode-chip' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      t('app.mode.desktop')
    ));
  }

  if (isSignedIn()) {
    const user = session.user;
    const name = user.displayName || user.email || t('common.player');
    const initial = String(name).trim().charAt(0).toUpperCase() || 'T';
    right.appendChild(h('span', { class: 'user-chip', title: name },
      h('span', { class: 'user-avatar', 'aria-hidden': 'true' }, initial),
      h('span', { class: 'user-name' }, name)
    ));
    if (requiresAuth()) {
      right.appendChild(iconButton('logout', t('settings.logout'), {
        onclick: async () => {
          try {
            await import('./core/store.js').then((mod) => mod.signOut());
            toast(t('auth.logoutDone'), { type: 'success' });
            navigate('/');
          } catch (error) {
            toast(describeError(error), { type: 'error' });
          }
        }
      }));
    }
  } else if (requiresAuth()) {
    right.appendChild(h('a', { class: 'btn btn--ghost btn--sm', href: '#/login' }, t('auth.loginTitle')));
    right.appendChild(h('a', { class: 'btn btn--primary btn--sm', href: '#/register' }, t('auth.registerTitle')));
  }

  const brand = h('a', { class: 'brand', href: '#/', title: t('app.name') },
    h('img', { class: 'brand-mark', src: 'assets/mark.svg', alt: '', width: 30, height: 30 }),
    h('span', { class: 'brand-text' },
      h('span', { class: 'brand-name' }, t('app.name')),
      h('span', { class: 'brand-latin' }, 'THICKEARTH')
    )
  );

  clear(header);
  header.appendChild(h('div', { class: 'header-inner' }, brand, menuButton, nav, right));
}

function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  const nav = qs('.main-nav');
  if (nav) nav.classList.remove('is-open');
  const button = qs('.menu-btn');
  if (button) button.setAttribute('aria-expanded', 'false');
}

/* Footer ------------------------------------------------------------------ */

function buildFooter() {
  const footer = document.getElementById('app-footer');
  if (!footer) return;
  const session = getSession();
  const appVersionText = appVersion();
  const rulesText = rulesetVersion();
  footer.innerHTML = '';
  const inner = h('div', { class: 'footer-inner' },
    h('span', { class: 'mono' }, t('app.name') + ' · THICKEARTH'),
    h('span', { class: 'mono' }, 'v' + appVersionText + ' · ' + rulesText),
    h('span', null, t('settings.privacyNote')),
    h('span', { class: 'footer-links' },
      h('a', { href: '#/rules' }, t('nav.rules')),
      h('a', { href: '#/settings' }, t('nav.settings'))
    )
  );
  footer.appendChild(inner);
}

/* Offline notice ---------------------------------------------------------- */

function updateOfflineNotice() {
  const main = document.getElementById('main-content');
  if (!main) return;
  const existing = document.getElementById('app-notices');
  const session = getSession();
  if (!session.offline || !session.loaded) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const notices = h('div', { id: 'app-notices', class: 'stack-12', style: { marginBottom: '18px' } },
    h('div', { class: 'offline-banner', role: 'alert' },
      icon('alert', 16),
      h('span', { class: 'flex-1' }, t('common.networkError')),
      h('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: async () => {
          const node = document.getElementById('app-notices');
          if (node) node.remove();
          await loadSession({ force: true });
          buildHeader();
          buildFooter();
          updateOfflineNotice();
          renderRoute(resolve(), true);
        }
      }, icon('refresh', 14), t('common.retry'))
    )
  );
  main.insertBefore(notices, main.firstChild);
}

/* Routing ----------------------------------------------------------------- */

function pageTitle(route) {
  const key = route.meta && route.meta.titleKey;
  const pageName = key ? t(key) : t('common.error');
  const appName = t('app.name');
  return pageName + ' · ' + appName;
}

function updateActiveNav(route) {
  currentRoute = route;
  if (!headerReady) return;
  const links = document.querySelectorAll('.main-nav .nav-link');
  let index = 0;
  const onlineActive = route.name === 'online' || route.name === 'online-lobby';
  for (const item of NAV_ITEMS) {
    const link = links[index];
    const active = item.name === 'online' ? onlineActive : item.name === route.name;
    if (link) {
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    index += 1;
  }
}

function cleanupCurrentView() {
  if (typeof currentCleanup === 'function') {
    try {
      currentCleanup();
    } catch (error) {
      // views must not break navigation
    }
  }
  currentCleanup = null;
}

async function renderRoute(route, force) {
  const token = ++renderToken;
  closeMenu();
  currentRoute = route;
  updateActiveNav(route);
  document.title = pageTitle(route);
  cleanupCurrentView();
  const container = document.getElementById('view-root');
  if (!container) return;
  clear(container);
  container.appendChild(loadingBlock(t('common.loading')));
  const main = document.getElementById('main-content');
  if (main) window.scrollTo(0, 0);

  const loader = VIEW_LOADERS[route.name];
  try {
    if (!loader) {
      if (token !== renderToken) return;
      renderNotFound(container, route);
      return;
    }
    const module = await loader();
    if (token !== renderToken) return;
    clear(container);
    if (typeof module.mount !== 'function') {
      throw new Error('View module ' + route.name + ' does not export mount()');
    }
    currentCleanup = await module.mount(container, route);
    if (token !== renderToken) {
      cleanupCurrentView();
      return;
    }
    updateActiveNav(route);
    if (main && typeof main.focus === 'function') {
      try {
        main.focus({ preventScroll: true });
      } catch (error) {
        main.focus();
      }
    }
  } catch (error) {
    if (token !== renderToken) return;
    clear(container);
    container.appendChild(errorState({
      title: t('common.error'),
      message: describeError(error),
      onRetry: () => renderRoute(route, true)
    }));
  }
}

function renderNotFound(container, route) {
  clear(container);
  container.appendChild(h('div', { class: 'not-found' },
    h('p', { class: 'not-found-code' }, '404 · ' + (route && route.path ? route.path : '')),
    h('h1', { class: 'page-title' }, t('game.notFound')),
    h('p', { class: 'page-subtitle' }, t('game.notFoundDesc')),
    h('a', { class: 'btn btn--primary', href: '#/' }, icon('arrowLeft', 15), t('common.back'))
  ));
}

/* Session effects --------------------------------------------------------- */

function sessionFingerprint() {
  const session = getSession();
  const user = session.user;
  return [
    session.loaded ? '1' : '0',
    session.offline ? '1' : '0',
    session.mode,
    session.authenticated ? '1' : '0',
    user ? (user.id || user.email || user.displayName) : '',
    (session.features && session.features.auth) ? '1' : '0'
  ].join('|');
}

let lastUnauthorizedToast = 0;

function handleUnauthorized() {
  if (!requiresAuth()) return;
  const path = currentPath();
  if (path === '/login' || path === '/register') return;
  import('./core/store.js').then((mod) => mod.handleSessionExpired());
  const protectedRoute = path.indexOf('/game') === 0 || path.indexOf('/replay') === 0 || path.indexOf('/local') === 0;
  if (protectedRoute) {
    toast(t('auth.sessionExpired'), { type: 'error' });
    navigate('/login?next=' + encodeURIComponent(window.location.hash || '#/'));
    return;
  }
  // Public pages stay usable: surface the expired session once and let each
  // view render its own auth-required state instead of redirecting.
  if (Date.now() - lastUnauthorizedToast > 5000) {
    lastUnauthorizedToast = Date.now();
    toast(t('auth.sessionExpired'), { type: 'error', timeout: 5000 });
  }
}

/* Boot -------------------------------------------------------------------- */

async function boot() {
  applyDocumentLang();
  buildHeader();
  buildFooter();
  setRoutes(ROUTES);

  onRouteChange((route) => {
    renderRoute(route);
  });
  onSessionChange(() => {
    const fingerprint = sessionFingerprint();
    if (fingerprint === lastSessionSnapshot) return;
    lastSessionSnapshot = fingerprint;
    buildHeader();
    buildFooter();
    updateOfflineNotice();
  });
  onUnauthorized(handleUnauthorized);
  onLangChange(() => {
    applyDocumentLang();
    buildHeader();
    buildFooter();
    updateOfflineNotice();
    toast(t('a11y.languageChanged'), { type: 'info', timeout: 1800 });
    renderRoute(resolve(), true);
  });

  await loadSession();
  startDesktopHeartbeat();
  lastSessionSnapshot = sessionFingerprint();
  buildHeader();
  buildFooter();
  updateOfflineNotice();
  if (getSession().offline && !notifiedOffline) {
    notifiedOffline = true;
    toast(t('common.networkError'), { type: 'error', timeout: 6000 });
  }
  startRouter();
}

boot().catch((error) => {
  const container = document.getElementById('view-root');
  if (container) {
    clear(container);
    container.appendChild(errorState({
      title: t('common.error'),
      message: describeError(error),
      onRetry: () => window.location.reload()
    }));
  }
});
