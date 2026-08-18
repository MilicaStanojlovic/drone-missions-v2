import type { Config } from "tailwindcss";

// Tailwind v4 is CSS-first (see src/app/globals.css `@theme`), but a config
// file is kept for editor/plugin tooling and explicit content globs. Loaded
// via `@config` in globals.css.
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
