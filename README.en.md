# ThickEarth · Connect6

**English** · [中文](README.md)

A Connect6 web app you can play, watch and export. It has a real front end and back end, stores games in SQLite, ships a built-in AI opponent, does post-game analysis and coaching, exports game records — and opens up **agent seats**: any external process (your own script, an LLM app, a CLI agent such as Claude Code or Codex) can claim a token, take a seat, and play the local AI or another agent.

No third-party runtime dependencies — only Node built-ins, including `node:sqlite`. Requires **Node >= 22.5**.

```
npm test           # 44 test cases, all passing
npm run smoke      # plays one full game against a real server, then checks export / analysis / stats / static assets
npm start          # desktop mode on a random 127.0.0.1 port
```

---

## Rules (as defined by the referee baseline)

| | |
|---|---|
| Board | 19 × 19, columns A–S, rows 1–19 (row 1 is the top row) |
| First move | Black (seat 0) |
| Stones per turn | Black opens with **1 stone**; every later turn is **2 stones** |
| Win | **six or more** in a row horizontally, vertically or diagonally, immediately |
| Not in the game | pass, forbidden moves, resignation, capture |
| Board full with no six | draw |

**One AI decision = one stone**, matching the baseline's `get_move(board)` boundary, so a single "turn" can span one or two decisions. The 10-second per-decision deadline is a design reference; the referee platform's real limit wins.

Two things that get misread:

- **A six made by the turn's first stone ends the game at once.** The second stone is never played — the win is checked right after each placement, not at the end of the turn.
- **Six or more all win.** Seven or eight in a row are fine; there is no overlong-run penalty. The check is `run.length >= 6`.

The rules engine is a pure module (`shared/rules.js`). The replay view imports the same module and replays through it, so there is no second implementation that can drift.

---

## Feature map

| Requirement | Implementation | Where |
|---|---|---|
| Board-game web app with front end and back end | Native ESM front end + Node HTTP backend, 30+ REST routes, SSE push | `web/`, `server/` |
| Database for game data | SQLite: games, action log, users, AI usage, coach reports | `server/db.js` |
| Any language allowed | Backend is Node only, front end has no build step; the agent side can be any language over HTTP | — |
| Agent support, can host an AI | External agent seats: token + turn contract + SSE | `server/agent-seats.js` |
| Game analysis | Local analysis engine, scores shape threats and swings move by move | `shared/analysis.js` |
| Play against your own AI | `mode=ai` human vs AI, `selfplay` AI vs AI, `arena` agent vs AI or agent vs agent | `server/games.js` |
| Post-game weaknesses and analysis | Coach report: strengths, weaknesses, key mistakes, advice, training plan | `server/coach.js` |
| Game record export | JSON / Markdown / plain text (Markdown includes an X/O final position), plus playtest CSV | `server/export.js` |

---

## Quick start

```bash
# 1. Install Node 22.5+ and run. There is no npm install step, because there are no dependencies.
npm start                        # desktop mode: 127.0.0.1, random port

# 2. Web mode (registration and login, good for demos and deployment)
APP_MODE=web PORT=8080 npm start
# open http://127.0.0.1:8080

# 3. Tests and the end-to-end check
npm test
npm run smoke
npm run test:i18n                # Chinese/English copy keys stay in sync
```

Environment variables:

| Variable | Meaning |
|---|---|
| `APP_MODE` | `desktop` (default: no auth, listens on 127.0.0.1 only) or `web` (registration/login, Origin checks) |
| `PORT` / `HOST` | Web mode defaults to 8080 / 0.0.0.0; desktop mode to a random port / 127.0.0.1 |
| `DATA_DIR` / `DB_PATH` | Web mode defaults to `./data/thickearth.db`; desktop mode writes to the system user data directory |
| `PUBLIC_ORIGIN` | Public origin for a web deployment, used by the CSRF Origin check |
| `COOKIE_SECURE` | Set to 1 when the web deployment is behind HTTPS |
| `THICK_EARTH_AI_MOCK` | Set to 1 to use the built-in mock provider, so the AI flow can be demoed offline |

There is also an Electron shell: `electron/main.js` starts the server in-process and then opens a window. Installers live in Releases.

### Updating an installed desktop build

Electron loads `resources/app.asar` first and falls back to a plain `resources/app/` directory when no asar is present. So the shortest way to get a source change into the installed app is to drop the source in as a directory:

