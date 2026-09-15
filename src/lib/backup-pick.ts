// Which catalogue island takes an automatic backup copy, and what the toggle
// may do there (#988). ONE rule, the same on Android, iOS and here:
//
//   R1 probe   GET /health, then GET /server/info only once /health passed,
//              redirects off, an overall deadline per GET (body included),
//              /server/info refused past 64 KB, asked fresh on every use. A
//              redirect, a timeout, a network error, a non-2xx answer or an
//              unreadable /server/info makes the island SILENT.
//   R2 door    OPEN when `registration_policy` is "open" or absent AND
//              `closed_island` is not true. SHUT otherwise. A field that is
//              present with the wrong type is SHUT, and so is a JSON null: only
//              a field that is missing altogether counts as absent. The entry
//              price is not part of it: an island may sell residency with
//              registration open.
//   R3 act     One island at a time, in catalogue order, and stop at the first
//              copy. OPEN: recover-or-register as before; a 403 door refusal
//              means "no copy here, door shut" and the next island gets its turn
//              (recover already ran, it is not asked again). SHUT: recover only,
//              adopt a copy this account already has, never register. SILENT:
//              neither. Each island at most once.
//   R4 relay   only when EVERY island was SILENT, the catalogue that could not
//              be fetched or verified included, one more pass through the relay
//              with the same rules. A verified catalogue with no candidate left
//              is not silence: no relay pass.
//   R5 words   nothing answered: "no island reachable". Something answered, or
//              the verified catalogue had no candidate: "no open island".
//
// ⚠⚠ /health SAYS NOTHING ABOUT THE DOOR. The auto-pick used to take the
// first catalogue island that answered /health, and the catalogue lists the
// flagship. The flagship now sells entry (`registration_policy: "paid"`), so
// an account living on is2 switched the backup on, got the flagship as its
// pick, and `/auth/register` answered 403 `entry_required`, which the screen
// then printed as raw JSON. The door is on `/server/info`.
//
// Pure on purpose: no fetch, no storage, no React. The network half lives in
// multihome.ts and hands the answers in, so the rule and the order are proven
// offline in cli/test/backup-pick.mjs.

/// What the probe of one island amounts to (R1, R2).
export type HostVerdict = 'silent' | 'open' | 'shut'

/// One probe GET as the network half saw it. `null` in its place is a timeout
/// or a network error.
export interface ProbeAnswer {
  /// HTTP status. An opaque redirect (fetch with `redirect: 'manual'`) is 0.
  status: number
  /// True when the answer was a redirect of any kind. Redirects are never
  /// followed: an island that sends us elsewhere is not the island in the list.
  redirect: boolean
  /// The body as text, only read for /server/info. Null when it could not be
  /// read or ran past `INFO_BODY_CAP`.
  body?: string | null
}

/// The most of /server/info the probe will accept. The real answer is a couple
/// of KB; a body past this is refused whole, never cut down and parsed.
export const INFO_BODY_CAP = 64 * 1024

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/// R2 on the RAW `capabilities` value of /server/info (not the normalised
/// `ServerCapabilities`, whose defaults would read a malformed field as open).
/// `undefined` is an island older than the capabilities, and those were open.
/// ⚠ `null` is not `undefined`: a JSON null is a malformed field, so SHUT.
export function doorOf(capabilities: unknown): 'open' | 'shut' {
  if (capabilities === undefined) return 'open'
  if (!isRecord(capabilities)) return 'shut'
  const policy = capabilities.registration_policy
  if (policy !== undefined && policy !== 'open') return 'shut'
  const closed = capabilities.closed_island
  // ⚠ The server does not refuse registration on a closed island (only the
  // policy does), so the mailbox would be accepted. It is SHUT anyway: the
  // operator asked to keep the island to its own people.
  if (closed !== undefined && closed !== false) return 'shut'
  return 'open'
}

