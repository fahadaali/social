// ملفات الترحيل في migrations/ تُضمَّن نصوصاً عند البناء (قاعدة Text في wrangler.toml).
declare module '*.sql' {
  const content: string;
  export default content;
}