```bash
APP="$LOCALAPPDATA/Programs/ThickEarth/resources"
cp -p "$APP/app.asar" "$APP/app.asar.bak"      # keep the original; rolling back is just renaming it
mv "$APP/app.asar" "$APP/app.asar.disabled"    # so Electron cannot find the asar
mkdir -p "$APP/app"
for d in desktop electron server shared web; do cp -r "$d" "$APP/app/"; done
cp -p package.json "$APP/app/"
```

Restart the desktop app afterwards. To roll back, delete `app/` and rename `app.asar.bak` to `app.asar`.

The desktop build keeps its database at `%LOCALAPPDATA%\ThickEarth\data\thick-earth.db`. The `%LOCALAPPDATA%\ThickEarth\thickearth.db` file belongs to `npm start`, not to the installed app.

---

## Architecture

```
shared/            shared by front end and backend, pure functions, no IO
  rules.js         rules engine: setup, legality, placement and turn bookkeeping, six-in-a-row, result
  analysis.js      post-game analysis: replay, shape scoring, key moments, weaknesses, advice
  ai.js            local shape AI (candidate pruning + threat ordering, deterministic)
  agent-protocol.js  LLM prompt construction + strict response parsing (moves / coach report / follow-ups)

server/
  index.js         entry point, reads the environment
  app.js           HTTP application factory: routes, auth, error mapping
  games.js         game service: create, join, submit, AI rotation, view projection
  agent-seats.js   agent seat tokens + deadline fallback scheduler
  ai-settings.js   provider configuration and quotas
  ai-provider.js   OpenAI-compatible Chat Completions adapter
  coach.js         post-game report and follow-up questions
  db.js            SQLite repository layer
  realtime.js      SSE broadcast
  export.js        game record export
  playtest.js      playtest statistics and CSV

web/               native ESM, no build step
  js/core/         router, state, i18n, DOM helpers
  js/game/         19x19 board rendering (star points, winning line highlight, keyboard accessible)
  js/views/        pages (setup, game, replay, history, analysis, rules, settings)
```

**Persistence**: a game is stored as *initial state + ordered action log*. Current state, result and metrics are all materialised from it. That means any game can be replayed in full from its log, analysis results can be audited, and the coach is constrained to cite only what actually exists in the log.

Core tables: `games` (`initial_state` / `current_state` / `seats` / `result` / `metrics`), `actions`, `users`, `ai_usage`, `coach_reports`.

---

## Why a single threat cannot win

Each turn places two stones, so the opponent can use the first stone to block your only threat and still attack with the rest. What actually decides games is the **double threat**: two lines that both need an answer in the same turn, which one turn cannot cover.

The local AI is scored on exactly that — run length × open ends along four axes, weighted by tier (five, open four, blocked four, open three), with a decayed penalty on the opponent's threats (`DEFENCE_WEIGHT`). The analysis engine uses the same shape definitions but caps each stone's contribution at an open four, so one five-in-a-row does not saturate every swing value.

---

## Three kinds of AI

| Form | How to use it | Characteristics |
|---|---|---|
| Local shape AI | seat `kind=ai, engine=local` | in-process, answers in milliseconds, works offline, deterministic (no randomness) |
| LLM seat | seat `kind=ai, engine=llm`, provider configured in settings | each move builds a prompt (rules summary + board diagram + remaining stones + legal points) and demands a bare coordinate; illegal replies are retried once, then fall back to the local AI |
| External agent | seat `kind=agent` | the server **never plays for it**; it waits for an external submission. Token + turn contract, so any agent runtime fits |

The API key goes in Settings → AI provider, which supports DeepSeek, Alibaba Bailian, Zhipu, SiliconFlow, OpenAI and custom OpenAI-compatible endpoints. Note that filling in a key is not enough: the seat's engine also has to be set to `LLM` when the game is created.

An LLM seat makes one request per stone by default, with a cap of 40 per game and 500 per month; beyond that it degrades to the local engine automatically.

**Does a cloud LLM know the rules?** Yes, but only for seats using the `LLM` engine. The rules are not something the model has to remember: for every move the server rebuilds the prompt from the rules summary, the current board, how many stones are still owed this turn and every legal point, then parses the returned coordinate strictly. A parse failure or an illegal coordinate triggers one retry, and then a fallback to the local AI — so whether or not the model remembers Connect6, the legality of the game is never at its mercy.

---

## Connecting your own agent

Three steps, all HTTP, any language.

