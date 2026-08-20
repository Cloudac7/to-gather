PRAGMA foreign_keys = ON;

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  join_code_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting_partner','filling','partially_submitted','revealed','reopen_pending','expired')),
  current_round INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
  nickname TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(room_id, slot),
  UNIQUE(room_id, token_hash)
);

CREATE TABLE rounds (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  revealed_at TEXT,
  PRIMARY KEY(room_id, round_number)
);

CREATE TABLE answers (
  room_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(room_id, round_number, participant_id),
  FOREIGN KEY(room_id, round_number) REFERENCES rounds(room_id, round_number) ON DELETE CASCADE
);

CREATE TABLE reopen_votes (
  room_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(room_id, round_number, participant_id),
  FOREIGN KEY(room_id, round_number) REFERENCES rounds(room_id, round_number) ON DELETE CASCADE
);

CREATE INDEX idx_rooms_expiry ON rooms(expires_at);
CREATE INDEX idx_participants_room ON participants(room_id);
CREATE INDEX idx_answers_round ON answers(room_id, round_number);
