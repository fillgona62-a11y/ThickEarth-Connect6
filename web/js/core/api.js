/**
 * Thin JSON client for the ThickEarth HTTP API (see docs/API.md).
 * All calls are same-origin; the session cookie is sent automatically.
 */

export class ApiError extends Error {
  constructor(message, options) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    const opts = options || {};
    this.status = opts.status || 0;
    this.code = opts.code || 'REQUEST_FAILED';
    this.details = opts.details || null;
    this.url = opts.url || '';
  }
}

const unauthorizedListeners = new Set();

export function onUnauthorized(listener) {
  unauthorizedListeners.add(listener);
  return function unsubscribe() {
    unauthorizedListeners.delete(listener);
  };
}

function notifyUnauthorized(error) {
  for (const listener of Array.from(unauthorizedListeners)) {
    try {
      listener(error);
    } catch (ignored) {
      // listeners are independent
    }
  }
}

function parseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.indexOf('application/json') !== -1) {
    return response.json().catch(() => null);
  }
  return response.text().catch(() => null);
}

export async function request(path, options) {
  const opts = options || {};
  const init = {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal: opts.signal
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers['Content-Type'] = 'application/json';
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    throw new ApiError('Network request failed', { status: 0, code: 'OFFLINE', url: path });
  }
  if (opts.download) return response;
  const body = await parseBody(response);
  if (!response.ok) {
    const envelope = body && typeof body === 'object' && body.error ? body.error : null;
    const apiError = new ApiError(
      envelope && envelope.message ? envelope.message : 'HTTP ' + response.status,
      {
        status: response.status,
        code: envelope && envelope.code ? envelope.code : 'HTTP_' + response.status,
        details: envelope && envelope.details ? envelope.details : null,
        url: path
      }
    );
    if (response.status === 401 && apiError.code !== 'INVALID_CREDENTIALS') {
      notifyUnauthorized(apiError);
    }
    throw apiError;
  }
  return body;
}

function queryString(params) {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? '?' + serialized : '';
}

function gamePath(id, suffix) {
  return '/api/games/' + encodeURIComponent(id) + (suffix || '');
}

let configCache = null;
let configPromise = null;

export const api = {
  getConfig(force) {
    if (force) {
      configCache = null;
      configPromise = null;
    }
    if (configCache) return Promise.resolve(configCache);
    if (!configPromise) {
      configPromise = request('/api/config')
        .then((config) => {
          configCache = config;
          return config;
        })
        .catch((error) => {
          configPromise = null;
          throw error;
        });
    }
    return configPromise;
  },

  health() {
    return request('/api/health');
  },

  getMe() {
    return request('/api/auth/me');
  },

  login(credentials) {
    return request('/api/auth/login', { method: 'POST', body: credentials });
  },

  register(payload) {
    return request('/api/auth/register', { method: 'POST', body: payload });
  },

  logout() {
    return request('/api/auth/logout', { method: 'POST' });
  },

  listGames(params) {
    return request('/api/games' + queryString(params));
  },

  getGame(id, options) {
    return request(gamePath(id), { signal: options && options.signal });
  },

  createGame(payload) {
    return request('/api/games', { method: 'POST', body: payload });
  },

  joinGame(roomCode) {
    return request('/api/games/join', { method: 'POST', body: { roomCode: roomCode } });
  },

  startGame(id) {
    return request(gamePath(id, '/start'), { method: 'POST' });
  },

  submitAction(id, action) {
    return request(gamePath(id, '/actions'), { method: 'POST', body: { action: action } });
  },

  /**
   * Mints a bearer token for an agent seat. The response carries the raw token
   * exactly once; only its digest is stored server-side.
   */
  mintAgentSeatToken(id, seat) {
    return request(gamePath(id, '/seats/' + encodeURIComponent(seat) + '/token'), { method: 'POST' });
  },

  deleteGame(id) {
    return request(gamePath(id), { method: 'DELETE' });
  },

  hardestDecision(id, note) {
    return request(gamePath(id, '/hardest-decision'), { method: 'POST', body: { note: note } });
  },

  getAnalysis(id) {
    return request(gamePath(id, '/analysis'));
  },

  generateAnalysis(id) {
    return request(gamePath(id, '/analysis'), { method: 'POST' });
  },

  playtestSummary() {
    return request('/api/playtest/summary');
  },

  /* AI agent: provider settings, connection test, coach report and chat ----- */

  aiSettings() {
    return request('/api/ai/settings');
  },

  updateAiSettings(payload) {
    return request('/api/ai/settings', { method: 'PUT', body: payload });
  },

  testAiConnection(payload) {
    return request('/api/ai/test', { method: 'POST', body: payload || {} });
  },

  clearAiKey() {
    return request('/api/ai/key', { method: 'DELETE' });
  },

  getCoach(gameId) {
    return request(gamePath(gameId, '/coach'));
  },

  generateCoach(gameId, options) {
    const opts = options || {};
    return request(gamePath(gameId, '/coach'), {
      method: 'POST',
      body: { force: Boolean(opts.force), language: opts.language || 'zh' }
    });
  },

  sendCoachMessage(gameId, message, language) {
    return request(gamePath(gameId, '/coach/messages'), {
      method: 'POST',
      body: { message: message, language: language || 'zh' }
    });
  },

  exportUrl(id, format) {
    return gamePath(id, '/export') + '?format=' + encodeURIComponent(format || 'json');
  },

  playtestExportUrl() {
    return '/api/playtest/export?format=csv';
  },

  eventsUrl(id) {
    return gamePath(id, '/events');
  },

  /**
   * Download a file and return its blob plus the filename advertised by the
   * server, so exports trigger a normal browser save without leaving the SPA.
   */
  async download(url) {
    const response = await request(url, { download: true });
    if (!response.ok) {
      const body = await parseBody(response);
      const envelope = body && typeof body === 'object' && body.error ? body.error : null;
      throw new ApiError(envelope && envelope.message ? envelope.message : 'HTTP ' + response.status, {
        status: response.status,
        code: envelope && envelope.code ? envelope.code : 'HTTP_' + response.status,
        url: url
      });
    }
    const disposition = response.headers.get('content-disposition') || '';
    let filename = 'thickearth-export';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (match && match[1]) filename = decodeURIComponent(match[1]);
    const blob = await response.blob();
    return { blob: blob, filename: filename };
  }
};

export function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}