/// R2 on a /server/info body: an unparseable body, or one that is not an
/// object, is SILENT (R1), not SHUT. `JSON.parse` is a strict parser: no
/// comments, no trailing commas, no single quotes, no NaN.
export function infoVerdict(body: string): HostVerdict {
  let doc: unknown
  try {
    doc = JSON.parse(body)
  } catch {
    return 'silent'
  }
  if (!isRecord(doc)) return 'silent'
  return doorOf(doc.capabilities)
}

/// A probe GET that answered 2xx without a redirect (R1).
export function probePassed(a: ProbeAnswer | null | undefined): a is ProbeAnswer {
  if (!a || a.redirect) return false
  return a.status >= 200 && a.status < 300
}

/// R1 + R2 for one island from its two probe answers. `info` is null or absent
/// when it was never asked because /health did not pass.
export function hostVerdict(health: ProbeAnswer | null | undefined, info: ProbeAnswer | null | undefined): HostVerdict {
  if (!probePassed(health) || !probePassed(info)) return 'silent'
  if (typeof info.body !== 'string') return 'silent'
  return infoVerdict(info.body)
}

/// A response body as UTF-8 text, or null when it runs past `cap` bytes, is not
/// valid UTF-8, or breaks off (an aborted request included). Reads the stream
/// itself, so an island that streams megabytes is refused at the cap instead of
/// buffered whole.
export async function readCappedText(res: Response, cap: number = INFO_BODY_CAP): Promise<string | null> {
  try {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > cap) {
      void res.body?.cancel().catch(() => {})
      return null
    }
    if (!res.body) return ''
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) {
        void reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      bytes.set(c, offset)
      offset += c.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/// Which kind of door refused a registration. `entry` = the island sells
/// entry; `invite` = the island wants an access code from its operator.
export type DoorRefusal = 'entry' | 'invite'

/// The codes `/auth/register` answers when the door, not the request, is the
/// problem (rcq-server `routers/auth.py`). `invite_invalid` only comes back
/// when a code was sent, which the backup path never does, but it is the same
/// door and gets the same treatment should an island ever send it.
const DOOR_CODES: Record<string, DoorRefusal> = {
  entry_required: 'entry',
  invite_required: 'invite',
  invite_invalid: 'invite',
}

/// `detail.code` out of an error body, only when `detail` is an OBJECT with a
/// string `code`. A bare-string `detail` is not a code (D9), and a body that is
/// not JSON has none.
export function detailCodeOf(body: string): string | null {
  try {
    const doc: unknown = JSON.parse(body)
    if (!isRecord(doc) || !isRecord(doc.detail)) return null
    const code = doc.detail.code
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}

/// A door refusal, or null for any other failure. Exactly: HTTP 403, and a JSON
/// body whose `detail` is an object with `code` one of the door codes. The
/// error must name its status (`registerOnIsland` attaches `status` and
/// `body`): a code with no status, or on a 502 a proxy happened to echo, is not
/// the island's door.
export function doorRefusalOf(err: unknown): DoorRefusal | null {
  if (!err || typeof err !== 'object') return null
  const { status, body, message } = err as { status?: unknown; body?: unknown; message?: unknown }
  if (status !== 403) return null
  const text = typeof body === 'string' ? body : typeof message === 'string' ? message : null
  const code = text == null ? null : detailCodeOf(text)
  return code ? DOOR_CODES[code] ?? null : null
}

/// Every island stayed SILENT, the relay pass included (R5). Same message the
/// screen already maps to "no island reachable".
export const NO_ISLAND_REACHABLE = 'no island'
/// At least one island answered and none of them yielded a copy, or the
/// verified catalogue had no candidate left (R5).
export const NO_OPEN_ISLAND = 'no open island'

export type BackupPickPass = 'direct' | 'relay'

/// The network for one pass. The probe must be fresh (R1); a throw reads as
/// SILENT.
export interface BackupPickNet<T> {
  /// This pass's candidates: the signed catalogue in its order, exclusions
  /// already applied (own island, already-added hosts, fronts). A throw or
  /// null means the catalogue could not be fetched or did not verify, which
  /// counts as every island SILENT (D2).
  candidates: () => Promise<readonly string[] | null>
  probe: (host: string) => Promise<HostVerdict>
  /// The OPEN action: recover-or-register, as the client did before. Throws on
  /// failure; a 403 door refusal is recognised by `doorRefusalOf`.
  register: (host: string) => Promise<T>
  /// The SHUT action: take back an EXISTING copy only, never register. Null
  /// when this account has no copy there.
  recover: (host: string) => Promise<T | null>
}

export interface BackupPickDeps<T> {
  direct: BackupPickNet<T>
  /// The relay pass (R4), run once and only when every island was SILENT on
  /// the direct pass. Null or absent when the client has no such pass.
  relay?: BackupPickNet<T> | null
  /// Told right before an island is acted on, so the screen can name it.
  onTrying?: (host: string, pass: BackupPickPass) => void
}

export interface BackupPicked<T> {
  host: string
  result: T
  action: 'register' | 'recover'
  pass: BackupPickPass
}

/// What one pass came to: a copy, or "something answered" (an island, or a
/// verified catalogue with no candidate), or nothing answered at all.
type PassOutcome<T> = { picked: BackupPicked<T> } | { picked: null; answered: boolean }

async function runPass<T>(
  net: BackupPickNet<T>,
  pass: BackupPickPass,
  onTrying: BackupPickDeps<T>['onTrying'],
): Promise<PassOutcome<T>> {
  let listed: readonly string[] | null
  try {
    listed = await net.candidates()
  } catch {
    listed = null
  }
  // No verified catalogue: nothing answered (D2).
  if (!listed) return { picked: null, answered: false }
  const hosts = [...new Set(listed)]
  // A verified catalogue with nobody left in it is an answer, not silence: the
  // relays would find the same empty list (D2).
  if (hosts.length === 0) return { picked: null, answered: true }
  let answered = false
  // ⚠ One island at a time, in catalogue order (D3): probing all of them at
  // once asked every island in the list about this account's toggle when the
  // first one would have done.
  for (const host of hosts) {
    let verdict: HostVerdict
    try {
      const v = await net.probe(host)
      verdict = v === 'open' || v === 'shut' ? v : 'silent'
    } catch {
      verdict = 'silent'
    }
    if (verdict === 'silent') continue
    answered = true
    onTrying?.(host, pass)
    if (verdict === 'open') {
      try {
        return { picked: { host, result: await net.register(host), action: 'register', pass } }
      } catch {
        // ⚠ D4: `register` already ran its recover-first step here. A door
        // refusal means no copy on this island and the door is shut; any other
        // failure did not yield a copy either. Either way the next island gets
        // its turn, and this one is NOT asked to recover a second time.
        continue
      }
    }
    // SHUT: recover-only, exactly once. `register` is never reached from here.
    try {
      const result = await net.recover(host)
      if (result != null) return { picked: { host, result, action: 'recover', pass } }
    } catch {
      /* no copy came of it; next island */
    }
  }
  return { picked: null, answered }
}

/// R1-R5. Resolves with the first island that yielded a copy. Throws
/// `NO_ISLAND_REACHABLE` when nothing answered on any pass (a catalogue that
/// could not be fetched or verified included), `NO_OPEN_ISLAND` when something
/// answered and nothing came of it, or the verified catalogue had no candidate.
export async function pickBackupIsland<T>(deps: BackupPickDeps<T>): Promise<BackupPicked<T>> {
  const direct = await runPass(deps.direct, 'direct', deps.onTrying)
  if (direct.picked) return direct.picked
  let answered = direct.answered
  if (!answered && deps.relay) {
    const relayed = await runPass(deps.relay, 'relay', deps.onTrying)
    if (relayed.picked) return relayed.picked
    answered = relayed.answered
  }
  throw new Error(answered ? NO_OPEN_ISLAND : NO_ISLAND_REACHABLE)
}
