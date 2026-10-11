-- مصدر صورة المسودة في تيليجرام (انظر NOTES.md القسم 2.2):
-- معرّف ملف تيليجرام (ثابت للبوت نفسه) ونوعه وحجمه، لإعادة تنزيل الصورة عند «تأكيد» النشر
-- ورفعها إلى X مباشرة، لأن معرّف وسائط X ينتهي بعد 24 ساعة فلا يُرفع مسبقاً.
ALTER TABLE drafts ADD COLUMN image_file_id TEXT;
ALTER TABLE drafts ADD COLUMN image_mime TEXT;
ALTER TABLE drafts ADD COLUMN image_size INTEGER;
