// Groups, which the CLI used to answer for with "groups live in the apps".
//
// They never had to. The console runs the SAME sender-key code the web does
// (sender-keys.ts, sender-key-store.ts, group-crypto.ts are all React-free and
// localStorage-backed, and bootstrap.ts shims localStorage), so the only thing
// separating a terminal from a room was wiring. What lives here is that
// wiring: the room list off the warm snapshot, the roster fetch a send needs,
// the dual-send itself, and the room rules.
//
// ⚠ The rules are honoured HERE and not left to the island. The server does
// enforce owner-only posting and slowmode, but it answers with an HTTP status,
// and "403" on your screen after you typed a sentence is not a client telling
// you the room is read-only. Same exempt set as the web composer (owner,
// admin, any granted cap) so this never refuses a send the island would have
// taken, and never promises one it would have refused.

import { Api, ApiError, type GroupMember, type RCQGroup } from '../../src/lib/api'
import type { Envelope, TextEnvelope, WebIdentity } from '../../src/lib/crypto'
import { buildGroupDualSend, encryptGroupEnvelope } from '../../src/lib/group-crypto'
import { cachedGroups, groupSize } from './directory'
import { tr } from './i18n'
import { appendHistory, markSent } from './receive'
import { sendMessageCarbon } from './send'

/// Tell the island this account can read encrypt-once broadcasts.
///
/// ⚠⚠ Order matters and the reason is a message-loss bug, not a nicety. The
/// capability is per ACCOUNT, not per device: the moment it is set, every
/// capable sender broadcasts `gmsg` to the whole account and stops sealing the
/// legacy per-member copy. A client that advertises before it can open a
/// broadcast makes itself deaf and takes the account's other devices with it.
/// So this is called only from the paths that run the receive loop in this
/// file's sibling (receive.ts), which now opens, replays and files them.
let advertised = false
export function advertiseSenderKeys(identity: WebIdentity): void {
  if (advertised) return
  advertised = true
  void Api.advertiseCapabilities(identity, true).catch(() => {
    // Nothing to say: senders keep using the legacy fan-out, which the CLI
    // reads perfectly well. This only costs bandwidth, never a message.
  })
}

/// The group WITH its roster, cached briefly.
///
/// ⚠ Anything that encrypts per recipient has to come through here. The list
/// is fetched `?members=0` (the roster is the expensive half of a group
/// payload), and sealing against an empty roster produces NO ciphertexts at
/// all: the message looks sent and reaches nobody.
///
/// The cache is short on purpose. A member who joins while a prompt sits open
/// is invisible to a roster read once at `/g` time, and invisible means no
/// chain key sealed to them and a room they can watch but not read. A minute
/// is short enough for that to fix itself and long enough that a chatty
/// session is not one group fetch per line.
const ROSTER_TTL_MS = 60_000
const rosters = new Map<number, { group: RCQGroup; at: number }>()

export async function rosterFor(identity: WebIdentity, group: RCQGroup): Promise<RCQGroup> {
  const held = rosters.get(group.id)
  if (held && Date.now() - held.at < ROSTER_TTL_MS) return held.group
  if (group.members.length > 0 && !held) {
    rosters.set(group.id, { group, at: Date.now() })
    return group
  }
  let full: RCQGroup
  try {
    full = await Api.groupInfo(identity, group.id)
  } catch (e) {
    // Not a raw network error on the screen: what failed is a lookup nobody
    // asked for by name, and the consequence is the message, not the fetch.
    throw new Error(tr('group.rosterFailed', { name: group.name, err: describeGroupError(e) }))
  }
  const merged = { ...group, members: full.members, member_count: full.member_count ?? full.members.length }
  rosters.set(group.id, { group: merged, at: Date.now() })
  return merged
}

/// Owner, admin, or a member the owner granted a capability: the exact set the
/// island exempts from slowmode and the content rules.
function exempt(identity: WebIdentity, group: RCQGroup): boolean {
  if (group.owner_uin === identity.uin) return true
  const me = group.members.find((m) => m.uin === identity.uin)
  return me?.role === 'admin' || (me?.permissions?.length ?? 0) > 0
}

