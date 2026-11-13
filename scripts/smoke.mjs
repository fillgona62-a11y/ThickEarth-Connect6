/**
 * End-to-end smoke test: boot the server on an ephemeral port, run a Connect6
 * self-play game to completion, then read back the analysis, the playtest
 * summary and both exports. Run with `node scripts/smoke.mjs`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';

// A throwaway database keeps the smoke run isolated from the desktop profile.
const workDir = mkdtempSync(join(tmpdir(), 'thickearth-smoke-'));
const server = await startServer({
  port: 0,
  host: '127.0.0.1',
  mode: 'desktop',
  dbPath: join(workDir, 'smoke.db')
});
const base = 'http://127.0.0.1:' + server.port;

async function call(path, options) {
  const response = await fetch(base + path, Object.assign({ headers: { Accept: 'application/json' } }, options));
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (error) {
    body = text;
  }
  if (!response.ok) {
    throw new Error(path + ' -> ' + response.status + ' ' + JSON.stringify(body));
  }
  return body;
}

function check(label, condition, detail) {
  if (!condition) throw new Error('FAIL ' + label + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  console.log('  ok  ' + label);
}

try {
  const config = await call('/api/config');
  check('config rules', config.rules.boardSize === 19
    && config.rules.winLength === 6
    && config.rules.stonesPerTurn === 2
    && config.rules.firstTurnStones === 1, config.rules);
  check('config rule version', config.rules.version === 'connect6/v1', config.rules.version);

  const created = await call('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      mode: 'selfplay',
      playerCount: 2,
      seats: [{ name: 'Black', kind: 'ai', difficulty: 'normal' }, { name: 'White', kind: 'ai', difficulty: 'normal' }]
    })
  });
  const game = created.game;
  check('game created', Boolean(game && game.id), created);
  check('game finished by self-play', game.status === 'finished', game.status);
  check('board is 19x19', game.state.boardSize === 19 && game.state.cells.length === 361);
  check('win line recorded', Array.isArray(game.result.line) && game.result.line.length >= 6, game.result.line?.length);
  check('end reason', game.result.endReason === 'six_in_a_row', game.result.endReason);

  // Every decision placed exactly one stone, and turns alternate 1 then 2.
  const history = game.state.history;
  check('one stone per decision', history.every((entry) => Array.isArray(entry.points) && entry.points.length === 1));
  const perTurn = new Map();
  for (const entry of history) perTurn.set(entry.turn, (perTurn.get(entry.turn) || 0) + 1);
  check('opening turn has one stone', perTurn.get(1) === 1, [...perTurn.entries()].slice(0, 3));
  const fullTurns = [...perTurn.entries()].filter(([, count]) => count === 2).length;
  check('most turns have two stones', fullTurns >= 5, { turns: perTurn.size, fullTurns });

  const analysis = await call('/api/games/' + game.id + '/analysis', { method: 'POST' });
  const summary = analysis.analysis.summary;
  check('analysis headline', typeof summary.headline === 'string' && summary.headline.length > 0, summary.headline);
  check('analysis decisions match', summary.decisions === history.length, { summary: summary.decisions, history: history.length });
  check('analysis has key moments', Array.isArray(analysis.analysis.keyMoments));
  check('analysis has recommendations', Array.isArray(analysis.analysis.recommendations)
    && analysis.analysis.recommendations.length > 0);

  const json = await call('/api/games/' + game.id + '/export?format=json');
  check('export rules block', json.rules && json.rules.winLength === 6 && json.rules.boardSize === 19, json.rules);
  check('export has 1 stone per action', Array.isArray(json.actions)
    && json.actions.every((action) => action.type === 'place'), json.actions?.length);
  check('export initial state is 19x19', json.initialState && json.initialState.cells.length === 361);
  check('export replays to the same decision count', json.actions.length === history.length, {
    actions: json.actions.length,
    history: history.length
  });

  const md = await call('/api/games/' + game.id + '/export?format=md');
  check('markdown mentions six in a row', /six|六/.test(String(md)), String(md).slice(0, 120));
  check('markdown has final position', String(md).includes('Final position'));

  const playtest = await call('/api/playtest/summary');
  check('playtest rule set', playtest.ruleSet === 'connect6', playtest.ruleSet);
  check('playtest counted the game', playtest.gameCount === 1, playtest.gameCount);
  check('playtest totals match the game', playtest.totals.decisions === history.length
    && playtest.totals.stones === history.length, playtest.totals);
  check('playtest first-player win rate', playtest.firstPlayerWinRate === 0 || playtest.firstPlayerWinRate === 1, playtest.firstPlayerWinRate);

  const csv = await fetch(base + '/api/playtest/export?format=csv').then((response) => response.text());
  check('csv header', csv.split('\n')[0].includes('board_size') && csv.split('\n')[0].includes('win_length'), csv.split('\n')[0]);

  // Static assets: the SPA shell, every module the views import, and the
  // shared rules engine the replay view loads directly.
  for (const path of [
    '/',
    '/css/board.css',
    '/css/views.css',
    '/js/app.js',
    '/js/views/local-setup.js',
    '/js/views/game.js',
    '/js/views/replay.js',
    '/js/game/board.js',
    '/js/core/i18n.js',
    '/shared/rules.js'
  ]) {
    const response = await fetch(base + path);
    check('static ' + path, response.ok, response.status);
    await response.arrayBuffer();
  }

  const shell = await fetch(base + '/').then((response) => response.text());
  check('shell references the tokens stylesheet', shell.includes('css/tokens.css'));
  check('shell mounts the app module', shell.includes('js/app.js'));

  console.log('\nall smoke checks passed');
} finally {
  await server.close();
  rmSync(workDir, { recursive: true, force: true });
}
