CREATE TABLE ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  pillar TEXT,                 -- محور المحتوى المصنّف آلياً
  source TEXT NOT NULL DEFAULT 'text', -- text | voice | photo
  status TEXT NOT NULL DEFAULT 'new',  -- new | drafted | published | archived
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER REFERENCES ideas(id),
  x_segments TEXT NOT NULL,    -- JSON array: التغريدة الأولى ثم بقية الثريد
  linkedin_text TEXT NOT NULL,
  snap_script TEXT,            -- سكربت سناب (للنشر اليدوي)
  needs_visual INTEGER NOT NULL DEFAULT 0,
  visual_brief TEXT,           -- وصف مقترح للتصميم في Claude Design
  media_id TEXT,               -- معرّف الوسائط في SocialAPI بعد الرفع
  platforms TEXT NOT NULL DEFAULT '["x","linkedin"]',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | scheduled | publishing | published | partial | failed | rejected
  socialapi_post_id TEXT,
  scheduled_at TEXT,
  published_at TEXT,
  telegram_message_id INTEGER, -- رسالة المعاينة لتحديثها
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE state (
  key TEXT PRIMARY KEY,        -- مثل: awaiting_edit, awaiting_image, reminders_paused, last_published_at
  value TEXT
);

CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
