// Adding people to a group you are already in.
//
// The web had no way to do this at all: group info listed the roster and could
// only take people OUT of it. The island has always allowed it — "any current
// member can pull in friends", `groups.py` — so the gap was purely the missing
// screen, and both phones have had one for months.
//
// Two paths behind one list, because the person picking a name should not have
// to know which one they are on:
//   • someone on this group's own island  → POST /groups/{id}/members
//   • someone from another island (§5c)   → resolve-or-mint their uin THERE
//     first (crossisland-groupadd), add that, then send them the invite link so
//     their client learns the group exists.
// The invite link is also offered on its own, for the people who are not in the
// roster yet: it is the only route that works for a stranger.

import { useEffect, useMemo, useState } from 'react'
import { roomKey, sendRoomKeyTo } from '../lib/group-state'
import { Api, type Contact, type RCQGroup, type UserStatus } from '../lib/api'
import type { WebIdentity } from '../lib/crypto'
import { newUUIDv4 } from '../lib/crypto'
import { contactsCache, restoreSnapshot } from '../lib/contacts-cache'
import { listCrossIsland } from '../lib/crossisland-store'
import { addMemberReasonKey, groupInviteLink, uinForContactOnIsland } from '../lib/crossisland-groupadd'
import { deliverCrossIsland } from '../lib/federation-send'
import { hostOfApiBase } from '../lib/multihome'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { PersonAvatar } from './PersonAvatar'

interface Props {
  group: RCQGroup
  /// The identity the group's island answers to — a guest clone for a foreign
  /// group, the primary one otherwise. Same value GroupInfo passes everywhere.
  ident: WebIdentity
  /// Server-side group id on that island (not the local alias).
  gid: number
  /// Island the group lives on, null when it is our own.
  host: string | null
  onAdded: (g: RCQGroup) => void
  onClose: () => void
}

/// One row of the picker, flattened out of the two contact stores so the list
/// does not have to branch while rendering.
interface Candidate {
  key: string
  uin: number
  nickname: string
  identityKey: string
  signingKey: string
  /// Island this person lives on. Null = ours.
  host: string | null
  status: UserStatus
  avatarMediaId?: string | null
  avatarMediaKey?: string | null
}

