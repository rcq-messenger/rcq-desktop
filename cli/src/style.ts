// Terminal colour, the restrained kind: meta recedes (dim), people stand out
// (one stable colour per uin), our own lines and confirmations are the accent
// green. Nothing blinks, nothing is inverted, no backgrounds — the goal is a
// screen that reads at a glance, not a christmas tree (founder, 21.08).
//
// Pipes stay BARE. Every helper answers plain text unless the stream it is
// written to is a TTY, and `NO_COLOR` (https://no-color.org) turns everything
// off at once — so `rcq send | jq` and cron logs never see an escape byte.

const wantColor = (tty: boolean): boolean => tty && !process.env.NO_COLOR

const OUT = wantColor(!!process.stdout.isTTY)
const ERR = wantColor(!!process.stderr.isTTY)

const wrap = (on: boolean, open: string, close: string) => (s: string) =>
  on ? `\x1b[${open}m${s}\x1b[${close}m` : s

/// Styles for stdout (message lines).
export const out = {
  dim: wrap(OUT, '2', '22'),
  bold: wrap(OUT, '1', '22'),
  green: wrap(OUT, '32', '39'),
  red: wrap(OUT, '31', '39'),
}

/// Styles for stderr (status lines).
export const err = {
  dim: wrap(ERR, '2', '22'),
  green: wrap(ERR, '32', '39'),
  yellow: wrap(ERR, '33', '39'),
}

// One colour per correspondent, stable across runs: the uin picks from a
// palette the way IRC clients have always done it. 256-colour codes chosen to
// stay readable on both dark and light terminals; the fallback for a pipe is
// simply no colour, handled by `wrap`.
const PEER_COLORS = ['36', '35', '33', '34', '32', '96', '95', '94'] as const

export function peer(uin: number, label: string): string {
  if (!OUT) return label
  const c = PEER_COLORS[uin % PEER_COLORS.length]
  return `\x1b[${c}m${label}\x1b[39m`
}
