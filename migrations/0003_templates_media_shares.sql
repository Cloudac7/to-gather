ALTER TABLE rooms ADD COLUMN template_json TEXT NOT NULL DEFAULT '{"title":"这样的两个人，是亲友？","subtitle":"不知道啊，我们就玩到一起了","fieldLabels":{"favoriteAnimal":"最喜欢的动物","favoriteColor":"最喜欢的颜色","favoritePerson":"最喜欢的人物","favoriteSong":"最喜欢的歌","mbti":"MBTI","recentProduct":"最近买的产品","dreamActivity":"最想和对方一起做的事情","curiousAbout":"想问但一直没认真了解的","message":"自由发言（搏击）区"}}';

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  owner_participant_id TEXT NOT NULL,
  pair_participant_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  fingerprint TEXT NOT NULL,
  snapshot_json TEXT,
  poster_key TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  cleaned_at TEXT
);

CREATE TABLE share_assets (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  PRIMARY KEY (share_id, asset_id),
  UNIQUE (share_id, object_key)
);

CREATE INDEX idx_shares_owner ON shares(room_id, owner_participant_id, created_at DESC);
CREATE INDEX idx_shares_reuse ON shares(room_id, owner_participant_id, pair_participant_id, round_number, fingerprint, status);
CREATE INDEX idx_shares_expiry ON shares(status, expires_at);
CREATE INDEX idx_share_assets_key ON share_assets(object_key);