export function AddMemberSheet({ group, ident, gid, host, onAdded, onClose }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState<{ key: string; name: string; reason: string }[]>([])
  const [copied, setCopied] = useState(false)
  const [query, setQuery] = useState('')
  /// The roster of people I know. Read from the warm cache when there is one,
  /// but this screen is reachable without ever passing through the contact list
  /// — a reload straight onto /groups/<id>, or a link from a chat — and there
  /// the cache is cold and the picker said "everyone you know is already here"
  /// to someone with a full address book. So: rehydrate from disk, then refresh
  /// from the island behind it.
  const [contacts, setContacts] = useState<Contact[]>(() => {
    if (!identity) return []
    restoreSnapshot(identity.uin)
    return contactsCache.get(identity.uin)?.contacts ?? []
  })
  useEffect(() => {
    if (!identity) return
    let alive = true
    void Api.contacts(identity)
      .then((list) => {
        if (alive) setContacts(list)
      })
      .catch(() => {
        /* offline — the persisted snapshot is what we show */
      })
    return () => {
      alive = false
    }
  }, [identity])

  const ownHost = identity ? hostOfApiBase(identity.apiBase) : 'api.rcq.app'
  const groupHost = host ?? ownHost
  const link = groupInviteLink(gid, groupHost)

  const candidates = useMemo<Candidate[]>(() => {
    if (!identity) return []
    const rows: Candidate[] = [
      ...contacts
        .filter((c) => !c.blocked)
        // A federated contact already carries its own host and belongs to the
        // cross-island branch below; listing it twice would offer two buttons
        // that do different things under one name.
        .filter((c) => !c.host)
        .map((c) => ({
          key: `l:${c.uin}`,
          uin: c.uin,
          nickname: c.nickname || `#${c.uin}`,
          identityKey: c.identity_key,
          signingKey: c.signing_key,
          host: null,
          status: c.status,
          avatarMediaId: c.avatar_media_id,
          avatarMediaKey: c.avatar_media_key,
        })),
      ...listCrossIsland().map((c) => ({
        key: `c:${c.uin}@${c.host}`,
        uin: c.uin,
        nickname: c.nickname || `#${c.uin}`,
        identityKey: c.identityKey,
        signingKey: c.signingKey,
        host: c.host,
        // Presence is not tracked across islands, so the flower stays grey.
        status: 'offline' as UserStatus,
        avatarMediaId: c.avatarMediaId,
        avatarMediaKey: c.avatarMediaKey,
      })),
    ]
    // Hide people already in the roster — but only for a group on our own
    // island. On a foreign one the roster's uins are that island's numbering,
    // so matching them against local ones would hide the wrong people (and
    // show the wrong ones as addable). The island's add is idempotent, so the
    // worst case there is a no-op.
    const members = new Set(group.members.map((m) => m.uin))
    const filtered = host == null ? rows.filter((r) => r.host != null || !members.has(r.uin)) : rows
    const q = query.trim().toLowerCase()
    return filtered
      .filter((r) => !q || r.nickname.toLowerCase().includes(q) || String(r.uin).includes(q))
      .sort((a, b) => a.nickname.localeCompare(b.nickname))
  }, [identity, contacts, group.members, host, query])

  async function addOne(c: Candidate): Promise<string | null> {
    // Same island as the group: the plain roster call.
    const sameIsland = (c.host ?? ownHost).toLowerCase() === groupHost.toLowerCase()
    if (sameIsland) {
      try {
        const updated = await Api.addGroupMember(ident, gid, c.uin)
        onAdded(updated)
        // Stage 6 phase 2: the inviter hands the new member the room state
        // key at the moment of adding (design doc, road 3). Best-effort - a
        // missed hand-off is one gsknack away.
        const held = roomKey(gid)
        const fresh = updated.members?.find((m) => m.uin === c.uin)
        if (held && fresh?.identity_key) {
          void sendRoomKeyTo(ident, fresh, gid, held.v, held.k).catch(() => undefined)
        }
        return null
      } catch (e) {
        return addMemberReasonKey(e instanceof Error ? e.message : null)
      }
    }
    // §5c: give the group's island a uin for this person, then add THAT.
    const there = await uinForContactOnIsland(groupHost, {
      identityKey: c.identityKey,
      signingKey: c.signingKey,
      nickname: c.nickname,
      uin: c.uin,
    })
    if (there == null) return 'group.add.err.unreachable'
    try {
      onAdded(await Api.addGroupMember(ident, gid, there))
    } catch (e) {
      return addMemberReasonKey(e instanceof Error ? e.message : null)
    }
    // Tell them, in the only channel we share: a 1:1 that renders as a join
    // card. Without it the group is on their island and nothing has said so.
    if (identity && c.host) {
      try {
        await deliverCrossIsland(
          identity,
          c.host,
          c.uin,
          { kind: 'text', id: newUUIDv4(), text: link },
          { identityKey: c.identityKey, signingKey: c.signingKey },
        )
      } catch {
        /* added regardless; the roster broadcast is the source of truth */
      }
    }
    return null
  }

  async function submit() {
    if (picked.size === 0) return
    setBusy(true)
    setFailures([])
    const failed: { key: string; name: string; reason: string }[] = []
    for (const key of picked) {
      const c = candidates.find((x) => x.key === key)
      if (!c) continue
      const err = await addOne(c)
      if (err) failed.push({ key: c.key, name: c.nickname, reason: t(err) })
    }
    setBusy(false)
    if (failed.length === 0) {
      onClose()
      return
    }
    setFailures(failed)
    // Keep only what did not land, so a second press retries exactly those and
    // does not re-add the ones that already went through.
    setPicked(new Set(failed.map((f) => f.key)))
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard denied — the link is on screen and selectable */
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface w-full sm:max-w-md sm:rounded-lg rounded-t-2xl shadow-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-4">
          <div className="font-semibold">{t('group.add.title')}</div>
          <button
            onClick={onClose}
            className="text-fg-secondary hover:text-fg-primary px-2"
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </header>

        <div className="px-4 pb-3 space-y-2">
          <button
            type="button"
            onClick={() => void copyLink()}
            className="w-full flex items-center gap-3 h-11 px-3 rounded-md bg-field hover:bg-line/50 transition-colors text-left"
          >
            <LinkIcon />
            <span className="flex-1 text-sm">{copied ? t('group.add.link_copied') : t('group.add.link')}</span>
          </button>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('group.add.search')}
            className="w-full h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {candidates.length === 0 && (
            <div className="text-center text-sm text-fg-secondary px-6 py-8">
              {t('group.add.nobody')}
            </div>
          )}
          <ul>
            {candidates.map((c) => {
              const on = picked.has(c.key)
              return (
                <li key={c.key}>
                  <button
                    onClick={() =>
                      setPicked((prev) => {
                        const next = new Set(prev)
                        if (next.has(c.key)) next.delete(c.key)
                        else next.add(c.key)
                        return next
                      })
                    }
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-field transition-colors text-left"
                  >
                    <PersonAvatar
                      status={c.status}
                      crossIsland={c.host != null}
                      size={22}
                      mediaId={c.avatarMediaId}
                      mediaKey={c.avatarMediaKey}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-sm">{c.nickname}</span>
                      <span className="block text-[0.625rem] text-fg-dim">
                        #{c.uin}
                        {c.host ? ` · ${c.host}` : ''}
                      </span>
                    </span>
                    <span
                      className={
                        'w-5 h-5 rounded-full border-2 flex items-center justify-center text-[0.625rem] font-bold ' +
                        (on ? 'bg-accent border-accent text-white' : 'border-line')
                      }
                    >
                      {on ? '✓' : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="p-4 space-y-2">
          {failures.length > 0 && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2 space-y-0.5">
              {failures.map((f) => (
                <div key={f.key}>
                  <span className="font-medium">{f.name}</span>: {f.reason}
                </div>
              ))}
            </div>
          )}
          <button
            onClick={() => void submit()}
            disabled={busy || picked.size === 0}
            className="w-full h-11 rounded-md bg-accent hover:bg-accent-dim text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? t('group.add.busy') : t('group.add.cta', { n: picked.size })}
          </button>
        </div>
      </div>
    </div>
  )
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-fg-secondary" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}
