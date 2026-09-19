// Vite's ?raw imports (the config test reads wrangler.toml as text).
declare module '*?raw' {
  const contents: string;
  export default contents;
}
