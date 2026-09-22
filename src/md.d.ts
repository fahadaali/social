// ملفات config/*.md تُضمَّن كنصوص عند البناء عبر قاعدة Text في wrangler.toml
declare module '*.md' {
  const content: string;
  export default content;
}
