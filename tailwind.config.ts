import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "var(--bg)",
        surface: "var(--surface)",
        surface2: "var(--surface2)",
        accent: "var(--accent)",
        accent2: "var(--accent2)",
        muted: "var(--muted)",
        text: "var(--text)",
        border: "var(--border)",
      },
      fontFamily: {
        title: ["Bebas Neue", "sans-serif"],
        body: ["DM Sans", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
