// Vite's `?raw` import (a file's text as a string), used by tests that read constants from the source. No import or
// export here, so this stays an ambient declaration for `tsc -p test`.
declare module '*?raw' {
  const text: string;
  export default text;
}
