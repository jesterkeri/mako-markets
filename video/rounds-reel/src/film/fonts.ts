import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

const faces: [string, string, string][] = [
  ["Bricolage Grotesque", "800", "bricolage-grotesque-latin-800-normal.woff2"],
  ["Bricolage Grotesque", "600", "bricolage-grotesque-latin-600-normal.woff2"],
  ["Inter", "400", "inter-latin-400-normal.woff2"],
  ["Inter", "500", "inter-latin-500-normal.woff2"],
  ["Inter", "600", "inter-latin-600-normal.woff2"],
  ["Inter", "700", "inter-latin-700-normal.woff2"],
  ["JetBrains Mono", "500", "jetbrains-mono-latin-500-normal.woff2"],
  ["JetBrains Mono", "700", "jetbrains-mono-latin-700-normal.woff2"],
];

export const fontsReady = Promise.all(
  faces.map(([family, weight, file]) => loadFont({ family, weight, url: staticFile(`fonts/${file}`), format: "woff2" })),
);
