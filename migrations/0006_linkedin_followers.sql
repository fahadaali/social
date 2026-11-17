-- عدد متابعي لينكدن في كل سحب (linkedin.ts)، ليُحسب نموّه في التقرير الشهري.
CREATE TABLE IF NOT EXISTS linkedin_followers (
  at TEXT PRIMARY KEY,
  follower_count INTEGER NOT NULL
);
