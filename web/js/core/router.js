/**
 * Hash router. Routes are declared as patterns such as "/game/:id" and matched
 * without any external dependency.
 */

let routes = [];
let started = false;
const listeners = new Set();

function escapeSegment(segment) {
  return segment.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

function compile(pattern) {
  const keys = [];
  const normalized = String(pattern || '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter((segment) => segment !== '');
  const regexParts = [];
  for (const segment of segments) {
    if (segment.charAt(0) === ':') {
      keys.push(segment.slice(1));
      regexParts.push('/([^/]+)');
    } else {
      regexParts.push('/' + escapeSegment(segment));
    }
  }
  const source = regexParts.length ? regexParts.join('') : '/';
  return { regex: new RegExp('^' + source + '/?$'), keys: keys, pattern: pattern };
}

export function setRoutes(definitions) {
  routes = definitions.map((definition) => ({
    name: definition.name,
    meta: definition.meta || {},
    compiled: compile(definition.path)
  }));
}

export function parseHash(hash) {
  let raw = hash === undefined || hash === null ? window.location.hash : hash;
  raw = String(raw || '');
  if (raw.charAt(0) === '#') raw = raw.slice(1);
  if (!raw) raw = '/';
  const questionIndex = raw.indexOf('?');
  let path = questionIndex >= 0 ? raw.slice(0, questionIndex) : raw;
  const queryText = questionIndex >= 0 ? raw.slice(questionIndex + 1) : '';
  if (path.charAt(0) !== '/') path = '/' + path;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const query = {};
  if (queryText) {
    const params = new URLSearchParams(queryText);
    for (const [key, value] of params.entries()) query[key] = value;
  }
  return { path: path, query: query };
}

export function resolve(hash) {
  const parsed = parseHash(hash);
  for (const route of routes) {
    const match = route.compiled.regex.exec(parsed.path);
    if (match) {
      const params = {};
      route.compiled.keys.forEach((key, index) => {
        try {
          params[key] = decodeURIComponent(match[index + 1]);
        } catch (error) {
          params[key] = match[index + 1];
        }
      });
      return {
        name: route.name,
        meta: route.meta,
        path: parsed.path,
        params: params,
        query: parsed.query
      };
    }
  }
  return {
    name: 'not-found',
    meta: { titleKey: 'common.error' },
    path: parsed.path,
    params: {},
    query: parsed.query
  };
}

export function currentPath() {
  return parseHash().path;
}

function emit() {
  const resolved = resolve();
  for (const listener of Array.from(listeners)) {
    try {
      listener(resolved);
    } catch (error) {
      // keep other listeners alive
    }
  }
}

export function navigate(path, options) {
  const opts = options || {};
  const normalized = path.charAt(0) === '/' ? path : '/' + path;
  const target = '#' + normalized;
  if (window.location.hash === target) {
    if (opts.force) emit();
    return;
  }
  if (opts.replace) {
    window.history.replaceState(null, '', target);
    emit();
  } else {
    window.location.hash = target;
  }
}

export function back(fallbackPath) {
  if (window.history.length > 2) window.history.back();
  else navigate(fallbackPath || '/');
}

export function onRouteChange(listener) {
  listeners.add(listener);
  return function unsubscribe() {
    listeners.delete(listener);
  };
}

export function startRouter() {
  if (started) return;
  started = true;
  window.addEventListener('hashchange', emit);
  if (!window.location.hash) {
    window.history.replaceState(null, '', '#/');
  }
  emit();
}
