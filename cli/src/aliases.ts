// Short forms for every command, resolved in one place.
//
// The founder asked twice for shortcuts. Both dispatchers read the same table:
// the top-level verb switch in main.ts and the slash switch in interactive.ts.
// Help (usage + interactive.help in i18n.ts) is hand-written to match, so the
// annotations a person reads and the aliases the code accepts cannot drift.
//
// ⚠ No ambiguous collisions. A single letter names exactly one verb: `r` is
// `requests` in both namespaces (recent is `rec`), `a` is `add` not `accept`
// (accept is `ac`), `b` is `block` not... nothing else starts a short here.
// When a new verb wants a letter that is taken, it gets a distinct short form
// rather than shadowing the one already there.

/// alias -> canonical verb. The canonical verbs are what the two switches case
/// on; a canonical verb typed in full is left alone by `canonical()` below.
const ALIASES: Record<string, string> = {
  // account + setup
  reg: 'register',
  isl: 'islands',
  sn: 'safety',
  rl: 'relays',
  res: 'restore',
  me: 'whoami',
  wi: 'whoami',
  n: 'nick',
  x: 'export',
  lng: 'lang',
  px: 'proxy',
  p: 'proxy',
  route: 'routes',
  // people
  c: 'contacts',
  w: 'who',
  f: 'find',
  a: 'add',
  req: 'requests',
  r: 'requests',
  ac: 'accept',
  dec: 'decline',
  can: 'cancel',
  b: 'block',
  ub: 'unblock',
  rm: 'remove',
  // rooms
  g: 'groups',
  j: 'join',
  lv: 'leave',
  part: 'leave',
  cr: 'create',
  inv: 'invite',
  // talking (one-shot + interactive)
  l: 'log',
  s: 'send',
  wt: 'watch',
  // interactive-only
  t: 'to',
  rec: 'recent',
  threads: 'recent',
  rt: 'retry',
  q: 'quit',
  exit: 'quit',
  h: 'help',
  '?': 'help',
}

/// Turn a verb a person typed (an alias, or the canonical verb itself) into the
/// canonical verb the dispatcher switches on. An unknown token is returned
/// unchanged, so the caller's own "unknown command" branch still fires.
export function canonical(verb: string): string {
  return ALIASES[verb] ?? verb
}
