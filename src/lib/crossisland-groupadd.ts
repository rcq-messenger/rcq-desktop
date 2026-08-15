// Federation §5c — putting a contact who lives on ANOTHER island into a group.
//
// The group's island has no account for a foreign uin, so `POST
// /groups/{id}/members` answers "no such user". The way round it, mirroring
// Android's `Session.addCrossIslandGroupMember`, is to give that island an
// account to point at: resolve the contact's PUBLIC keys there, or register
// them if nobody has, and put THAT uin in the roster. When the contact later
// opens the invite link their island-recovery is keyed by the same signing key,
// so they land on the very uin we added and the group is simply already theirs.
//
// ⚠ The uin is per-island. Adding a local contact's number to a group that
// lives elsewhere would enrol whoever happens to hold that number over there —
// the same mistake that had the web calling a stranger in §5d. Everything here
// is keyed by the SIGNING KEY, which is the same person on every island.

/// The uin an island has issued to this signing key, or null if it has none.
export async function resolveUinOnIsland(
  host: string,
  signingKeyB64: string,
): Promise<number | null> {
  try {
    const url = `https://${host}/federation/uin-for-key?signing_key=${encodeURIComponent(signingKeyB64)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const body = (await res.json()) as { uin?: number }
    return typeof body.uin === 'number' ? body.uin : null
  } catch {
    return null
  }
}

/// Register a contact's PUBLIC keys on `host` so the roster has a local uin to
/// hold. Only public material travels — this mints a shell account the contact
/// then recovers with their own private key.
export async function registerForeignKeysOn(
  host: string,
  identityKeyB64: string,
  signingKeyB64: string,
  nickname: string,
): Promise<number | null> {
  try {
    const res = await fetch(`https://${host}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nickname,
        identity_key: identityKeyB64,
        signing_key: signingKeyB64,
      }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { uin?: number }
    return typeof body.uin === 'number' ? body.uin : null
  } catch {
    return null
  }
}

/// Resolve-or-mint in one call: the uin `host` knows this person by.
export async function uinForContactOnIsland(
  host: string,
  contact: { identityKey: string; signingKey: string; nickname: string; uin: number },
): Promise<number | null> {
  const known = await resolveUinOnIsland(host, contact.signingKey)
  if (known != null) return known
  return registerForeignKeysOn(
    host,
    contact.identityKey,
    contact.signingKey,
    contact.nickname.trim() || `user-${contact.uin}`,
  )
}

/// The shareable form of a group invite. Always carries the host, because a
/// bare id means "on my own island" to the parser and the joiner's island is
/// not necessarily ours.
export function groupInviteLink(gid: number, host: string): string {
  return `https://rcq.app/g/${gid}@${host}`
}

/// Turn the island's 403 detail into a key our dictionaries carry. The router
/// emits three distinct reasons and they mean genuinely different things to the
/// person pressing the button, so they are not collapsed into "failed".
export function addMemberReasonKey(message: string | null | undefined): string {
  const m = message || ''
  if (m.includes('the group owner has blocked this user')) return 'group.add.err.blocked'
  if (m.includes('only accepts group invites from their contacts')) return 'group.add.err.contacts_only'
  if (m.includes('does not accept group invites')) return 'group.add.err.nobody'
  if (m.includes('no such user')) return 'group.add.err.no_user'
  return 'group.add.err.failed'
}
