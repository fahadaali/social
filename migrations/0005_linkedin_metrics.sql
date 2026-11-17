-- أرقام منشورات لينكدن من GET /v1/platforms/linkedin/insights، تُسحب يومي 1 و16 من كل شهر وتُحفظ هنا،
-- لأن المسار لا يغطي إلا آخر 5 منشورات للحساب الشخصي، ومسار المقاييس الحية لا يدعم لينكدن (NOTES.md).
-- صف لكل منشور على لينكدن، تُحدَّث أرقامه في كل سحب ما دام ضمن آخر 5، ثم تبقى آخر قيمة مسجّلة.
CREATE TABLE IF NOT EXISTS linkedin_metrics (
  linkedin_post_id TEXT PRIMARY KEY,
  draft_id INTEGER,
  permalink TEXT,
  impressions INTEGER,
  unique_views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_linkedin_metrics_draft ON linkedin_metrics (draft_id);