```bash
# 1. Create a game and leave seat 0 for the agent (in mode=arena both seats must be agent or ai)
curl -s -X POST http://127.0.0.1:7788/api/games \
  -H 'Content-Type: application/json' \
  -d '{"mode":"arena","playerCount":2,
       "seats":[{"kind":"agent","name":"My Agent"},
                {"kind":"ai","engine":"local"}]}'

# 2. Claim the token (returned in full exactly once)
curl -s -X POST http://127.0.0.1:7788/api/games/<gameId>/seats/0/token

# 3. Read the position / place a stone (one stone per call; check stonesRemainingThisTurn for how many are owed)
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:7788/api/agent/game
curl -s -X POST -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"turnId":12,"action":{"type":"place","x":9,"y":9}}' \
  http://127.0.0.1:7788/api/agent/actions
```

A reference client (dependency-free, plays a whole game):

```bash
node agents/example-client.mjs http://127.0.0.1:7788           # agent vs local AI
node agents/example-client.mjs http://127.0.0.1:7788 --arena    # agent vs agent
```

The full contract is in [`docs/AGENT-SEAT.md`](docs/AGENT-SEAT.md): auth, events, error codes, timeout semantics.

---

## API overview

| Group | Endpoints |
|---|---|
| Metadata | `GET /api/config`, `GET /api/health` |
| Accounts (web mode) | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Games | `GET/POST /api/games`, `POST /api/games/join`, `GET/DELETE /api/games/:id`, `POST /api/games/:id/start`, `POST /api/games/:id/actions`, `GET /api/games/:id/events` (SSE) |
| Analysis and coaching | `GET/POST /api/games/:id/analysis`, `GET/POST /api/games/:id/coach`, `POST /api/games/:id/coach/messages`, `POST /api/games/:id/hardest-decision` |
| Export | `GET /api/games/:id/export?format=json\|md\|txt`, `GET /api/playtest/export?format=csv` |
| AI configuration | `GET/PUT /api/ai/settings`, `POST /api/ai/test`, `DELETE /api/ai/key` |
| Agent seats | `POST /api/games/:id/seats/:seat/token`, `GET /api/agent/game`, `POST /api/agent/actions`, `GET /api/agent/events` |

Errors always look like `{"error":{"code":"...","message":"..."}}`.

---

## Tests

```bash
npm test          # 44 cases
npm run smoke     # starts a real server, plays a game, then checks export, analysis, stats and static assets
```

`test/rules.test.mjs` covers six-in-a-row detection, the single opening stone, per-turn stone bookkeeping, rejection of moves after the game ends, and coordinate round-trips.
`test/analysis.test.mjs` covers the analysis output contract, missed wins and missed blocks, in-progress positions, and truncation of a corrupted log.
`test/ai.test.mjs` covers AI legality, determinism, and taking a six-in-a-row when it is available.
`test/agent-seat.test.mjs` covers missing and forged tokens, cross-game isolation, `STALE_TURN` rejection, deadline fallback, an agent playing a full game, agent vs agent in arena, and seat validation per mode.
`test/web.test.mjs` guards the front end: the Chinese and English key sets must match, every `t()`-referenced key must exist, no territory-era vocabulary (camping, recall, pass) may survive in a view, and the board must be 19x19 with star points and a winning-line highlight.

---

## Deliberate trade-offs

**Why `turnId` instead of a bare submission**: agents are asynchronous — they retry after timeouts, and two workers may race for the same token. Using `state.seq` as the turn number means a mismatched submission gets `409 STALE_TURN`. Better to make the agent re-read the position than to let a move land on a board it has never seen.

**Why a turn is split into two decisions**: the rules require *one AI decision, one stone*, so the engine tracks `placedThisTurn` and only hands over once two stones are down. That way the agent protocol, the AI and the analysis all share one decision boundary, with no special cases.

**Why there is a deadline fallback**: external processes hang. Without a fallback, one stuck agent freezes the whole game. When the deadline passes the local AI plays the move and `fallbackCount` is recorded, so polluted games can be filtered out during evaluation.

**Why there is no "timeout loses" rule**: the rules have no concept of an eliminated seat, so adding one would put two rule sets in the same product. Better to keep the data cleanable than to fork the rules.

**Why zero dependencies**: `node:sqlite`, `node:crypto` and `node:http` are enough. No `node_modules`, no build step — clone and run, which also makes life easier for the evaluation environment. Nothing depends on a local long-lived connection or a background daemon either: the server is an ordinary HTTP process and the agent is a polling client, so both move to the evaluation environment unchanged.

---

## Known limitations

- `online` mode binds seats to user sessions and does not support agent tokens.
- The API sends no CORS headers, so an agent running in a browser is blocked by the same-origin policy; run agents as local processes.
- AI providers are limited to OpenAI-compatible Chat Completions.
- The local AI is a shape heuristic, not a search engine: stronger than random, weaker than a serious Connect6 program.
