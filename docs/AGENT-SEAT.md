# Agent seats

An **agent seat** is a seat in a ThickEarth game that is played by an external
process instead of in-process AI. The server stays the only referee: every action
still goes through `shared/rules.js`, and a seat can only ever act on its own turn.

This document is the contract. The reference implementation lives in
`agents/example-client.mjs`, and `test/agent-seat.test.mjs` pins the behaviour.

## The game agents play: Connect6

| Item | Value |
|---|---|
| Board | 19 × 19, columns A–S, rows 1–19 |
| First move | Black (seat 0) places **one** stone |
| Every later turn | the player on the clock places **two** stones |
| Win | six or more in an unbroken row, column or diagonal |
| Not allowed | passing, resignation, forbidden moves, captures |

**One decision = one stone.** That matches the referee's `get_move(board)`
boundary, so a turn spans one or two decisions. An agent therefore needs to be
asked to move twice per turn (once on the opening turn). After each accepted
stone the server tells you how many are still owed via
`turn.stonesRemainingThisTurn`; when it reaches `0` the turn has passed to the
other seat.

A single decision is designed to fit inside a 10-second budget. That number is a
tuning reference only — the platform's actual runtime is what counts during
evaluation.

## Seat types

| `kind` | Who moves it | How |
|---|---|---|
| `human` | a person, locally or over a session | `POST /api/games/:id/actions` |
| `ai` | the server, immediately | `shared/ai.js` heuristics, or an LLM via `engine: "llm"` |
| `agent` | an external process | `POST /api/agent/actions` with a seat token |

The server never moves an `agent` seat. If the process is slow, the game simply
waits on that turn — until the deadline fallback fires (see below).

## Game modes

| `mode` | Seat composition |
|---|---|
| `local` | both seats human (hot seat) |
| `ai` | ≥1 non-AI seat and ≥1 AI seat — `agent` counts as the non-AI side |
| `selfplay` | both seats AI |
| `arena` | no human seats, ≥1 `agent` seat — for agent-vs-agent and agent-vs-baseline evaluation |
| `online` | both seats human, lobby + room code |

`arena` is the mode to use when benchmarking policies: pair two agents, or pair an
agent against the built-in AI as a baseline. Nothing is auto-played for agent
seats, so a full arena game runs at whatever speed the agents answer.

## Creating a game with an agent seat

```bash
curl -s -X POST http://127.0.0.1:7788/api/games \
  -H 'Content-Type: application/json' \
  -d '{"mode":"arena","playerCount":2,
       "seats":[{"kind":"agent","name":"My Agent","timeLimitMs":20000},
                {"kind":"ai","name":"Local AI","engine":"local","difficulty":"normal"}]}'
```

Agent seat options:

| Field | Default | Meaning |
|---|---|---|
| `name` | `Agent N` | display name |
| `timeLimitMs` | `20000` | per-decision deadline; `0` = wait forever; max `1800000` |

## Minting a seat token

```bash
curl -s -X POST http://127.0.0.1:7788/api/games/<gameId>/seats/0/token
```

```json
{ "seat": 0, "token": "teagent.g_aba5aef9.0.XXXX", "tokenType": "Bearer" }
```

- The token is a capability for **exactly one game and one seat**. It cannot act
  for another seat or another game.
- The raw token is returned **once**. Only its SHA-256 digest is stored, so it
  cannot be recovered later — mint a new one if it is lost (the old one keeps
  working until it is replaced).
- In `web` mode only the game host may mint. In `desktop` mode any local caller may.
- Minting for a non-agent seat fails with `409 NOT_AGENT_SEAT`.

Send it on every agent request:

```
Authorization: Bearer teagent.g_aba5aef9.0.XXXX
```

## Endpoints

### `GET /api/agent/game`

Snapshot for this seat.

```json
{
  "game": { "id": "g_...", "status": "play", "state": { "...": "..." }, "players": [] },
  "turn": {
    "turnId": 12,
    "seat": 0,
    "isMyTurn": true,
    "stonesRemainingThisTurn": 1,
    "placedThisTurn": 1,
    "legalActions": [ { "type": "place", "x": 9, "y": 9 } ],
    "timeLimitMs": 20000,
    "deadlineAt": 1794370063936
  }
}
```

`legalActions` is empty when it is not your turn. `deadlineAt` is `null` when no
timer is armed (`timeLimitMs: 0`). `stonesRemainingThisTurn` is `0` when it is not
your turn.

### `POST /api/agent/actions`

```bash
curl -s -X POST http://127.0.0.1:7788/api/agent/actions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"turnId":12,"action":{"type":"place","x":9,"y":9}}'
```

Returns the same shape as `GET /api/agent/game`, already updated.

