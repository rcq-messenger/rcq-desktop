/** @type {import('tailwindcss').Config} */
// Same palette as the landing page (web/tailwind.config.cjs) so the
// brand reads as one product across rcq.app and chat.rcq.app.
//
// Colors are wired through CSS custom properties so a single class
// flip on <html> swaps the entire surface between light and dark.
// Tailwind v3 understands the `rgb(var(--x) / <alpha-value>)` form
// and forwards alpha modifiers (`bg-accent/20` etc.) correctly. The
// concrete values for both themes live in `src/index.css`.
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: {
          black: 'rgb(var(--c-ink-black) / <alpha-value>)',
          900: 'rgb(var(--c-ink-900) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          dim: 'rgb(var(--c-accent-dim) / <alpha-value>)',
          soft: 'rgb(var(--c-accent-soft) / <alpha-value>)',
        },
        surface: {
          DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)',
          dim: 'rgb(var(--c-surface-dim) / <alpha-value>)',
        },
        line: 'rgb(var(--c-line) / <alpha-value>)',
        fg: {
          primary: 'rgb(var(--c-fg-primary) / <alpha-value>)',
          secondary: 'rgb(var(--c-fg-secondary) / <alpha-value>)',
          dim: 'rgb(var(--c-fg-dim) / <alpha-value>)',
        },
        bubble: {
          self: 'rgb(var(--c-bubble-self) / <alpha-value>)',
          other: 'rgb(var(--c-bubble-other) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Inter', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SF Mono', 'Menlo', 'JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
