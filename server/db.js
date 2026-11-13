/**
 * SQLite persistence layer. The database is opened once per application and all
 * statements are prepared lazily by the repository factory.
 *
 * The canonical game record is the initial engine state plus the ordered action
 * log. Current state, result, and playtest metrics are materialized for fast reads
 * and can always be rebuilt by replaying the log through shared/rules.js.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const JSON_COLUMNS = new Set(["initial_state", "current_state", "seats", "result", "metrics", "analysis"]);

const COLUMN_BY_FIELD = {
  status: "status",
  hostUserId: "host_user_id",
  startedAt: "started_at",
  finishedAt: "finished_at",
  initialState: "initial_state",
  currentState: "current_state",
  seats: "seats",
  result: "result",
  metrics: "metrics",
  analysis: "analysis"
};

const MIGRATIONS = [
  {
    version: 1,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

        CREATE TABLE IF NOT EXISTS games (
          id TEXT PRIMARY KEY,
          room_code TEXT NOT NULL UNIQUE,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          player_count INTEGER NOT NULL,
          host_user_id TEXT,
          owner_user_id TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          initial_state TEXT NOT NULL,
          current_state TEXT NOT NULL,
          seats TEXT NOT NULL,
          result TEXT,
          metrics TEXT,
          analysis TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_games_created ON games(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);

        CREATE TABLE IF NOT EXISTS actions (
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          turn INTEGER,
          seat INTEGER,
          type TEXT NOT NULL,
          x INTEGER,
          y INTEGER,
          notation TEXT NOT NULL,
          action TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (game_id, seq)
        );
      `);
    }
  },
  {
    version: 2,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_settings (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 0,
          provider TEXT NOT NULL DEFAULT 'custom',
          base_url TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          api_key_encrypted TEXT,
          key_hint TEXT,
          temperature REAL NOT NULL DEFAULT 0.2,
          max_output_tokens INTEGER NOT NULL DEFAULT 1200,
          max_moves_per_game INTEGER NOT NULL DEFAULT 40,
          monthly_call_limit INTEGER NOT NULL DEFAULT 500,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          game_id TEXT,
          kind TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_usage_user_time ON ai_usage(user_id, created_at);

        CREATE TABLE IF NOT EXISTS coach_reports (
          game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          report TEXT NOT NULL,
          error TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS coach_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_coach_messages_game ON coach_messages(game_id, id);
      `);
    }
  },
  {
    version: 3,
    apply(db) {
      db.exec(`
        ALTER TABLE ai_usage ADD COLUMN requested_by_user_id TEXT;
        CREATE INDEX idx_ai_usage_requester_time ON ai_usage(requested_by_user_id, created_at);
      `);
    }
  },
  {
    version: 4,
    apply(db) {
      // Idempotent: a rolled-back user_version must not make the migration
      // fail on a column that is already there.
      const columns = db.prepare("PRAGMA table_info(users)").all().map((row) => row.name);
      if (!columns.includes("is_admin")) {
        db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS site_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    }
  }
];

export function openDatabase(dbPath = ":memory:") {
  const filePath = dbPath === null || dbPath === undefined || dbPath === "" ? ":memory:" : dbPath;
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db) {
  const row = db.prepare("PRAGMA user_version").get();
  let version = Number(row.user_version) || 0;
  for (const migration of MIGRATIONS) {
    if (version >= migration.version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.apply(db);
      db.exec("PRAGMA user_version = " + migration.version);
      db.exec("COMMIT");
      version = migration.version;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    isAdmin: Boolean(row.is_admin)
  };
}

function parseJsonColumn(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function mapGameRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomCode: row.room_code,
    mode: row.mode,
    status: row.status,
    playerCount: row.player_count,
    hostUserId: row.host_user_id,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    initialState: JSON.parse(row.initial_state),
    currentState: JSON.parse(row.current_state),
    seats: JSON.parse(row.seats),
    result: parseJsonColumn(row.result),
    metrics: parseJsonColumn(row.metrics),
    analysis: parseJsonColumn(row.analysis)
  };
}

function mapActionRow(row) {
  return {
    seq: row.seq,
    turn: row.turn,
    seat: row.seat,
    type: row.type,
    x: row.x,
    y: row.y,
    notation: row.notation,
    action: JSON.parse(row.action)
  };
}

function mapAiSettingsRow(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    enabled: row.enabled === 1,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    apiKeyEncrypted: row.api_key_encrypted,
    keyHint: row.key_hint,
    temperature: row.temperature,
    maxOutputTokens: row.max_output_tokens,
    maxMovesPerGame: row.max_moves_per_game,
    monthlyCallLimit: row.monthly_call_limit,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCoachReportRow(row) {
  if (!row) return null;
  return {
    gameId: row.game_id,
    userId: row.user_id,
    status: row.status,
    source: row.source,
    provider: row.provider,
    model: row.model,
    report: row.report ? JSON.parse(row.report) : null,
    error: row.error,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCoachMessageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    gameId: row.game_id,
    userId: row.user_id,
    role: row.role,
    content: row.content,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at
  };
}

export function createRepositories(db) {
  const statements = {
    insertUser: db.prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)"),
    findUserByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    findUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
    setUserAdmin: db.prepare("UPDATE users SET is_admin = ? WHERE id = ?"),
    getSiteSetting: db.prepare("SELECT value FROM site_settings WHERE key = ?"),
    setSiteSetting: db.prepare(
      "INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ),

    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    findSession: db.prepare("SELECT * FROM sessions WHERE token_hash = ?"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),

    insertGame: db.prepare(
      "INSERT INTO games (id, room_code, mode, status, player_count, host_user_id, owner_user_id, created_at, started_at, finished_at, initial_state, current_state, seats, result, metrics, analysis) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    getGame: db.prepare("SELECT * FROM games WHERE id = ?"),
    getGameByRoomCode: db.prepare("SELECT * FROM games WHERE room_code = ?"),
    deleteGame: db.prepare("DELETE FROM games WHERE id = ?"),

    insertAction: db.prepare(
      "INSERT INTO actions (game_id, seq, turn, seat, type, x, y, notation, action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    listActions: db.prepare("SELECT * FROM actions WHERE game_id = ? ORDER BY seq ASC"),

    ensureUser: db.prepare(
      "INSERT OR IGNORE INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)"
    ),

    getAiSettings: db.prepare("SELECT * FROM ai_settings WHERE user_id = ?"),
    firstConfiguredAiSettings: db.prepare(
      "SELECT user_id FROM ai_settings WHERE enabled = 1 AND api_key_encrypted IS NOT NULL " +
      "AND base_url <> '' AND model <> '' ORDER BY created_at ASC LIMIT 1"
    ),
    upsertAiSettings: db.prepare(
      "INSERT INTO ai_settings (user_id, enabled, provider, base_url, model, api_key_encrypted, key_hint, temperature, max_output_tokens, max_moves_per_game, monthly_call_limit, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, provider = excluded.provider, base_url = excluded.base_url, model = excluded.model, " +
      "api_key_encrypted = excluded.api_key_encrypted, key_hint = excluded.key_hint, temperature = excluded.temperature, " +
      "max_output_tokens = excluded.max_output_tokens, max_moves_per_game = excluded.max_moves_per_game, " +
      "monthly_call_limit = excluded.monthly_call_limit, updated_at = excluded.updated_at"
    ),
    deleteAiSettingsKey: db.prepare(
      "UPDATE ai_settings SET api_key_encrypted = NULL, key_hint = NULL, updated_at = ? WHERE user_id = ?"
    ),

    insertAiUsage: db.prepare(
      "INSERT INTO ai_usage (user_id, game_id, kind, provider, model, input_tokens, output_tokens, created_at, requested_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    updateAiUsage: db.prepare("UPDATE ai_usage SET input_tokens = ?, output_tokens = ?, model = ? WHERE id = ?"),
    countRequestedUsage: db.prepare("SELECT COUNT(*) AS count FROM ai_usage WHERE requested_by_user_id = ? AND created_at >= ? AND user_id <> requested_by_user_id"),
    sumAiUsageSince: db.prepare(
      "SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens " +
      "FROM ai_usage WHERE user_id = ? AND created_at >= ?"
    ),
    countAiUsage: db.prepare(
      "SELECT COUNT(*) AS count FROM ai_usage WHERE user_id = ? AND game_id = ? AND kind = ?"
    ),

    getCoachReport: db.prepare("SELECT * FROM coach_reports WHERE game_id = ?"),
    upsertCoachReport: db.prepare(
      "INSERT INTO coach_reports (game_id, user_id, status, source, provider, model, report, error, input_tokens, output_tokens, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(game_id) DO UPDATE SET user_id = excluded.user_id, status = excluded.status, source = excluded.source, provider = excluded.provider, " +
      "model = excluded.model, report = excluded.report, error = excluded.error, input_tokens = excluded.input_tokens, " +
      "output_tokens = excluded.output_tokens, updated_at = excluded.updated_at"
    ),
    insertCoachMessage: db.prepare(
      "INSERT INTO coach_messages (game_id, user_id, role, content, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ),
    listCoachMessages: db.prepare(
      "SELECT * FROM coach_messages WHERE game_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?"
    )
  };

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    transaction,

    createUser(user) {
      statements.insertUser.run(user.id, user.email, user.displayName, user.passwordHash, user.createdAt);
    },
    findUserByEmail(email) {
      return mapUserRow(statements.findUserByEmail.get(email));
    },
    findUserById(id) {
      return mapUserRow(statements.findUserById.get(id));
    },
    setUserAdmin(userId, isAdmin) {
      statements.setUserAdmin.run(isAdmin ? 1 : 0, userId);
    },
    getSiteSetting(key) {
      return statements.getSiteSetting.get(key)?.value ?? null;
    },
    setSiteSetting(key, value, updatedAt) {
      statements.setSiteSetting.run(key, String(value), updatedAt);
    },

    createSession(session) {
      statements.insertSession.run(session.tokenHash, session.userId, session.createdAt, session.expiresAt);
    },
    findSession(tokenHash) {
      const row = statements.findSession.get(tokenHash);
      if (!row) return null;
      return { tokenHash: row.token_hash, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at };
    },
    deleteSession(tokenHash) {
      statements.deleteSession.run(tokenHash);
    },
    deleteExpiredSessions(now) {
      statements.deleteExpiredSessions.run(now);
    },

    insertGame(game) {
      statements.insertGame.run(
        game.id,
        game.roomCode,
        game.mode,
        game.status,
        game.playerCount,
        game.hostUserId,
        game.ownerUserId,
        game.createdAt,
        game.startedAt,
        game.finishedAt,
        JSON.stringify(game.initialState),
        JSON.stringify(game.currentState),
        JSON.stringify(game.seats),
        game.result === null ? null : JSON.stringify(game.result),
        game.metrics === null ? null : JSON.stringify(game.metrics),
        game.analysis === null ? null : JSON.stringify(game.analysis)
      );
    },
    getGame(id) {
      return mapGameRow(statements.getGame.get(id));
    },
    getGameByRoomCode(roomCode) {
      return mapGameRow(statements.getGameByRoomCode.get(roomCode));
    },
    listGames(mode = null) {
      const sql = mode
        ? "SELECT * FROM games WHERE mode = ? ORDER BY created_at DESC, id DESC"
        : "SELECT * FROM games ORDER BY created_at DESC, id DESC";
      return db.prepare(sql).all(...(mode ? [mode] : [])).map(mapGameRow);
    },
    updateGame(id, fields) {
      const assignments = [];
      const values = [];
      for (const [field, value] of Object.entries(fields)) {
        const column = COLUMN_BY_FIELD[field];
        if (!column) throw new Error("Unsupported game column: " + field);
        assignments.push(column + " = ?");
        if (JSON_COLUMNS.has(column)) values.push(value === null || value === undefined ? null : JSON.stringify(value));
        else values.push(value === undefined ? null : value);
      }
      if (assignments.length === 0) return;
      values.push(id);
      db.prepare("UPDATE games SET " + assignments.join(", ") + " WHERE id = ?").run(...values);
    },
    deleteGame(id) {
      statements.deleteGame.run(id);
    },

    insertAction(action) {
      statements.insertAction.run(
        action.gameId,
        action.seq,
        action.turn,
        action.seat,
        action.type,
        action.x,
        action.y,
        action.notation,
        JSON.stringify(action.action),
        action.createdAt
      );
    },
    listActions(gameId) {
      return statements.listActions.all(gameId).map(mapActionRow);
    },

    ensureUser(user) {
      statements.ensureUser.run(user.id, user.email, user.displayName, user.passwordHash ?? "", user.createdAt);
    },

    getAiSettings(userId) {
      return mapAiSettingsRow(statements.getAiSettings.get(userId));
    },
    firstConfiguredAiSettingsUserId() {
      return statements.firstConfiguredAiSettings.get()?.user_id ?? null;
    },
    upsertAiSettings(settings) {
      statements.upsertAiSettings.run(
        settings.userId,
        settings.enabled ? 1 : 0,
        settings.provider,
        settings.baseUrl,
        settings.model,
        settings.apiKeyEncrypted ?? null,
        settings.keyHint ?? null,
        settings.temperature,
        settings.maxOutputTokens,
        settings.maxMovesPerGame,
        settings.monthlyCallLimit,
        settings.createdAt,
        settings.updatedAt
      );
    },
    deleteAiSettingsKey(userId, updatedAt) {
      statements.deleteAiSettingsKey.run(updatedAt, userId);
    },

    insertAiUsage(usage) {
      const inserted = statements.insertAiUsage.run(
        usage.userId,
        usage.gameId ?? null,
        usage.kind,
        usage.provider ?? null,
        usage.model ?? null,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.createdAt,
        usage.requestedByUserId ?? usage.userId
      );
      return Number(inserted.lastInsertRowid);
    },
    completeAiUsage(id, completion) {
      statements.updateAiUsage.run(completion.usage?.inputTokens ?? 0, completion.usage?.outputTokens ?? 0, completion.model ?? null, id);
    },
    countRequestedUsage(userId, since) {
      return Number(statements.countRequestedUsage.get(userId, since)?.count ?? 0);
    },
    sumAiUsageSince(userId, since) {
      const row = statements.sumAiUsageSince.get(userId, since);
      return {
        calls: Number(row?.calls ?? 0),
        inputTokens: Number(row?.input_tokens ?? 0),
        outputTokens: Number(row?.output_tokens ?? 0)
      };
    },
    countAiUsage(userId, gameId, kind) {
      const row = statements.countAiUsage.get(userId, gameId, kind);
      return Number(row?.count ?? 0);
    },

    getCoachReport(gameId) {
      return mapCoachReportRow(statements.getCoachReport.get(gameId));
    },
    upsertCoachReport(report) {
      statements.upsertCoachReport.run(
        report.gameId,
        report.userId,
        report.status,
        report.source,
        report.provider ?? null,
        report.model ?? null,
        JSON.stringify(report.report),
        report.error ?? null,
        report.inputTokens ?? 0,
        report.outputTokens ?? 0,
        report.createdAt,
        report.updatedAt
      );
    },
    insertCoachMessage(message) {
      const result = statements.insertCoachMessage.run(
        message.gameId,
        message.userId,
        message.role,
        message.content,
        message.inputTokens ?? 0,
        message.outputTokens ?? 0,
        message.createdAt
      );
      return Number(result.lastInsertRowid);
    },
    listCoachMessages(gameId, limit = 50, userId) {
      return statements.listCoachMessages.all(gameId, userId ?? "", limit).reverse().map(mapCoachMessageRow);
    }
  };
}