/// Why this text may not go into this room, or null when it may. Needs a
/// group whose roster has been loaded (moderator status lives on the rows).
export function ruleRefusal(identity: WebIdentity, group: RCQGroup, text: string): string | null {
  if (exempt(identity, group)) return null
  if (group.post_policy === 'owner_only') return tr('group.ownerOnly')
  // Same test as the web composer: a bare domain is a word, a scheme is a link.
  if (group.links_allowed === false && /https?:\/\//i.test(text)) return tr('group.noLinks')
  return null
}

/// The island's refusal, in words. Slowmode and owner-only are rules a person
/// can act on; anything else keeps its raw text rather than being flattened
/// into a shrug.
export function describeGroupError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e)
  if (e.status === 429) {
    let wait = 0
    try {
      const body = JSON.parse(e.body) as { detail?: { retry_after?: number } }
      wait = body.detail?.retry_after ?? 0
    } catch {
      /* an island that words its 429 differently still gets the plain line */
    }
    return wait > 0 ? tr('group.slowmodeWait', { sec: wait }) : tr('group.slowmode')
  }
  if (e.status === 403 && e.body.includes('owner_only')) return tr('group.ownerOnly')
  if (e.status === 404) return tr('group.gone')
  return e.message
}

/// One line about a room: name, size, and only the rules that are ON. A room
/// with no rules should read as a room with no rules, not as a form.
export function describeGroup(identity: WebIdentity, g: RCQGroup): string {
  const bits: string[] = [tr('group.members', { n: groupSize(g) })]
  if (g.owner_uin === identity.uin) bits.push(tr('group.youOwn'))
  if (g.post_policy === 'owner_only') bits.push(tr('group.ruleOwnerOnly'))
  if ((g.slowmode_sec ?? 0) > 0) bits.push(tr('group.ruleSlowmode', { sec: g.slowmode_sec ?? 0 }))
  if (g.links_allowed === false) bits.push(tr('group.ruleNoLinks'))
  return bits.join(', ')
}

/// Post one text into a group. Throws on failure, like `sendText`; the caller
/// runs it through `describeGroupError`.
///
/// The wire is the dual-send every other client performs: ONE ciphertext under
/// the sender-key chain for members whose account advertised the capability,
/// the chain itself sealed per member to whoever does not hold it yet, and the
/// legacy per-member fan-out for the rest. The order is not decorative: an
/// SKDM that lands after its broadcast is a member holding a packet they
/// cannot open until the recovery round trip completes.
export async function sendGroupText(
  identity: WebIdentity,
  group: RCQGroup,
  text: string,
): Promise<{ id: string; mode: string }> {
  const env: TextEnvelope = { kind: 'text', id: crypto.randomUUID().toUpperCase(), text }
  const gid = group.id
  const others = group.members.filter((m: GroupMember) => m.uin !== identity.uin)
  let mode: string
  if (others.length === 0) {
    // Everybody else left, or nobody joined. Android and the web both accept
    // this: there is no recipient, so there is no wire, and the row in the
    // history file is the whole of the message.
    mode = 'solo'
  } else if (others.some((m) => m.sender_keys)) {
    const ds = buildGroupDualSend(env, identity, gid, group.members)
    if (!ds.broadcastPayload && ds.legacyPayloads.length === 0) throw new Error(tr('group.noRecipients'))
    if (ds.skdmPayloads.length > 0) await Api.sendGroupSealed(identity, gid, ds.skdmPayloads, 'skdm')
    if (ds.broadcastPayload) {
      await Api.sendGroupBroadcast(identity, gid, ds.broadcastPayload, 'message')
      ds.commit() // ratchet + mark distributed only once the post has landed
    }
    if (ds.legacyPayloads.length > 0) await Api.sendGroupSealed(identity, gid, ds.legacyPayloads, 'message')
    mode = `gmsg+${ds.legacyPayloads.length}`
  } else {
    const { payloads, skipped } = encryptGroupEnvelope(env, identity, group.members)
    if (payloads.length === 0) throw new Error(tr('group.noRecipients'))
    await Api.sendGroupSealed(identity, gid, payloads, 'message')
    mode = `v1 x${payloads.length}${skipped.length ? ` (skipped ${skipped.length})` : ''}`
  }
  // Before the carbon, for the same reason as the 1:1 path: with a live socket
  // the island's echo of our own broadcast can beat the POST's own response,
  // and an unmarked id prints the line we just typed a second time.
  markSent(env.id)
  await sendMessageCarbon(identity, { gid }, env)
  appendHistory(identity.uin, { at: new Date().toISOString(), from: identity.uin, gid, envelope: env as Envelope })
  return { id: env.id, mode }
}

/// The rooms this account is in, by name, off the warm snapshot so the list is
/// instant and survives an unreachable island. Name order because that is what
/// `/g <name>` is typed against; the id is on the row for the other way.
export function listGroups(myUin: number): RCQGroup[] {
  return [...cachedGroups(myUin)].sort((a, b) => a.name.localeCompare(b.name))
}
