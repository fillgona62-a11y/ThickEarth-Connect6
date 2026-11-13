/**
 * Session and runtime configuration state. Views subscribe for changes; the
 * store is the single source of truth for auth, language and features.
 */
import { api } from './api.js';
import { getLang, setLang } from './i18n.js';

/** Shown when /api/session has not answered yet; never a made-up release number. */
export const UNKNOWN_VERSION = '0.0.0';

export const DEFAULT_CONFIG = {
  app: 'ThickEarth',
  version: UNKNOWN_VERSION,
  mode: 'desktop',
  features: { auth: false, online: true, llm: false },
  rules: {
    version: 'connect6/v1',
    boardSize: 19,
    winLength: 6,
    stonesPerTurn: 2,
    firstTurnStones: 1,
    playerCounts: [2]
  }
};

const state = {
  config: DEFAULT_CONFIG,
  configLoaded: false,
  user: null,
  authenticated: false,
  mode: 'desktop',
  features: { auth: false, online: true, llm: false },
  offline: false,
  loaded: false,
  loading: false,
  error: null,
  language: getLang()
};

const listeners = new Set();

function emit() {
  for (const listener of Array.from(listeners)) {
    try {
      listener(state);
    } catch (error) {
      // never let one subscriber break the others
    }
  }
}

export function getSession() {
  return state;
}

export function onSessionChange(listener) {
  listeners.add(listener);
  return function unsubscribe() {
    listeners.delete(listener);
  };
}

export function getConfig() {
  return state.config || DEFAULT_CONFIG;
}

export function getFeatures() {
  return state.features || DEFAULT_CONFIG.features;
}

export function requiresAuth() {
  return Boolean(state.features && state.features.auth);
}

export function isSignedIn() {
  return Boolean(state.authenticated && state.user);
}

export function isOffline() {
  return Boolean(state.offline);
}

export async function loadSession(options) {
  const opts = options || {};
  if (state.loading && !opts.force) return state;
  state.loading = true;
  emit();
  state.error = null;
  let config = null;
  try {
    config = await api.getConfig(opts.force === true);
    state.config = config;
    state.configLoaded = true;
    state.mode = config.mode || 'desktop';
    state.features = Object.assign({}, DEFAULT_CONFIG.features, config.features || {});
    state.offline = false;
  } catch (error) {
    state.offline = true;
    state.error = error;
    state.config = state.config || DEFAULT_CONFIG;
    state.features = state.config.features || DEFAULT_CONFIG.features;
    state.mode = state.mode || state.config.mode || 'desktop';
  }

  try {
    const me = await api.getMe();
    if (me && me.authenticated && me.user) {
      state.authenticated = true;
      state.user = me.user;
      if (me.mode) state.mode = me.mode;
    } else {
      state.authenticated = false;
      state.user = null;
      if (me && me.mode) state.mode = me.mode;
    }
    if (!state.offline) state.offline = false;
  } catch (error) {
    if (error && error.status === 401) {
      state.authenticated = false;
      state.user = null;
    } else if (error && error.status === 0) {
      state.offline = true;
      state.error = error;
    }
  }

  state.loaded = true;
  state.loading = false;
  emit();
  return state;
}

export async function signIn(email, password) {
  const result = await api.login({ email: email, password: password });
  if (result && result.user) {
    state.user = result.user;
    state.authenticated = true;
    state.offline = false;
    emit();
  }
  return result;
}

export async function signUp(payload) {
  const result = await api.register(payload);
  if (result && result.user) {
    state.user = result.user;
    state.authenticated = true;
    state.offline = false;
    emit();
  }
  return result;
}

export async function signOut() {
  await api.logout();
  state.user = null;
  state.authenticated = false;
  emit();
}

export function setLanguage(code) {
  setLang(code);
  state.language = getLang();
  emit();
}

export function handleSessionExpired() {
  state.user = null;
  state.authenticated = false;
  emit();
}
