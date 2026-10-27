// The two Vite features the tests use (vitest runs on Vite): `?raw` text imports and eager `import.meta.glob`.
declare module '*?raw' {
  const text: string;
  export default text;
}
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true; import: 'default'; query?: string }): Record<string, T>;
}
