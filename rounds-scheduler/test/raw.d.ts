// Vite's ?raw imports, for test/subrequests.e2e.test.ts reading the [limits] in wrangler.toml.
declare module '*?raw' {
  const text: string;
  export default text;
}
