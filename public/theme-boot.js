// Decide the palette BEFORE the first paint. The theme class is written by the
// React provider, which cannot run until the bundle is parsed, so every reload
// used to paint one light frame first — a white flash on a black window, most
// visible in the desktop app where adding or removing an account reloads the
// page on purpose.
//
// ⚠ This lives in its own file rather than inline in index.html, and the reason
// is the Content-Security-Policy on chat.rcq.app. `script-src 'self'` blocks
// inline scripts, which is the whole point of having it — an injected <script>
// in our own page is exactly the attack that makes localStorage a topic. The
// alternatives were a hash of this snippet hardcoded in the Caddyfile (which
// silently rots the moment anyone edits these lines, and rots into a white
// flash nobody connects to a header) or 'unsafe-inline' (which is the same as
// having no policy). A same-origin file has neither problem.
//
// Same key and same rule as lib/theme-context.tsx; keep them together. Wrapped
// in try/catch because localStorage throws outright in a webview with site data
// disabled, and a theme must never cost us the app.
try {
  var p = localStorage.getItem('rcq.web.chat.theme')
  var dark =
    p === 'dark' ||
    ((!p || p === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) {
    document.documentElement.classList.add('dark')
    document.documentElement.style.colorScheme = 'dark'
  }
} catch (e) {}
