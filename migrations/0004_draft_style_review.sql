-- نتيجة مدقّق الأسلوب (src/prompts/review.ts) لآخر نسخة من المسودة، JSON: {passed, total, failed}.
-- NULL للمسودات الأقدم، أو حين تعذّرت المراجعة.
ALTER TABLE drafts ADD COLUMN style_review TEXT;