`action` is always `{"type":"place","x","y"}` — one stone per request. There is no
`camp`, `recall`, `pass` or `resign` action in Connect6, and requests that send one
are rejected with `400 INVALID_ACTION`. Coordinates are 0-based (`x` = column
index 0–18, `y` = row index 0–18); `x:9, y:9` is the J10 point.
Only actions listed in `turn.legalActions` are accepted.

**Always send `turnId`.** It is the position sequence number. If the position has
already moved on — a fallback played for you, a stale retry, two workers sharing
one token — the request is rejected with `409 STALE_TURN` instead of silently
applying a move to a board you never saw. A non-negative integer `turnId` is mandatory; missing or non-integer values return `400 INVALID_TURN_ID`.

### `GET /api/agent/events`

Server-Sent Events for this seat. Two event types:

```
event: state
data: { ...the same GameView as GET /api/games/:id... }

event: turn
data: { "turnId": 12, "seat": 0, "isMyTurn": true, "legalActions": [...],
        "timeLimitMs": 20000, "deadlineAt": 1794370063936 }
```

The stream sends `state` and `turn` immediately on connect, then sends current snapshots after accepted submissions and deadline updates.
Automatic AI stones may be coalesced in one update. Token rotation closes the old stream. A `ping` event arrives every 25s; ignore it.

Polling `GET /api/agent/game` is supported and is what the reference client does.
SSE is the better choice for latency: a 20s deadline leaves little room for a slow
poll interval.

## Deadline fallback

If an agent seat is on the clock and `timeLimitMs > 0` expires without a move, the
server plays a **local heuristic stone** for that seat so the game cannot stall.
Reads do not extend the deadline. Deadlines persist across server restarts. The fallback:

- only fires if the seat is still the one on the clock and `turnId` is unchanged,
  so it can never overwrite a real move that arrived moments later;
- is counted on the seat as `players[i].fallbackCount` and logged, so evaluation
  runs can discard or flag the affected games;
- re-arms for the next decision if that decision is also an agent decision.

Set `timeLimitMs: 0` for debugging or for a human-in-the-loop agent you do not want
auto-played. A stall then means a stalled game — there is no implicit rescue.

There is deliberately no `forfeit` policy: scoring is defined by `shared/rules.js`
and Connect6 has no concept of an eliminated seat, so inventing one here would put
two different rulebooks in the product. `fallbackCount` plus the action log is
enough to post-process a timeout out of your data.

## Error codes

| HTTP | code | When |
|---|---|---|
| 401 | `AGENT_TOKEN_REQUIRED` | no `Authorization: Bearer` header |
| 401 | `AGENT_TOKEN_INVALID` | malformed token, or the game no longer exists |
| 403 | `FORBIDDEN` | token is not the stored credential for that seat |
| 409 | `NOT_AGENT_SEAT` | the seat is `human` or `ai` |
| 409 | `NOT_YOUR_TURN` | another seat is on the clock |
| 409 | `STALE_TURN` | `turnId` is not the current position |
| 409 | `GAME_FINISHED` / `GAME_NOT_STARTED` | the game is over or has not begun |
| 400 | `INVALID_ACTION` / `OUT_OF_BOUNDS` / `CELL_OCCUPIED` | that stone is not playable |

All error bodies are `{"error":{"code":"...","message":"..."}}`.

## Recommended agent loop

```
token = mint(gameId, seat)
loop:
  turn = GET /api/agent/game
  if turn.game.status == "finished": break
  if not turn.isMyTurn: wait for the next turn event; continue
  action = decide(turn.game.state, turn.legalActions)
  try: POST /api/agent/actions { turnId: turn.turnId, action }
  catch STALE_TURN | NOT_YOUR_TURN: re-read and continue   # never blind-retry
```

Rules of thumb:

- Treat `403` as fatal configuration error, not a retry.
- Never blind-retry a `409`; re-read the turn first.
- Keep the token in a secret store. It is a bearer credential on the local API.

## Notes and limits

- Agent seats can be created in `ai` and `arena` modes. `online` mode
  is human-only: it binds seats to user sessions, not tokens.
- The HTTP API sends no CORS headers, so browser-based agents are blocked by
  same-origin policy. Run the agent as a local process (Node, Python, Go, a CLI
  agent) rather than from a web page.
- In `desktop` mode the API listens on `127.0.0.1` only, which is the intended
  trust boundary for a local agent. In `web` mode, treat agent tokens as you would
  any other bearer secret and front the server with TLS.

## Client transport and evaluation

Remote sample clients require HTTPS, reject redirects, and cap request time and response size. `attach-agent.mjs` accepts `THICK_EARTH_AGENT_TOKEN` so the bearer secret need not appear in command arguments; it checks that the token belongs to the requested game. On a website, create/mint through the signed-in UI, then attach; the auto-create example targets local desktop mode. Run `npm run evaluate:agents` for isolated functional samples. See [evaluation](AGENT-EVALUATION.zh-CN.md).
