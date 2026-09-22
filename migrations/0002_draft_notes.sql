-- إضافة على مخطط SPEC §5 (انظر NOTES.md):
-- حفظ ملاحظات Claude (حقل notes في مخرجات الصياغة) مع المسودة،
-- حتى تبقى ظاهرة عند إعادة عرض المعاينة بعد أي تعديل.
ALTER TABLE drafts ADD COLUMN notes TEXT;
