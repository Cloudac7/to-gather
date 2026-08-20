PRAGMA foreign_keys = OFF;

CREATE TABLE participants_v2 (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
  nickname TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(room_id, token_hash)
);

INSERT INTO participants_v2 (id, room_id, slot, nickname, token_hash, recovery_hash, created_at)
SELECT id, room_id, slot, nickname, token_hash, recovery_hash, created_at FROM participants;

DROP TABLE participants;
ALTER TABLE participants_v2 RENAME TO participants;

CREATE UNIQUE INDEX idx_participants_single_host ON participants(room_id) WHERE slot = 1;
CREATE INDEX idx_participants_room ON participants(room_id);

PRAGMA foreign_keys = ON;
