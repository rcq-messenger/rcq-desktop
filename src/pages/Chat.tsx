// 1:1 + group chat surface (send-only). The route shape encodes
// which thread is open:
//   /chat/<uin>      → 1:1 with a contact
//   /chat/g/<id>     → group with N members (per-member fan-out)
//
// Phase-1 doesn't render incoming messages — peer/group replies
// ride v=2 envelopes which need libsignal-WASM to decrypt. The
// outgoing log lives in component state; reloads wipe it.
//
// Outgoing log supports reactions, replies, and forwards on top of
// plain text. All three target rows IN THE OUTGOING LOG (we have no
// incoming yet). Forwards write into the target thread's storage
// so the forwarded message shows up there when the user navigates.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { EmoticonInput, insertEmoticonAt, serialize as serializeComposer } from '../components/EmoticonInput'
import { EmoticonPicker } from '../components/EmoticonPicker'
import { EmoticonText } from '../components/EmoticonText'
import { ForwardModal, type ForwardTarget } from '../components/ForwardModal'
import { ReactionPicker } from '../components/ReactionPicker'
import { PersonAvatar } from '../components/PersonAvatar'
import { SenderAvatar } from '../components/SenderAvatar'
import { Api, peerBundleFrom, type Contact, type PollOut, type RCQGroup, type UserInfo } from '../lib/api'
import {
  useIncoming,
  useGroupIncoming,
  setActiveThread,
  applyReaction,
  reactionsForTarget,
  aggregateReactions,
  useReactionsVersion,
  markDeleted,
  isDeleted,
  useDeletedVersion,
  type PollRow,
} from '../lib/incoming-store'
import { sendV2 } from '../lib/signal-device'
import { getCrossIsland } from '../lib/crossisland-store'
import { deliverCrossIsland } from '../lib/federation-send'
import { depositToExtraHomes } from '../lib/multihome'
import {
  encryptV1,
  bytesToB64,
  newUUIDv4,
  type CarbonEnvelope,
  type Envelope,
  type EditEnvelope,
  type DeleteEnvelope,
  type ReactionEnvelope,
  type ReplyContext,
  type TextEnvelope,
} from '../lib/crypto'
import {
  type OutgoingRow,
  storageKey,
  loadPersisted,
  savePersisted,
  appendToThreadLog,
  setOutgoingSink,
} from '../lib/outgoing-store'
import { buildGroupDualSend, encryptGroupEnvelope } from '../lib/group-crypto'
import { parseGroupInvite } from '../lib/group-invite'
import { groupApiCtx } from '../lib/visited-islands'
import { ensureRoster, memberCount } from '../lib/group-roster'
import { GroupJoinCard } from '../components/GroupJoinCard'
import { GroupAvatar } from '../components/GroupAvatar'
import { DecryptedImage } from '../components/DecryptedImage'
import { DecryptedVideo } from '../components/DecryptedVideo'
import { FileBubble } from '../components/FileBubble'
import { uploadEncryptedImage, uploadEncryptedFile } from '../lib/media'
import { emoticonAssetURL } from '../lib/emoticons'
import { useI18n } from '../lib/i18n-context'
import { useToast } from '../lib/toast'
import { useIdentity } from '../lib/identity-context'
import { playSound } from '../lib/sounds'
import { useCall } from '../lib/call'
import { useContactAliases } from '../lib/local-store'
import { useWS } from '../lib/ws'

/// Envelope kinds `shipEnvelopeToCurrentThread` is allowed to encrypt + send.
/// (Carbons take a separate path; this gates the in-thread sends.) `edit` was
/// missing here, which silently rejected edit propagation to the peer.
const SHIPPABLE_KINDS = new Set<Envelope['kind']>(['text', 'reaction', 'photo', 'video', 'file', 'edit', 'delete'])

/// Message kinds we mirror to the user's other devices via a carbon
/// (NOT reactions — those sync through their own self-echo).
const CARBON_KINDS = new Set<Envelope['kind']>(['text', 'photo', 'file'])

/// Client-side cap on a document upload. The backend accepts up to 2 GB, but
/// the web decrypts the whole blob into memory to download — keep that bounded.
const MAX_FILE_BYTES = 100 * 1024 * 1024 // 100 MB

function buildSnippet(text: string): string {
  // Carry enough of the quoted message that the reply has context (#14 — a
  // 60-char cut hid what was being answered). The quote renders clamped to a
  // few lines, so a generous cap is fine.
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 220 ? collapsed.slice(0, 220) + '…' : collapsed
}

// Module-level caches of the open chat's peer / group info. The Chat route
// remounts on every navigation; without this the header + composer blanked and
// re-fetched each time ("everything reloads"). State inits from here → instant
// paint, and the fetch refreshes silently in the background.
const _peerCache = new Map<number, Contact>()
const _groupCache = new Map<number, RCQGroup>()

export function Chat() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const { toast } = useToast()
  const call = useCall()
  const navigate = useNavigate()
  const params = useParams<{ uin?: string; groupId?: string }>()
  const [searchParams] = useSearchParams()
  const isGroup = params.groupId != null
  const peerUIN = isGroup ? null : Number(params.uin)
  const groupId = isGroup ? Number(params.groupId) : null
  // Federation (F2): `?i=<host>` marks a CROSS-ISLAND thread — the peer lives on
  // another island, loaded from the local cross-island store, and sends route via
  // federation-send. Absent = a normal flagship thread (everything below is
  // byte-identical to before).
  const islandHost = !isGroup ? searchParams.get('i') : null
  // A 1:1 thread pointed at your OWN UIN = "Saved Messages" / «Заметки» (notes
  // to self). The server omits your own UIN from /contacts, so we synthesise a
  // peer and keep the whole thread LOCAL — never delivered over the wire
  // (mirrors iOS). #3. (A cross-island thread is never "self".)
  const isSelf = !isGroup && !islandHost && identity != null && peerUIN === identity.uin

  // Cross-island groups (§5c): a NEGATIVE route id is a local alias for a
  // group on another island. gctx resolves (identity, server-side id, host)
  // for every group API call — guest credentials + remote id for foreign
  // groups, identity + the same id for local ones. All thread-local state
  // (stores, unread, routes) stays keyed by the route id (the alias).
  const gctx = isGroup && groupId != null && identity != null ? groupApiCtx(identity, groupId) : null
  // Media in a group always lives on the GROUP's island: upload there, fetch
  // from there (members of that island fetch from their own island anyway).
  const groupMediaBase = gctx?.host ? `https://${gctx.host}` : undefined

  // Per-thread persistence key. Recomputed every render — cheap;
  // string formatting only.
  const persistKey = isGroup && groupId != null
    ? storageKey(true, groupId)
    : peerUIN != null
      ? storageKey(false, peerUIN)
      : null

  const [peer, setPeer] = useState<Contact | null>(() =>
    !isGroup && peerUIN != null ? _peerCache.get(peerUIN) ?? null : null,
  )
  const [group, setGroup] = useState<RCQGroup | null>(() =>
    isGroup && groupId != null ? _groupCache.get(groupId) ?? null : null,
  )
  const [myInfo, setMyInfo] = useState<UserInfo | null>(null)
  const [input, setInput] = useState('')
  const [showPicker, setShowPicker] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [uploadingFile, setUploadingFile] = useState(false)
  // The attach button opens a small menu (Photo / File) — the web couldn't
  // send documents before (#16). Each picks a different hidden <input>.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  // A file is being dragged over the conversation (drop-to-send overlay).
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const docInputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // The composer. A contenteditable rather than a textarea, because a textarea
  // cannot hold a picture and the emoticons were the point; it grows with its
  // own content, so the manual height juggling that used to live here went with
  // the element it was written for (max-height + overflow does the rest).
  const taRef = useRef<HTMLDivElement>(null)
  // The scrolling message pane (<main>). We scroll this element directly to
  // its bottom rather than scrollIntoView-ing a zero-height anchor — the
  // anchor approach was landing short, leaving the newest messages tucked
  // behind the sticky composer when a thread opened (founder report).
  const scrollRef = useRef<HTMLDivElement>(null)
  // The message list (<ul>) — observed for height growth so we can re-pin to
  // the bottom as late content (decrypting images, raised composer) settles.
  const contentRef = useRef<HTMLUListElement>(null)
  // Lazy initial loader pulls the persisted log straight off
  // localStorage so the first paint already shows the user's
  // history. New rows append + write-through; failed-on-reload
  // rows surface with a red bang so the user can retry.
  const [outgoing, setOutgoing] = useState<OutgoingRow[]>(() =>
    persistKey ? loadPersisted(persistKey) : [],
  )
  const [error, setError] = useState<string | null>(null)
  const [actionsForRowId, setActionsForRowId] = useState<string | null>(null)
  const [reactionForRowId, setReactionForRowId] = useState<string | null>(null)
  /// What is being forwarded: just the text and who wrote it. It used to be an
  /// OutgoingRow, which quietly limited forwarding to your own messages.
  const [forwardingRow, setForwardingRow] = useState<{ text: string; author: string } | null>(null)
  const [replyTo, setReplyTo] = useState<ReplyContext | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  // Search inside this conversation. Android has had it; the web had no way to
  // find anything you had said, in a thread that can run for months.
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)
  // The own message currently being edited (composer is in edit mode), or null.
  const [editingRow, setEditingRow] = useState<OutgoingRow | null>(null)
  const [pinExpanded, setPinExpanded] = useState(false)
  // Decrypted incoming messages, fed by the app-wide MessageReceiver (ws +
  // offline-queue → libsignal decrypt). 1:1 keyed by peer, group by group_id.
  // Keyed by the ROUTE's uin, not by the loaded peer: the peer object only
  // arrives after Api.contacts answers, and until then the thread rendered
  // empty even though its messages were already in the store — opening a chat
  // cold (or reloading straight onto /chat/123) showed nothing for a moment.
  // Every branch below synthesises the peer with `uin === peerUIN`, so this is
  // the same key, just available immediately. Groups already do this.
  const peerIncoming = useIncoming(isGroup ? null : peerUIN)
  // Keyed by the ROUTE id (the alias for foreign groups) — the receiver files
  // foreign rows under the alias, and `group.id` is the server-side id.
  const groupIncoming = useGroupIncoming(isGroup ? groupId : null)
  const incoming = isGroup ? groupIncoming : peerIncoming
  // Re-render this view whenever ANY reaction changes (received or our own
  // optimistic toggle); the per-row chips read the store directly.
  useReactionsVersion()
  // Re-render when a message is deleted-for-everyone (ours or a received
  // delete) so the tombstone filter drops it live. The version also feeds the
  // timeline memo below, which does that filtering.
  const deletedVersion = useDeletedVersion()

  const myNickname = useMemo<string>(
    () => myInfo?.nickname ?? t('chat.you'),
    [myInfo, t],
  )

  // When the user navigates between chats the component is reused
  // with new route params. Reload the outgoing log from the new
  // thread's storage key so the previous chat's bubbles don't
  // bleed in. Reset transient UI (action menu, reply mode) too.
  //
  // ⚠ The edit mode HAS to be reset with them. It used to survive the switch,
  // and since the composer's Enter routes to saveEdit while editing, the next
  // message typed in the new chat was sent as an edit of a message in the OLD
  // one: the wrong person received an edit envelope, and nothing changed
  // locally because no row with that id exists here. The draft and the error
  // banner are reset for the milder version of the same thing — arriving in a
  // chat carrying someone else's half-typed line, or a stale red banner.
  useEffect(() => {
    if (!persistKey) return
    setOutgoing(loadPersisted(persistKey))
    setActionsForRowId(null)
    setReactionForRowId(null)
    setReplyTo(null)
    setEditingRow(null)
    setForwardingRow(null)
    setInput('')
    setError(null)
    setShowPicker(false)
    setAttachMenuOpen(false)
  }, [persistKey])

  // Persist on every change. Cheaper than a debounce here — the
  // thread's full log fits in a few KB even at the cap, and
  // localStorage writes are sync but not on the main render path
  // (effect runs after commit).
  useEffect(() => {
    if (!persistKey) return
    savePersisted(persistKey, outgoing)
  }, [persistKey, outgoing])

  useEffect(() => {
    if (!identity) return
    void (async () => {
      try {
        if (isGroup && groupId != null) {
          const ctx = groupApiCtx(identity, groupId)
          const g = await Api.groupInfo(ctx.ident, ctx.gid)
          _groupCache.set(groupId, g)
          setGroup(g)
        } else if (isSelf && peerUIN != null) {
          // Saved Messages — synthesise the self-peer (the server never returns
          // your own UIN in /contacts). No fetch, no "not in contacts" error.
          setPeer({
            uin: peerUIN,
            nickname: t('chat.saved.title'),
            status: 'online',
            blocked: false,
            identity_key: '',
            signing_key: '',
          })
        } else if (islandHost && peerUIN != null) {
          // Cross-island peer — load from the local store (the flagship /contacts
          // doesn't know them). Send routes via federation-send; receive is the
          // normal poll of our own island, into which they deposit.
          const ci = getCrossIsland(peerUIN, islandHost)
          if (!ci) {
            setError(t('chat.error.peer_not_in_contacts', { uin: peerUIN }))
            return
          }
          setPeer({
            uin: peerUIN,
            nickname: ci.nickname || `${peerUIN}@${ci.host}`,
            status: 'online',
            blocked: false,
            identity_key: ci.identityKey,
            signing_key: ci.signingKey,
            signal_identity_key: ci.signalIdentityKey ?? null,
            host: ci.host,
          })
        } else if (peerUIN != null) {
          const list = await Api.contacts(identity)
          const found = list.find((c) => c.uin === peerUIN)
          if (!found) {
            // Only surface "not in contacts" on a COLD load — if we already
            // painted from cache, keep showing it rather than flashing an error.
            if (!_peerCache.has(peerUIN)) setError(t('chat.error.peer_not_in_contacts', { uin: peerUIN }))
            return
          }
          _peerCache.set(peerUIN, found)
          setPeer(found)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : t('chat.error.peer_load_failed'))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, peerUIN, groupId, isGroup, islandHost])

  // Pull own profile once for the nickname — used as authorName on
  // replies-to-self and as fwdName on forwards. Best-effort; if it
  // fails we fall back to a localised "you" label.
  useEffect(() => {
    if (!identity) return
    void Api.myInfo(identity).then(setMyInfo).catch(() => {})
  }, [identity])

  // Keep the newest message in view WITHOUT ever animating through the whole
  // history. Three cases (#17 "при заходе в группу проматывается весь огромный"):
  //   • thread switch  → jump instantly to the bottom.
  //   • new content while the user is AT the bottom → follow it (instant for a
  //     long hop like a queued-history burst, smooth only for a short slide).
  //   • new content while the user has scrolled UP to read → don't move.
  // The earlier code smooth-scrolled on every incoming.length change, so each
  // message that hydrated/drained after open reeled the list down.
  const lastThreadRef = useRef<string | null>(null)
  const atBottomRef = useRef(true)
  // The same fact as `atBottomRef`, but in state so the view can react to it:
  // a ref cannot render the "jump to newest" button, which is why there never
  // was one. Kept as a pair rather than replacing the ref — the scroll effect
  // reads it synchronously inside requestAnimationFrame.
  const [atBottom, setAtBottom] = useState(true)
  // New messages that arrived while the user was reading further up, so the
  // button can say how many are waiting instead of just pointing down.
  const [unseenBelow, setUnseenBelow] = useState(0)

  // Escape backs out of whatever is open, innermost first, and a click
  // anywhere else closes the floating bits. Neither existed: the only key this
  // screen handled was Enter, and the action menu / reaction picker / emoji
  // panel could only be dismissed by hitting the very same button again.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (searchOpen) { setSearchOpen(false); setQuery(''); return }
      if (attachMenuOpen) return setAttachMenuOpen(false)
      if (showPicker) return setShowPicker(false)
      if (reactionForRowId) return setReactionForRowId(null)
      if (actionsForRowId) return setActionsForRowId(null)
      if (editingRow) return cancelEdit()
      if (replyTo) return setReplyTo(null)
    }
    function onDown(e: MouseEvent) {
      const el = e.target as HTMLElement | null
      // Let the bubble's own handler decide — it toggles its menu, and closing
      // here first would make the click a no-op.
      if (el?.closest('[data-chat-menu]')) return
      setActionsForRowId(null)
      setReactionForRowId(null)
      setShowPicker(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [searchOpen, attachMenuOpen, showPicker, reactionForRowId, actionsForRowId, editingRow, replyTo])

  /** Pin the list to the bottom and mark it as followed. Called when the user
   *  does something that means "I want to be at the newest": sending, or
   *  tapping the jump button. */
  function stickToBottom() {
    atBottomRef.current = true
    setAtBottom(true)
    setUnseenBelow(0)
    const jump = () => {
      const el = scrollRef.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    }
    // Now, and again after layout. The immediate call is what actually moves
    // the list — requestAnimationFrame does not fire while the window is in
    // the background, so a frame-only version silently did nothing there. The
    // deferred one catches the row that has just been appended.
    jump()
    requestAnimationFrame(jump)
  }
  const lastCountRef = useRef(0)
  useEffect(() => {
    const switched = lastThreadRef.current !== persistKey
    lastThreadRef.current = persistKey
    const total = outgoing.length + incoming.length
    const grew = switched ? 0 : Math.max(0, total - lastCountRef.current)
    lastCountRef.current = total
    if (switched) {
      setAtBottom(true)
      setUnseenBelow(0)
    } else if (grew && !atBottomRef.current) {
      // Arrived while the user is reading further up: count it for the jump
      // button instead of yanking the list, which is what the early return
      // below has always (correctly) done.
      setUnseenBelow((n) => n + grew)
    }
    const el = scrollRef.current
    if (!el) return
    // Defer past layout so late content (queued history, decrypted images) is
    // measured before we pin to the bottom — otherwise the jump lands short
    // and the last bubbles hide under the composer.
    requestAnimationFrame(() => {
      if (switched) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
        atBottomRef.current = true
        return
      }
      if (!atBottomRef.current) return
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      el.scrollTo({ top: el.scrollHeight, behavior: distance > el.clientHeight ? 'auto' : 'smooth' })
    })
  }, [outgoing.length, incoming.length, persistKey])

  // Re-pin to the bottom as the list's HEIGHT settles after open (images
  // decrypt, the composer raises) — a one-shot scroll on open landed short, so
  // a chat "didn't open at the last message" and you had to scroll down. While
  // the user is at the bottom we follow growth; once they scroll up we stop.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTo({ top: el.scrollHeight })
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [persistKey])

  // Mark this thread as the active one: clears its unread badge on open
  // and suppresses in-app toasts for messages that land while it's open.
  useEffect(() => {
    const key = isGroup && groupId != null ? `g:${groupId}` : peerUIN != null ? `p:${peerUIN}` : null
    setActiveThread(key)
    return () => setActiveThread(null)
  }, [isGroup, groupId, peerUIN])

  // Register a live sink so multi-device carbons (a message this user sent
  // from another device) for the OPEN thread appear instantly — merged into
  // state, deduped by id. Carbons for other threads go to localStorage.
  useEffect(() => {
    if (!persistKey) return
    setOutgoingSink(persistKey, (row) =>
      setOutgoing((rows) => (rows.some((r) => r.id === row.id) ? rows : [...rows, row])),
    )
    return () => setOutgoingSink(null, null)
  }, [persistKey])

  // Auto-clear the transient notice (forward toast) after a moment
  // so it doesn't linger on the screen.

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  /// Encrypt + ship one envelope to the current thread. Used by text
  /// sends, retries, and reaction broadcasts — keeps the crypto path
  /// single-source so all three exercise the same fan-out logic.
  /// Returns true on success.
  async function shipEnvelopeToCurrentThread(envelope: Envelope): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!identity) return { ok: false, error: 'no identity' }
    if (!SHIPPABLE_KINDS.has(envelope.kind)) {
      return { ok: false, error: `unsupported envelope kind: ${envelope.kind}` }
    }
    // Saved Messages ("Заметки") stays LOCAL — same as iOS, which skips the
    // wire for a send to self. The optimistic row is the message; no delivery,
    // no carbon (the row already persists to this device's localStorage log).
    if (isSelf) return { ok: true }
    // The server ships this as the ws packet `type` to the recipient (so a web
    // receiver routes a control envelope live) and gates owner_only posts +
    // pushes on it. Reaction/edit/delete carry their own type; content is
    // "message".
    const etype =
      envelope.kind === 'reaction' ? 'reaction' : envelope.kind === 'edit' ? 'edit' : envelope.kind === 'delete' ? 'delete' : 'message'
    try {
      if (isGroup && group && gctx) {
        // Sender-keys dual-send (only for a LOCAL group — cross-island groups
        // keep the legacy per-member path in v1; their capability lookup +
        // broadcast endpoint live on the foreign island we have no token for).
        const anyCapable = !group.host && group.members.some((m) => m.sender_keys && m.uin !== gctx.ident.uin)
        if (anyCapable) {
          const ds = buildGroupDualSend(envelope, gctx.ident, gctx.gid, group.members)
          if (!ds.broadcastPayload && ds.legacyPayloads.length === 0) {
            throw new Error(
              ds.skipped.length > 0 ? t('chat.error.group_no_valid_members') : t('chat.error.group_empty'),
            )
          }
          // Distribute the chain key to capable members who need it FIRST, so a
          // recipient never gets a gmsg for a kid it can't open (skdm rides the
          // sealed path, never gated by owner_only).
          if (ds.skdmPayloads.length > 0) {
            await Api.sendGroupSealed(gctx.ident, gctx.gid, ds.skdmPayloads, 'skdm')
          }
          if (ds.broadcastPayload) {
            await Api.sendGroupBroadcast(gctx.ident, gctx.gid, ds.broadcastPayload, etype)
            ds.commit() // ratchet + mark distributed only after the post lands
          }
          // Legacy members (not yet updated) still get their per-member copy.
          if (ds.legacyPayloads.length > 0) {
            await Api.sendGroupSealed(gctx.ident, gctx.gid, ds.legacyPayloads, etype)
          }
        } else {
          // Foreign group, or a group where nobody is capable yet: original
          // per-member fan-out unchanged.
          const { payloads, skipped } = encryptGroupEnvelope(envelope, gctx.ident, group.members)
          if (payloads.length === 0) {
            throw new Error(
              skipped.length > 0 ? t('chat.error.group_no_valid_members') : t('chat.error.group_empty'),
            )
          }
          await Api.sendGroupSealed(gctx.ident, gctx.gid, payloads, etype)
        }
      } else if (peer?.host) {
        // Federation (F2): the peer lives on another island — resolve their
        // current home island(s) and deposit there (v=1 sealed sender). A v=2
        // session would need their auth-gated prekey bundle, which we have no
        // token for cross-island; v=1 needs only their public key card.
        // Pass the locally-pinned keys so the send survives the peer's island
        // being blocked/dead: seal from these + reach them via the gossip mirror.
        await deliverCrossIsland(identity, peer.host, peer.uin, envelope, {
          identityKey: peer.identity_key,
          signingKey: peer.signing_key,
        })
      } else if (peer) {
        // Prefer v=2 (libsignal Double Ratchet): fan out one ciphertext per
        // device of the peer. If the peer has published NO libsignal bundle
        // (reached === 0 — e.g. a Stage-2-only account), fall back to the
        // v=1 ECIES envelope so the message still goes through.
        try {
          const reached = await sendV2(identity, peer.uin, envelope, etype).catch(() => 0)
          if (reached === 0) {
            const wireB64 = encryptV1(envelope, identity, peerBundleFrom(peer))
            await Api.sendSealed(identity, peer.uin, wireB64, etype)
          }
          // Multihoming v1: best-effort sealed copy into the peer's OTHER home
          // islands; no-op (and no extra traffic beyond a cached record lookup)
          // for single-homed peers — today's universal case.
          void depositToExtraHomes(identity, peerBundleFrom(peer), envelope)
        } catch (e) {
          // Primary island unreachable — failover. The (possibly stale-cached)
          // record may list other homes; if at least one accepts the copy, the
          // message IS delivered. Single-homed peers rethrow: the send failed.
          const delivered = await depositToExtraHomes(identity, peerBundleFrom(peer), envelope)
          if (delivered === 0) throw e
        }
      } else {
        throw new Error('no target')
      }
      // Mirror this message to the user's other devices (best-effort).
      void sendMessageCarbon(envelope)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : t('chat.error.send_failed') }
    }
  }

  /// Mirror a just-sent message to the user's OTHER devices: seal a `carbon`
  /// (the original envelope + its destination) to our own identity and deposit
  /// it to our own uin. The other device unwraps it and files the inner
  /// message as fromMe in the destination thread; the origin device dedups its
  /// own carbon by id. Reactions are excluded (they sync via their own
  /// self-echo). Best-effort — the message already went out.
  async function sendMessageCarbon(inner: Envelope) {
    if (!identity || !CARBON_KINDS.has(inner.kind)) return
    // Foreign-group sends are not mirrored: the carbon would carry the
    // server-side group id, which another of our devices would misread as a
    // LOCAL group (alias ids are per-device). v1 limit, documented in §5c.
    if (gctx?.host) return
    try {
      const carbon: CarbonEnvelope = {
        kind: 'carbon',
        to: isGroup ? null : peer?.uin ?? null,
        gid: isGroup ? group?.id ?? null : null,
        env: inner,
      }
      const selfBundle = peerBundleFrom({
        uin: identity.uin,
        identity_key: bytesToB64(identity.identityPub),
        signing_key: bytesToB64(identity.signingPub),
      })
      const wireB64 = encryptV1(carbon, identity, selfBundle)
      // Non-pushable type — syncs over WS / the per-device queue, never pushes
      // a "new message" alert to our own phone for a message we sent.
      await Api.sendSealed(identity, identity.uin, wireB64, 'carbon')
    } catch {
      /* best-effort multi-device echo; ignore */
    }
  }

  async function attemptSendRow(row: OutgoingRow) {
    let env: Envelope
    if (row.kind === 'photo' && row.mediaId && row.mediaKey) {
      env = {
        kind: 'photo',
        id: row.id,
        mediaID: row.mediaId,
        mediaKey: row.mediaKey,
        ...(row.text ? { caption: row.text } : {}),
        ...(row.replyTo ? { reply: row.replyTo } : {}),
        ...(row.fwdName ? { fwdName: row.fwdName } : {}),
      }
    } else if (row.kind === 'file' && row.mediaId && row.mediaKey) {
      env = {
        kind: 'file',
        id: row.id,
        mediaID: row.mediaId,
        mediaKey: row.mediaKey,
        fname: row.fileName ?? 'file',
        mime: row.fileMime ?? 'application/octet-stream',
        size: row.fileSize ?? 0,
        ...(row.text ? { caption: row.text } : {}),
        ...(row.replyTo ? { reply: row.replyTo } : {}),
        ...(row.fwdName ? { fwdName: row.fwdName } : {}),
      }
    } else if (row.kind === 'other' && row.mediaKind === 'location' && row.lat != null && row.lng != null) {
      env = {
        kind: 'location',
        id: row.id,
        lat: row.lat,
        lng: row.lng,
        ...(row.text ? { caption: row.text } : {}),
        ...(row.replyTo ? { reply: row.replyTo } : {}),
      }
    } else {
      env = {
        kind: 'text',
        id: row.id,
        text: row.text,
        ...(row.replyTo ? { reply: row.replyTo } : {}),
        ...(row.fwdName ? { fwdName: row.fwdName } : {}),
      }
    }
    const res = await shipEnvelopeToCurrentThread(env)
    if (res.ok) {
      setOutgoing((rows) =>
        rows.map((r) => (r.id === row.id ? { ...r, state: 'sent', error: undefined } : r)),
      )
      playSound('message_sent')
    } else {
      setOutgoing((rows) =>
        rows.map((r) => (r.id === row.id ? { ...r, state: 'failed', error: res.error } : r)),
      )
    }
  }

  /// Enter edit mode for one of MY text messages: load its text into the
  /// composer; the send button becomes "save edit".
  function startEdit(row: OutgoingRow) {
    setEditingRow(row)
    setReplyTo(null)
    setInput(row.text)
    setActionsForRowId(null)
    taRef.current?.focus()
  }

  function cancelEdit() {
    setEditingRow(null)
    setInput('')
  }

  /// Save an edit: send an `edit` envelope (kind "edit", targetID, text) to the
  /// thread and update my local row in place. Recipients update the message
  /// they received. No-op if unchanged/empty.
  async function saveEdit() {
    if (!identity || !editingRow) return
    const trimmed = input.trim()
    const target = editingRow
    if (!trimmed || trimmed === target.text) {
      cancelEdit()
      return
    }
    setEditingRow(null)
    setInput('')
    setOutgoing((rows) => rows.map((r) => (r.id === target.id ? { ...r, text: trimmed, edited: true } : r)))
    const env: EditEnvelope = { kind: 'edit', targetID: target.id, text: trimmed }
    const res = await shipEnvelopeToCurrentThread(env)
    if (!res.ok) toast(t('chat.error.send_failed'), 'error')
  }

  /// Delete one of MY messages for everyone: send a `delete` envelope, remove
  /// the row locally (from state + the persisted log) and tombstone its id so a
  /// carbon / reload can't resurrect it. Recipients re-check the author rule and
  /// drop it too.
  async function deleteForEveryone(row: OutgoingRow) {
    if (!identity) return
    setActionsForRowId(null)
    markDeleted(row.id, { fromSelf: true }) // hide across both logs + persist tombstone
    setOutgoing((rows) => rows.filter((r) => r.id !== row.id))
    const env: DeleteEnvelope = { kind: 'delete', targetID: row.id }
    const res = await shipEnvelopeToCurrentThread(env)
    if (!res.ok) toast(t('chat.error.send_failed'), 'error')
  }

  async function send() {
    if (!identity) return
    if (editingRow) {
      await saveEdit()
      return
    }
    const trimmed = input.trim()
    if (!trimmed) return

    const msgId = newUUIDv4()
    const row: OutgoingRow = {
      id: msgId,
      text: trimmed,
      sentAt: Date.now(),
      state: 'sending',
      ...(replyTo ? { replyTo } : {}),
    }
    setOutgoing((rows) => [...rows, row])
    setInput('')
    setShowPicker(false)
    setReplyTo(null)
    // Sending is an explicit "put me at the bottom": without this, answering
    // while scrolled up left your own message off-screen, because the scroll
    // effect below refuses to move the list once the user has scrolled away.
    // The focus goes back too — send by mouse used to leave it on the button,
    // so the next keystroke went nowhere.
    stickToBottom()
    taRef.current?.focus()
    await attemptSendRow(row)
  }

  /// Unblock the current peer (from the blocked-composer banner) so the
  /// user can message again. Optimistically clears the local blocked flag.
  async function unblockPeer() {
    if (!identity || !peer) return
    try {
      await Api.blockContact(identity, peer.uin, false)
      setPeer({ ...peer, blocked: false })
    } catch (e) {
      toast(e instanceof Error ? e.message : t('chat.error.send_failed'), 'error')
    }
  }

  /// Pick → encrypt → upload → send a photo. The upload happens before
  /// the row appears so a failed upload doesn't leave a dangling bubble;
  /// once uploaded it goes through the same encrypt+fan-out send path as
  /// text (as a `photo` envelope). Caption support is a later add.
  async function sendPhoto(file: File) {
    if (!identity || uploadingPhoto) return
    setUploadingPhoto(true)
    try {
      const up = await uploadEncryptedImage(identity.apiBase, file, isGroup ? gctx?.host ?? undefined : peer?.host)
      if (!up) {
        toast(t('chat.error.upload_failed'), 'error')
        return
      }
      // Whatever is already typed becomes the caption, the way every web
      // messenger does it. The envelope has carried `caption` from the start
      // and both bubbles render it; there was simply no way to fill it in, so
      // people sent a picture and then a separate line about it.
      const caption = input.trim()
      const row: OutgoingRow = {
        id: newUUIDv4(),
        text: caption,
        sentAt: Date.now(),
        state: 'sending',
        kind: 'photo',
        mediaId: up.mediaId,
        mediaKey: up.keyB64,
        ...(replyTo ? { replyTo } : {}),
      }
      setOutgoing((rows) => [...rows, row])
      if (caption) setInput('')
      setReplyTo(null)
      await attemptSendRow(row)
    } finally {
      setUploadingPhoto(false)
    }
  }

  /// Share where you are. No blob and no upload — the coordinates ride in the
  /// envelope, which is why this is the one attachment that works offline right
  /// up to the send.
  ///
  /// The browser asks its own permission prompt; a refusal is a decision, not an
  /// error, so it says so quietly and leaves the composer alone.
  async function sendLocation() {
    if (!identity) return
    setAttachMenuOpen(false)
    if (!navigator.geolocation) {
      toast(t('chat.error.no_geolocation'), 'error')
      return
    }
    const pos = await new Promise<GeolocationPosition | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(p),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 12_000, maximumAge: 60_000 },
      )
    })
    if (!pos) {
      toast(t('chat.error.no_location'), 'error')
      return
    }
    const caption = input.trim()
    const row: OutgoingRow = {
      id: newUUIDv4(),
      text: caption,
      sentAt: Date.now(),
      state: 'sending',
      kind: 'other',
      mediaKind: 'location',
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      ...(replyTo ? { replyTo } : {}),
    }
    setOutgoing((rows) => [...rows, row])
    if (caption) setInput('')
    setReplyTo(null)
    await attemptSendRow(row)
  }

  /// Pick → encrypt → upload → send a document of any type (#16). Raw bytes
  /// (no canvas re-encode), sent as a `file` envelope; rendered as a download
  /// chip on both sides. Same upload-before-row pattern as sendPhoto.
  async function sendFile(file: File) {
    if (!identity || uploadingFile) return
    if (file.size > MAX_FILE_BYTES) {
      toast(t('chat.error.file_too_large', { mb: Math.round(MAX_FILE_BYTES / (1024 * 1024)) }), 'error')
      return
    }
    setUploadingFile(true)
    try {
      const up = await uploadEncryptedFile(identity.apiBase, file, isGroup ? gctx?.host ?? undefined : peer?.host)
      if (!up) {
        toast(t('chat.error.file_upload_failed'), 'error')
        return
      }
      const row: OutgoingRow = {
        id: newUUIDv4(),
        text: '',
        sentAt: Date.now(),
        state: 'sending',
        kind: 'file',
        mediaId: up.mediaId,
        mediaKey: up.keyB64,
        fileName: file.name || 'file',
        fileMime: file.type || 'application/octet-stream',
        fileSize: up.size,
        ...(replyTo ? { replyTo } : {}),
      }
      setOutgoing((rows) => [...rows, row])
      setReplyTo(null)
      await attemptSendRow(row)
    } finally {
      setUploadingFile(false)
    }
  }

  /// User-tapped retry on a failed row. Flip back to 'sending' so the
  /// UI updates immediately, then run the same encrypt+POST path. The
  /// row keeps its original `sentAt` and UUID — only the state and
  /// error fields churn.
  async function retry(msgId: string) {
    const row = outgoing.find((r) => r.id === msgId)
    if (!row) return
    setOutgoing((rows) =>
      rows.map((r) => (r.id === msgId ? { ...r, state: 'sending', error: undefined } : r)),
    )
    await attemptSendRow({ ...row, state: 'sending', error: undefined })
  }

  /// Drop a permanently-failed row from the log. Used when the user
  /// has decided the message will never go through (e.g., contact was
  /// removed) and doesn't want the red bang lingering.
  function dismiss(msgId: string) {
    setOutgoing((rows) => rows.filter((r) => r.id !== msgId))
  }

  /// Toggle a reaction asset on a row. Optimistic — apply locally
  /// first, then ship the envelope. On failure revert and surface a
  /// toast so the user knows it didn't go through. Tapping the same
  /// asset twice clears it.
  /// Toggle a reaction asset on ANY message (mine or the peer's), keyed
  /// by the target id in the shared reactions store. Optimistic — apply
  /// locally first, then ship the envelope; revert + surface a toast on
  /// failure. Tapping the same asset twice clears it.
  async function toggleReaction(targetId: string, asset: string | null) {
    if (!identity) return
    const myUin = identity.uin
    const current = reactionsForTarget(targetId)?.get(myUin) ?? null
    const next = current === asset ? null : asset
    applyReaction(targetId, myUin, next)
    setReactionForRowId(null)
    setActionsForRowId(null)
    const env: ReactionEnvelope = { kind: 'reaction', targetID: targetId, asset: next }
    const res = await shipEnvelopeToCurrentThread(env)
    if (!res.ok) {
      applyReaction(targetId, myUin, current)
      toast(res.error, 'error')
      return
    }
    // Echo to your OWN other devices (linked phone / second browser): seal the
    // reaction to your own identity (v=1) and deposit to your own uin. The
    // receiver applies reactions by target id (global store), so it lands on the
    // same message there. Best-effort — the reaction itself already went out.
    void sendReactionSelfEcho(env)
  }

  /// Seal a reaction to the local user's own identity and deposit it to their
  /// own uin, so a reaction made here syncs to their other logged-in devices.
  async function sendReactionSelfEcho(env: ReactionEnvelope) {
    if (!identity || isSelf) return // Saved Messages reactions stay local
    try {
      const selfBundle = peerBundleFrom({
        uin: identity.uin,
        identity_key: bytesToB64(identity.identityPub),
        signing_key: bytesToB64(identity.signingPub),
      })
      const wireB64 = encryptV1(env, identity, selfBundle)
      await Api.sendSealed(identity, identity.uin, wireB64)
    } catch {
      /* best-effort multi-device echo; ignore */
    }
  }

  /// Enter reply mode for any message (mine or the peer's). The composer
  /// renders a quote-block above the textarea; the next send includes it
  /// as a `ReplyContext` so the recipient sees the quote rendered.
  function startReplyTo(id: string, text: string, authorName: string) {
    setReplyTo({ id, snippet: buildSnippet(text), authorName })
    setActionsForRowId(null)
    // Without this, replying showed a strip and left the caret wherever it was:
    // on a desktop, where nothing else moves, that reads as the button doing
    // nothing at all.
    requestAnimationFrame(() => taRef.current?.focus())
  }
  function startReply(row: OutgoingRow) {
    startReplyTo(row.id, row.text, myNickname)
  }

  function cancelReply() {
    setReplyTo(null)
  }

  function insertEmoticon(code: string, asset: string) {
    const el = taRef.current
    if (!el) return
    insertEmoticonAt(el, asset, code)
    setInput(serializeComposer(el))
    notifyTyping()
  }

  /// Start a call, or say why not. Signalling rides the websocket and has no
  /// REST fallback, so being offline really does block it — but that is a fact
  /// at press time, not a reason to animate the header.
  function startCall(media: 'audio' | 'video') {
    if (!peer) return
    if (!call.callable) {
      toast(t('call.offline'), 'error')
      return
    }
    call.start(peer.uin, peer.nickname ?? `#${peer.uin}`, media)
  }

  /// Scroll to the message a quote refers to and flash it.
  ///
  /// Tapping a quote did nothing at all before — no handler, and no anchors to
  /// scroll to. The flash matters as much as the scroll: landing mid-thread
  /// with nothing marked leaves you hunting for which line you were sent to.
  /// A quote can also point at a message that is not loaded (older than this
  /// thread's window, or deleted), and saying so beats scrolling nowhere.
  function jumpToMessage(id: string) {
    const el = document.getElementById(`msg-${id}`)
    if (!el) {
      toast(t('chat.reply.not_loaded'), 'error')
      return
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightId(id)
    window.setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 1400)
  }

  /// Copy a message's text to the clipboard (action-menu "copy").
  function copyText(text: string) {
    void navigator.clipboard?.writeText(text).catch(() => {})
    setActionsForRowId(null)
    toast(t('chat.copied'))
  }

  /// Owner / info-moderator may pin a chat message into the group's single
  /// pin slot. The slot is shared with the settings editor — pinning here
  /// replaces whatever was there, and saving from settings replaces this.
  const canPin =
    isGroup &&
    group != null &&
    identity != null &&
    (group.owner_uin === identity.uin ||
      (group.members.find((m) => m.uin === identity.uin)?.permissions?.includes('info') ?? false))

  /// Pin a message's text (the pin slot is plaintext, so media without a
  /// caption falls back to a label). Updates the local group so the pinned
  /// bar reflects it immediately.
  function pinMessage(text: string) {
    if (!gctx || !canPin || !group) return
    const pinned = text.trim() || t('chat.pin.attachment')
    setActionsForRowId(null)
    setPinExpanded(false)
    // Optimistic + instant: replace the displayed pin right away, then
    // reconcile with the server response. This guarantees the banner shows
    // the NEW pin immediately, independent of any refetch/cache timing.
    setGroup({ ...group, pinned_text: pinned })
    void Api.setGroupPinnedText(gctx.ident, gctx.gid, pinned)
      .then((updated) => {
        _groupCache.set(gctx.gid, updated)
        setGroup(updated)
      })
      .catch(() => {})
  }

  /// Swipe-left-to-reply (touch, mobile-web "like on phones"). Returns touch
  /// handlers for a message row; a quick leftward drag fires `onReply`.
  function swipeReply(onReply: () => void) {
    let startX = 0
    let startY = 0
    let active = false
    return {
      onTouchStart: (e: React.TouchEvent) => {
        const tch = e.touches[0]
        startX = tch.clientX
        startY = tch.clientY
        active = true
      },
      onTouchMove: (e: React.TouchEvent) => {
        if (!active) return
        const tch = e.touches[0]
        // Cancel if the gesture is mostly vertical (a scroll).
        if (Math.abs(tch.clientY - startY) > 30) active = false
      },
      onTouchEnd: (e: React.TouchEvent) => {
        if (!active) return
        active = false
        const dx = e.changedTouches[0].clientX - startX
        if (dx < -55) onReply()
      },
    }
  }

  /// Forward a row to another thread. Builds a fresh OutgoingRow with
  /// the same text + `fwdName` set to my own nickname (the original
  /// author from the recipient's perspective), encrypts to the picked
  /// target, and writes the row into the *target* thread's storage
  /// so navigating there reveals it. We don't append it to the
  /// current thread's log.
  async function forwardTo(row: { text: string; author: string }, target: ForwardTarget) {
    if (!identity) return
    const newId = newUUIDv4()
    // Credit the ORIGINAL author, not whoever pressed forward. Sending my own
    // name on somebody else's words is the one thing a forward must not do.
    const fwdName = row.author
    const env: TextEnvelope = { kind: 'text', id: newId, text: row.text, fwdName }
    try {
      if (target.kind === 'group') {
        // target.id may be a foreign-group alias — resolve the island ctx.
        const fctx = groupApiCtx(identity, target.id)
        // ⚠ The picker's list is fetched without rosters, so this group can
        // carry an empty member list. Sealing against that produces no
        // payloads at all, and the forward would report an empty group — or
        // worse, on a partial roster, quietly reach only some of it.
        const full = await ensureRoster(fctx.ident, target.group)
        const { payloads, skipped } = encryptGroupEnvelope(env, fctx.ident, full.members)
        if (payloads.length === 0) {
          throw new Error(
            skipped.length > 0
              ? t('chat.error.group_no_valid_members')
              : t('chat.error.group_empty'),
          )
        }
        await Api.sendGroupSealed(fctx.ident, fctx.gid, payloads)
      } else {
        const wireB64 = encryptV1(env, identity, peerBundleFrom(target.contact))
        await Api.sendSealed(identity, target.uin, wireB64)
      }
      const newRow: OutgoingRow = {
        id: newId,
        text: row.text,
        sentAt: Date.now(),
        state: 'sent',
        fwdName,
      }
      const targetKey =
        target.kind === 'group'
          ? storageKey(true, target.id)
          : storageKey(false, target.uin)
      appendToThreadLog(targetKey, newRow)
      playSound('message_sent')
      setForwardingRow(null)
      setActionsForRowId(null)
      toast(`${t('chat.forward.sent')}: ${target.name}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : t('chat.error.send_failed'), 'error')
    }
  }

  function toggleActions(rowId: string) {
    setActionsForRowId((prev) => (prev === rowId ? null : rowId))
    setReactionForRowId(null)
  }

  /// Reaction chips under a bubble — one per distinct asset with a count;
  /// the viewer's own asset is highlighted. Tapping a chip toggles it.
  /// `align` matches the bubble side. Reads the shared reactions store
  /// (the component already subscribes via useReactionsVersion()).
  function renderReactions(targetId: string, align: 'start' | 'end') {
    const chips = aggregateReactions(targetId, identity!.uin)
    if (chips.length === 0) return null
    return (
      <div className={`flex flex-wrap gap-1 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
        {chips.map((c) => (
          <button
            key={c.asset}
            onClick={() => void toggleReaction(targetId, c.asset)}
            className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 transition-colors ${
              c.mine ? 'bg-accent/25' : 'bg-field hover:bg-line/60'
            }`}
            title={c.asset}
          >
            <img src={emoticonAssetURL(c.asset)} alt={c.asset} className="h-4 w-4 select-none" draggable={false} />
            {c.count > 1 && <span className="font-mono text-[10px] text-fg-secondary">{c.count}</span>}
          </button>
        ))}
      </div>
    )
  }

  const { aliasFor: peerAliasFor } = useContactAliases()
  const peerAlias = peerUIN ? peerAliasFor(peerUIN) : undefined
  const headerName = isGroup
    ? group?.name ?? `#${groupId}`
    : isSelf
      ? t('chat.saved.title')
      // My own name for them, when I set one (device-only, see useContactAliases).
      : peerAlias ?? peer?.nickname ?? `#${peerUIN}`
  // "typing…" — the phones have had it for a long time and the web has not,
  // so a conversation between a phone and a browser looked one-sided. Wire
  // format is the phones': {type:"typing", to_uin, active} out,
  // {type:"typing", from_uin, active} in.
  const ws = useWS()
  const [peerTyping, setPeerTyping] = useState(false)
  useEffect(() => {
    if (isGroup || isSelf || !peerUIN) return
    // Same 6s ceiling the phones use: a client that goes away mid-word must
    // not leave the indicator stuck on forever.
    let clear: ReturnType<typeof setTimeout> | undefined
    const off = ws.on('typing', (ev) => {
      if (Number(ev.from_uin) !== peerUIN) return
      const active = ev.active === true
      setPeerTyping(active)
      if (clear) clearTimeout(clear)
      if (active) clear = setTimeout(() => setPeerTyping(false), 6000)
    })
    return () => { off(); if (clear) clearTimeout(clear); setPeerTyping(false) }
  }, [ws, peerUIN, isGroup, isSelf])

  // Outgoing: one "started" per burst, a "stopped" when the composer goes
  // quiet for 3s or the message ships. Sending on every keystroke would be a
  // packet per character for no extra information.
  const typingSentAt = useRef(0)
  const typingStop = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const notifyTyping = useCallback(() => {
    if (isGroup || isSelf || !peerUIN) return
    const now = Date.now()
    if (now - typingSentAt.current > 4000) {
      typingSentAt.current = now
      ws.send({ type: 'typing', to_uin: peerUIN, active: true })
    }
    if (typingStop.current) clearTimeout(typingStop.current)
    typingStop.current = setTimeout(() => {
      typingSentAt.current = 0
      ws.send({ type: 'typing', to_uin: peerUIN, active: false })
    }, 3000)
  }, [ws, peerUIN, isGroup, isSelf])
  const stopTyping = useCallback(() => {
    if (isGroup || isSelf || !peerUIN) return
    if (typingStop.current) clearTimeout(typingStop.current)
    if (typingSentAt.current) {
      typingSentAt.current = 0
      ws.send({ type: 'typing', to_uin: peerUIN, active: false })
    }
  }, [ws, peerUIN, isGroup, isSelf])

  const headerSub = isGroup
    ? group ? t('section.groups.members', { n: memberCount(group) }) : ''
    : isSelf
      ? t('chat.saved.subtitle')
      : peerTyping
        ? t('chat.typing')
      // Cross-island: show the peer's island (presence doesn't cross islands).
      : peer?.host ? `#${peerUIN} · ${peer.host}` : String(peerUIN)
  // One ordered timeline of both halves of the conversation, with a day
  // separator inserted wherever the date changes. Until now the list showed
  // only HH:MM, so a message from last week looked exactly like one from an
  // hour ago and there was no way to tell what happened when.
  const timeline = useMemo(() => {
    const items = [
      ...outgoing.map((row) => ({ at: row.sentAt, kind: 'out' as const, row })),
      ...incoming.map((m) => ({ at: m.at, kind: 'in' as const, msg: m })),
    ]
      .filter((it) => !isDeleted(it.kind === 'out' ? it.row.id : it.msg.id))
      .sort((a, b) => a.at - b.at)

    // Group consecutive messages from the same author. Five in a row used to be
    // five copies of the same name and avatar, which turns a conversation into a
    // form; a run reads as one turn of speech when only the first of it is
    // labelled. Broken by a change of author, a day boundary, or a gap long
    // enough that the two are no longer one thought.
    const RUN_GAP_MS = 5 * 60 * 1000
    const out: Array<
      ((typeof items)[number] & { cont?: boolean }) | { kind: 'day'; at: number }
    > = []
    let lastDay = ''
    let lastAuthor: string | null = null
    let lastAt = 0
    for (const it of items) {
      const day = new Date(it.at).toDateString()
      if (day !== lastDay) {
        out.push({ kind: 'day', at: it.at })
        lastDay = day
        lastAuthor = null
      }
      const author = it.kind === 'out' ? 'me' : `in:${it.msg.from}`
      const cont = author === lastAuthor && it.at - lastAt < RUN_GAP_MS
      out.push({ ...it, cont })
      lastAuthor = author
      lastAt = it.at
    }
    return out
  }, [outgoing, incoming, deletedVersion])

  /// Ids of the messages containing the query, newest last — the same order
  /// they sit in the thread, so stepping through them walks the conversation
  /// rather than jumping about.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [] as string[]
    return timeline.flatMap((it) => {
      if (it.kind === 'day') return []
      const text = it.kind === 'out' ? it.row.text : it.msg.text
      const id = it.kind === 'out' ? it.row.id : it.msg.id
      return text && text.toLowerCase().includes(q) ? [id] : []
    })
  }, [timeline, query])

  /// Step to a match and take the view with you. Reuses the same jump the reply
  /// quotes use, so a hit is marked the same way a quoted message is.
  function gotoMatch(next: number) {
    if (matches.length === 0) return
    const i = ((next % matches.length) + matches.length) % matches.length
    setMatchIdx(i)
    jumpToMessage(matches[i])
  }

  /** "Today" / "Yesterday" / a plain date, in the user's locale. */
  function dayLabel(at: number): string {
    const d = new Date(at)
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    if (d.toDateString() === today.toDateString()) return t('chat.date.today')
    if (d.toDateString() === yesterday.toDateString()) return t('chat.date.yesterday')
    return d.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
      ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    })
  }

  const headerLink = isGroup
    ? group ? `/groups/${group.id}` : '#'
    : isSelf
      ? '/profile'
      // Cross-island: carry the island so the profile renders from the local
      // card (own-island /users/{uin}/info would 404).
      : peer ? (peer.host ? `/profile/${peer.uin}?i=${encodeURIComponent(peer.host)}` : `/profile/${peer.uin}`) : '#'

  return (
    // h-screen FIRST, dvh second: `100dvh` is an enhancement (it accounts for
    // mobile browser chrome sliding away), but a WebView that does not know the
    // unit DROPS the declaration entirely. With only `h-[100dvh]` that leaves
    // the shell at height:auto, so it grows to the length of the conversation,
    // `overflow-hidden` stops applying, and the page itself scrolls — taking
    // this header, and the back button in it, off screen. Which is exactly
    // what desktop Windows reported: scroll the whole sheet down to read, then
    // all the way back up to find the way out. `h-screen` is the floor that
    // survives, `dvh` wins wherever it is understood.
    <div
      className="h-screen [height:100dvh] flex flex-col bg-surface-dim overflow-hidden relative"
      // Drop a file anywhere on the conversation to send it. The upload paths
      // already existed; the only way to reach them was the paperclip and a
      // system dialog, which on a desktop is the long way round for a file
      // already sitting in a window next to you.
      onDragOver={(e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        // Only when the pointer actually leaves the shell, not on every hop
        // between the children inside it.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragOver(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.files?.length) return
        e.preventDefault()
        setDragOver(false)
        const file = e.dataTransfer.files[0]
        if (file.type.startsWith('image/')) void sendPhoto(file)
        else void sendFile(file)
      }}
    >
      {dragOver && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-ink-black/40 pointer-events-none">
          <div className="rounded-xl border-2 border-dashed border-white/70 px-6 py-4 text-white text-sm font-medium">
            {t('chat.drop_to_send')}
          </div>
        </div>
      )}
      <header className="rcq-header flex-none z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary px-2">
            ←
          </Link>
          <Link
            to={headerLink}
            className="flex items-center gap-2 flex-1 min-w-0 hover:opacity-80"
          >
            {!isGroup && isSelf && <BookmarkIcon />}
            {!isGroup && !isSelf && peer && (
              <PersonAvatar
                status={peerTyping ? 'typing' : peer.status}
                size={28}
                mediaId={peer.avatar_media_id}
                mediaKey={peer.avatar_media_key}
                crossIsland={!!peer.host}
              />
            )}
            {isGroup && (
              <GroupAvatar
                size={28}
                mediaId={group?.avatar_media_id}
                mediaKey={group?.avatar_media_key}
              />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{headerName}</div>
              <div className="font-mono text-xs text-fg-dim truncate">{headerSub}</div>
            </div>
          </Link>
          {/* Calls are one to one only, and calling yourself is not a feature.
              Shown or hidden by the PEER's call_policy, which the island hands
              over as `callable` — the same rule iOS uses, and the only one that
              belongs in a header: it is a property of the person, so it does
              not change while you look at it.
              ⚠ It used to be tied to the WEBSOCKET instead, so the controls
              vanished and returned on every reconnect. Dimming them turned the
              flicker white rather than removing it: anything driven by a socket
              flapping will flicker, whatever it is styled with. Whether the
              socket is up is decided when the button is PRESSED, not drawn. */}
          <button
            type="button"
            onClick={() => {
              setSearchOpen((v) => !v)
              if (searchOpen) { setQuery(''); setMatchIdx(0) }
            }}
            aria-label={t('chat.search.open')}
            title={t('chat.search.open')}
            className={`p-2 transition-colors ${searchOpen ? 'text-accent' : 'text-fg-secondary hover:text-fg-primary'}`}
          >
            <SearchIcon />
          </button>
          {!isGroup && !isSelf && peer && (peer.callable ?? true) && (
            <>
              <button
                type="button"
                onClick={() => startCall('audio')}
                aria-label={t('call.start.audio')}
                title={t('call.start.audio')}
                className="p-2 text-fg-secondary hover:text-fg-primary transition-colors"
              >
                <HeaderPhoneIcon />
              </button>
              <button
                type="button"
                onClick={() => startCall('video')}
                aria-label={t('call.start.video')}
                title={t('call.start.video')}
                className="p-2 text-fg-secondary hover:text-fg-primary transition-colors"
              >
                <HeaderCameraIcon />
              </button>
            </>
          )}
        </div>
      </header>

      {searchOpen && (
        /* Same floating treatment as the header and the pin: the search strip
           sits over the thread, and as a flat `bg-surface` fill it read as a
           grey slab wedged between them, the one bar in the column that did not
           belong to the theme. */
        <div className="rcq-floating-bar flex-none px-4 py-2 flex items-center gap-2 max-w-2xl w-full mx-auto">
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setMatchIdx(0) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? matchIdx - 1 : matchIdx + 1) }
              if (e.key === 'Escape') { setSearchOpen(false); setQuery('') }
            }}
            placeholder={t('chat.search.placeholder')}
            className="flex-1 min-w-0 max-w-xs h-9 px-3 rounded-full bg-field text-sm outline-none focus:ring-1 focus:ring-accent"
          />
          <span className="font-mono text-xs text-fg-dim tabular-nums flex-none">
            {query.trim() ? `${matches.length ? matchIdx + 1 : 0}/${matches.length}` : ''}
          </span>
          <button
            type="button"
            onClick={() => gotoMatch(matchIdx - 1)}
            disabled={matches.length === 0}
            aria-label={t('chat.search.prev')}
            className="h-8 w-8 rounded-full bg-field text-fg-secondary disabled:opacity-30 flex-none"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => gotoMatch(matchIdx + 1)}
            disabled={matches.length === 0}
            aria-label={t('chat.search.next')}
            className="h-8 w-8 rounded-full bg-field text-fg-secondary disabled:opacity-30 flex-none"
          >
            ↓
          </button>
        </div>
      )}

      {isGroup && group?.pinned_text && (
        <PinnedBanner
          text={group.pinned_text}
          group={group}
          expanded={pinExpanded}
          onToggle={() => setPinExpanded((v) => !v)}
        />
      )}


      <main
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          atBottomRef.current = bottom
          setAtBottom((was) => {
            if (was !== bottom && bottom) setUnseenBelow(0)
            return bottom
          })
        }}
        className="flex-1 max-w-2xl w-full mx-auto px-4 py-4 overflow-y-auto no-scrollbar"
      >
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600 mb-4">
            {error}
          </div>
        )}


        {timeline.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6 -mt-8">
            <div className="text-4xl select-none">{isSelf ? '🔖' : '👋'}</div>
            <div className="text-fg-secondary text-sm max-w-xs">
              {isSelf
                ? t('chat.empty.saved')
                : t('chat.empty.peer', { name: headerName })}
            </div>
            <button
              type="button"
              onClick={() => {
                setInput(isSelf ? '' : t('chat.empty.greeting'))
                requestAnimationFrame(() => taRef.current?.focus())
              }}
              className="rounded-full bg-accent hover:bg-accent-dim text-white text-sm font-semibold px-5 py-2 transition-colors"
            >
              {isSelf ? t('chat.empty.cta_saved') : t('chat.empty.cta')}
            </button>
          </div>
        )}
        <ul ref={contentRef} className="space-y-2">
          {timeline
            .map((item) => {
              if (item.kind === 'day') {
                return (
                  <li key={`day-${item.at}`} className="flex justify-center py-2">
                    <span className="px-2 py-0.5 rounded-full bg-surface text-fg-dim text-[11px] font-medium">
                      {dayLabel(item.at)}
                    </span>
                  </li>
                )
              }
              if (item.kind === 'in') {
                const m = item.msg
                const senderMember = isGroup ? group?.members.find((mem) => mem.uin === m.from) : undefined
                const senderName = isGroup ? senderMember?.nickname || `#${m.from}` : null
                const invite = parseGroupInvite(m.text)
                const replyAuthor = senderName ?? peer?.nickname ?? `#${m.from}`
                const isPlainText =
                  m.kind !== 'photo' && m.kind !== 'video' && m.kind !== 'file' && m.kind !== 'other' && invite == null
                const showActions = actionsForRowId === m.id
                const showReactionPicker = reactionForRowId === m.id
                return (
                  <li key={`in-${m.id}`} id={`msg-${m.id}`} className={`group flex justify-start rounded-lg transition-colors duration-500 ${item.cont ? '-mt-1' : ''} ${highlightId === m.id ? 'bg-accent/15' : ''}`} {...swipeReply(() => startReplyTo(m.id, m.text, replyAuthor))}>
                    <div className="relative max-w-[80%] flex flex-col items-start gap-1">
                      {senderName && !item.cont && (
                        <Link
                          to={`/profile/${m.from}`}
                          className="flex items-center gap-1.5 font-mono text-[10px] text-fg-dim px-1 hover:text-accent transition-colors"
                        >
                          {/* Beside the nick, never instead of it, and only
                              when there is a picture. */}
                          <SenderAvatar mediaId={senderMember?.avatar_media_id} mediaKey={senderMember?.avatar_media_key} size={16} />
                          {senderName}
                        </Link>
                      )}
                      {m.replyTo && (
                        <button
                          type="button"
                          onClick={() => jumpToMessage(m.replyTo!.id)}
                          className="border-l-2 border-accent/60 pl-2 max-w-full text-left rounded-r hover:bg-line/30 transition-colors cursor-pointer"
                        >
                          <div className="font-mono text-[10px] text-fg-dim">{m.replyTo.authorName}</div>
                          <div className="text-[11px] text-fg-secondary line-clamp-3 break-words max-w-[18rem]"><EmoticonText text={m.replyTo.snippet} emoticonSize={14} /></div>
                        </button>
                      )}
                      {m.kind === 'poll' && m.poll ? (
                        <PollBubble poll={m.poll} />
                      ) : m.kind === 'photo' && m.mediaId && m.mediaKey ? (
                        <div className="flex flex-col items-start gap-1">
                          <DecryptedImage mediaId={m.mediaId} mediaKey={m.mediaKey} apiBase={groupMediaBase} />
                          {m.text && (
                            <div className="rounded-lg px-3 py-2 text-sm bg-bubble-other">
                              <EmoticonText text={m.text} emoticonSize={18} />
                            </div>
                          )}
                        </div>
                      ) : m.kind === 'video' && m.mediaId && m.mediaKey ? (
                        <div className="flex flex-col items-start gap-1">
                          <DecryptedVideo
                            mediaId={m.mediaId}
                            mediaKey={m.mediaKey}
                            thumbnailB64={m.thumbnailB64}
                            durationSec={m.durationSec}
                            apiBase={groupMediaBase}
                          />
                          {m.text && (
                            <div className="rounded-lg px-3 py-2 text-sm bg-bubble-other">
                              <EmoticonText text={m.text} emoticonSize={18} />
                            </div>
                          )}
                        </div>
                      ) : m.kind === 'file' && m.mediaId && m.mediaKey ? (
                        <div className="flex flex-col items-start gap-1">
                          <FileBubble
                            mediaId={m.mediaId}
                            mediaKey={m.mediaKey}
                            fileName={m.fileName}
                            mime={m.fileMime}
                            size={m.fileSize}
                            apiBase={groupMediaBase}
                          />
                          {m.text && (
                            <div className="rounded-lg px-3 py-2 text-sm bg-bubble-other">
                              <EmoticonText text={m.text} emoticonSize={18} />
                            </div>
                          )}
                        </div>
                      ) : m.kind === 'other' ? (
                        <MediaPlaceholder mediaKind={m.mediaKind} />
                      ) : invite != null ? (
                        <GroupJoinCard groupId={invite.id} host={invite.host} />
                      ) : (
                        <button
                          data-chat-menu
                          onClick={() => toggleActions(m.id)}
                          onContextMenu={(e) => { e.preventDefault(); toggleActions(m.id) }}
                          className="rounded-lg px-3 py-2 text-sm text-left bg-bubble-other hover:brightness-110 transition-colors"
                        >
                          <EmoticonText text={m.text} emoticonSize={18} />
                          {m.edited && <span className="ml-1 text-[10px] text-fg-dim italic">{t('chat.edit.edited')}</span>}
                        </button>
                      )}
                      {renderReactions(m.id, 'start')}
                      <div className="text-[10px] font-mono text-fg-dim">
                        {new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      {isPlainText && showActions && (
                        <div data-chat-menu className="flex items-center gap-1.5 rounded-lg bg-surface px-2 py-1 shadow-lg">
                          <ActionButton onClick={() => startReplyTo(m.id, m.text, replyAuthor)} label={t('chat.actions.reply')} icon="↩" />
                          {m.kind === 'text' && (
                            <ActionButton onClick={() => copyText(m.text)} label={t('chat.actions.copy')} icon="⧉" />
                          )}
                          {canPin && (
                            <ActionButton onClick={() => pinMessage(m.text)} label={t('chat.actions.pin')} icon="📌" />
                          )}
                          {m.kind === 'text' && (
                            <ActionButton
                              onClick={() => { setForwardingRow({ text: m.text, author: replyAuthor }); setActionsForRowId(null) }}
                              label={t('chat.actions.forward')}
                              icon="↗"
                            />
                          )}
                          {/* Hides it HERE only. There is no deleting somebody
                              else's message off their device, and offering a
                              button that looks like it might is worse than not
                              offering one — hence the wording, not "delete". */}
                          <ActionButton
                            onClick={() => { markDeleted(m.id); setActionsForRowId(null) }}
                            label={t('chat.actions.hide')}
                            icon="⊘"
                          />
                        </div>
                      )}
                      <AnimatePresence>
                        {showReactionPicker && (
                          <motion.div
                            key="rp"
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 4 }}
                            transition={{ duration: 0.12 }}
                            className="absolute top-full left-0 mt-1 z-20"
                          >
                            <ReactionPicker
                              uin={identity!.uin}
                              current={reactionsForTarget(m.id)?.get(identity!.uin) ?? null}
                              onPick={(asset) => void toggleReaction(m.id, asset)}
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    <button
                      type="button"
                      data-chat-menu
                      onClick={() => setReactionForRowId((id) => (id === m.id ? null : m.id))}
                      aria-label={t('chat.actions.react')}
                      title={t('chat.actions.react')}
                      className="self-center ml-1 h-7 w-7 rounded-full bg-surface text-fg-dim opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex-none hidden sm:flex items-center justify-center"
                    >
                      ☺
                    </button>
                  </li>
                )
              }
              const row = item.row
              const outInvite = parseGroupInvite(row.text)
              if (outInvite != null) {
                // A group-invite link I shared — show the join card
                // (not a raw URL bubble) with the delivery state below.
                return (
                  <li key={row.id} id={`msg-${row.id}`} className={`group flex justify-end rounded-lg transition-colors duration-500 ${item.cont ? '-mt-1' : ''} ${highlightId === row.id ? 'bg-accent/15' : ''}`}>
                    <div className="relative max-w-[80%] flex flex-col items-end gap-1">
                      <GroupJoinCard groupId={outInvite.id} host={outInvite.host} />
                      <div className="flex items-center justify-end gap-1 text-[10px] font-mono text-fg-dim">
                        {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {row.state === 'sending' && <ClockMark />}
                        {row.state === 'sent' && <TickMark />}
                        {row.state === 'failed' && (
                          <>
                            <span className="text-red-500">·{t('chat.delivery.failed')}</span>
                            <button
                              onClick={() => void retry(row.id)}
                              className="ml-1 rounded px-1.5 py-0.5 text-red-600 hover:bg-red-100 transition-colors"
                            >
                              ↻ {t('chat.delivery.retry')}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                )
              }
              if (row.kind === 'photo' && row.mediaId && row.mediaKey) {
                // A photo I sent — render the image bubble + delivery state.
                return (
                  <li key={row.id} id={`msg-${row.id}`} className={`group flex justify-end rounded-lg transition-colors duration-500 ${item.cont ? '-mt-1' : ''} ${highlightId === row.id ? 'bg-accent/15' : ''}`}>
                    <div className="relative max-w-[80%] flex flex-col items-end gap-1">
                      <DecryptedImage mediaId={row.mediaId} mediaKey={row.mediaKey} apiBase={groupMediaBase} />
                      {row.text && (
                        <div className="rounded-lg px-3 py-2 text-sm bg-bubble-self">
                          <EmoticonText text={row.text} emoticonSize={18} />
                        </div>
                      )}
                      {renderReactions(row.id, 'end')}
                      <div className="flex items-center justify-end gap-1 text-[10px] font-mono text-fg-dim">
                        {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {row.state === 'sending' && <ClockMark />}
                        {row.state === 'sent' && <TickMark />}
                        {row.state === 'failed' && (
                          <>
                            <span className="text-red-500">·{t('chat.delivery.failed')}</span>
                            <button
                              onClick={() => void retry(row.id)}
                              className="ml-1 rounded px-1.5 py-0.5 text-red-600 hover:bg-red-100 transition-colors"
                            >
                              ↻ {t('chat.delivery.retry')}
                            </button>
                            <button
                              onClick={() => dismiss(row.id)}
                              className="rounded px-1.5 py-0.5 text-fg-dim hover:bg-line transition-colors"
                            >
                              × {t('chat.delivery.dismiss')}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                )
              }
              if (row.kind === 'video' && row.mediaId && row.mediaKey) {
                // A video I sent (echoed from another device via a carbon) —
                // render the player + delivery state.
                return (
                  <li key={row.id} id={`msg-${row.id}`} className={`group flex justify-end rounded-lg transition-colors duration-500 ${item.cont ? '-mt-1' : ''} ${highlightId === row.id ? 'bg-accent/15' : ''}`}>
                    <div className="relative max-w-[80%] flex flex-col items-end gap-1">
                      <DecryptedVideo
                        mediaId={row.mediaId}
                        mediaKey={row.mediaKey}
                        thumbnailB64={row.thumbnailB64}
                        durationSec={row.durationSec}
                        apiBase={groupMediaBase}
                      />
                      {row.text && (
                        <div className="rounded-lg px-3 py-2 text-sm bg-bubble-self">
                          <EmoticonText text={row.text} emoticonSize={18} />
                        </div>
                      )}
                      <div className="flex items-center justify-end gap-1 text-[10px] font-mono text-fg-dim">
                        {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        <span className="text-accent">✓</span>
                      </div>
                    </div>
                  </li>
                )
              }
              if (row.kind === 'file' && row.mediaId && row.mediaKey) {
                // A document I sent — render the download chip + delivery state.
                return (
                  <li key={row.id} id={`msg-${row.id}`} className={`group flex justify-end rounded-lg transition-colors duration-500 ${item.cont ? '-mt-1' : ''} ${highlightId === row.id ? 'bg-accent/15' : ''}`}>
                    <div className="relative max-w-[80%] flex flex-col items-end gap-1">
                      <FileBubble
                        mediaId={row.mediaId}
                        mediaKey={row.mediaKey}
                        fileName={row.fileName}
                        mime={row.fileMime}
                        size={row.fileSize}
                        apiBase={groupMediaBase}
                      />
                      {row.text && (
                        <div className="rounded-lg px-3 py-2 text-sm bg-bubble-self">
                          <EmoticonText text={row.text} emoticonSize={18} />
                        </div>
                      )}
                      <div className="flex items-center justify-end gap-1 text-[10px] font-mono text-fg-dim">
                        {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {row.state === 'sending' && <ClockMark />}
                        {row.state === 'sent' && <TickMark />}
                        {row.state === 'failed' && (
                          <>
                            <span className="text-red-500">·{t('chat.delivery.failed')}</span>
                            <button
                              onClick={() => void retry(row.id)}
                              className="ml-1 rounded px-1.5 py-0.5 text-red-600 hover:bg-red-100 transition-colors"
                            >
                              ↻ {t('chat.delivery.retry')}
                            </button>
                            <button
                              onClick={() => dismiss(row.id)}
                              className="rounded px-1.5 py-0.5 text-fg-dim hover:bg-line transition-colors"
                            >
                              × {t('chat.delivery.dismiss')}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                )
              }
              if (row.kind === 'other') {
                // A still-unsupported media (voice/location) the user sent from
                // another device, echoed here via a carbon.
                return (
                  <li key={row.id} id={`msg-${row.id}`} className={`group flex justify-end rounded-lg transition-colors duration-500 ${item.cont ? '-mt-1' : ''} ${highlightId === row.id ? 'bg-accent/15' : ''}`}>
                    <div className="relative max-w-[80%] flex flex-col items-end gap-1">
                      <MediaPlaceholder mediaKind={row.mediaKind} />
                      <div className="flex items-center justify-end gap-1 text-[10px] font-mono text-fg-dim">
                        {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        <span className="text-accent">✓</span>
                      </div>
                    </div>
                  </li>
                )
              }
              const showActions = actionsForRowId === row.id
              const showReactionPicker = reactionForRowId === row.id
              return (
              <li key={row.id} id={`msg-${row.id}`} className={`group flex justify-end rounded-lg transition-colors duration-500 ${item.cont ? '-mt-1' : ''} ${highlightId === row.id ? 'bg-accent/15' : ''}`} {...swipeReply(() => startReply(row))}>
                <div className="relative max-w-[80%] flex flex-col items-end gap-1">
                  {row.fwdName && (
                    <div className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
                      ↗ {t('chat.forwarded_label', { name: row.fwdName })}
                    </div>
                  )}
                  {row.replyTo && (
                    <button
                      type="button"
                      onClick={() => jumpToMessage(row.replyTo!.id)}
                      className="border-l-2 border-accent/60 pl-2 max-w-full text-left rounded-r hover:bg-line/30 transition-colors cursor-pointer"
                    >
                      <div className="font-mono text-[10px] text-fg-dim">{row.replyTo.authorName}</div>
                      <div className="text-[11px] text-fg-secondary line-clamp-3 break-words max-w-[18rem]">
                        <EmoticonText text={row.replyTo.snippet} emoticonSize={14} />
                      </div>
                    </button>
                  )}
                  <button
                    data-chat-menu
                    onClick={() => toggleActions(row.id)}
                    // Right-click opens the same actions. On a phone, tapping a
                    // bubble to get reply/edit/delete is the obvious gesture; on
                    // a desktop it is not, and a right-click just produced the
                    // browser's own menu — so desktop Windows reported that
                    // deleting a note "is still not there" when it had been
                    // there all along, one left-click away.
                    onContextMenu={(e) => { e.preventDefault(); toggleActions(row.id) }}
                    className={`rounded-lg px-3 py-2 text-sm text-left transition-colors ${
                      row.state === 'failed'
                        ? 'bg-red-50 border border-red-200'
                        : 'bg-bubble-self hover:bg-bubble-self/90'
                    }`}
                  >
                    <EmoticonText text={row.text} emoticonSize={18} />
                    {row.edited && <span className="ml-1 text-[10px] text-fg-dim italic">{t('chat.edit.edited')}</span>}
                  </button>
                  {renderReactions(row.id, 'end')}
                  <div className="flex items-center justify-end gap-1 text-[10px] font-mono text-fg-dim">
                    {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {row.state === 'sending' && <ClockMark />}
                    {row.state === 'sent' && <TickMark />}
                    {row.state === 'failed' && (
                      <>
                        <span className="text-red-500">·{t('chat.delivery.failed')}</span>
                        <button
                          onClick={() => void retry(row.id)}
                          className="ml-1 rounded px-1.5 py-0.5 text-red-600 hover:bg-red-100 transition-colors"
                        >
                          ↻ {t('chat.delivery.retry')}
                        </button>
                        <button
                          onClick={() => dismiss(row.id)}
                          className="rounded px-1.5 py-0.5 text-fg-dim hover:bg-line transition-colors"
                        >
                          × {t('chat.delivery.dismiss')}
                        </button>
                      </>
                    )}
                  </div>
                  {row.state === 'failed' && row.error && (
                    <div className="text-right text-[10px] text-red-500/80 max-w-full break-words">
                      {row.error}
                    </div>
                  )}
                  {showActions && row.state === 'sent' && (
                    <div data-chat-menu className="flex items-center gap-1.5 rounded-lg bg-surface px-2 py-1 shadow-lg">
                      <ActionButton onClick={() => startReply(row)} label={t('chat.actions.reply')} icon="↩" />
                      {(!row.kind || row.kind === 'text') && (
                        <ActionButton onClick={() => startEdit(row)} label={t('chat.actions.edit')} icon="✎" />
                      )}
                      {(!row.kind || row.kind === 'text') && (
                        <ActionButton onClick={() => copyText(row.text)} label={t('chat.actions.copy')} icon="⧉" />
                      )}
                      {canPin && (
                        <ActionButton onClick={() => pinMessage(row.text)} label={t('chat.actions.pin')} icon="📌" />
                      )}
                      <ActionButton onClick={() => setForwardingRow({ text: row.text, author: myNickname })} label={t('chat.actions.forward')} icon="↗" />
                      <ActionButton onClick={() => void deleteForEveryone(row)} label={t('chat.actions.delete')} danger />
                    </div>
                  )}
                  <AnimatePresence>
                    {showReactionPicker && (
                      <motion.div
                        key="rp"
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 4 }}
                        transition={{ duration: 0.12 }}
                        className="absolute top-full right-0 mt-1 z-20"
                      >
                        <ReactionPicker
                          uin={identity!.uin}
                          current={reactionsForTarget(row.id)?.get(identity!.uin) ?? null}
                          onPick={(asset) => void toggleReaction(row.id, asset)}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <button
                  type="button"
                  data-chat-menu
                  onClick={() => setReactionForRowId((id) => (id === row.id ? null : row.id))}
                  aria-label={t('chat.actions.react')}
                  title={t('chat.actions.react')}
                  className="self-center mr-1 order-first h-7 w-7 rounded-full bg-surface text-fg-dim opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex-none hidden sm:flex items-center justify-center"
                >
                  ☺
                </button>
              </li>
            )
          })}
        </ul>
        {/* Scroll anchor — keeps the newest message in view. */}
        <div ref={bottomRef} />
      </main>

      {/* Jump to the newest. Only while the user has scrolled up: the list
          deliberately does not follow new messages then, so without this the
          only way back was dragging the scrollbar, and a message that arrived
          meanwhile gave no sign of itself at all. */}
      {!atBottom && (
        <div className="relative max-w-2xl w-full mx-auto">
          <button
            type="button"
            onClick={stickToBottom}
            aria-label={t('chat.jump_to_newest')}
            title={t('chat.jump_to_newest')}
            className="absolute bottom-2 right-4 z-20 h-10 min-w-10 px-2 rounded-full bg-surface shadow-lg text-fg-primary flex items-center justify-center gap-1 hover:bg-field transition-colors"
          >
            <span aria-hidden="true" className="text-base leading-none">↓</span>
            {unseenBelow > 0 && (
              <span className="text-xs font-semibold tabular-nums">{unseenBelow}</span>
            )}
          </button>
        </div>
      )}

      {/* Composer: the input is a bordered round pill, side buttons are round,
          and the emoji panel is a floating overlay ABOVE the composer — it does
          not push the input down or the messages up.
          The bar itself carries the same translucent blur as the header: the
          thread scrolls UNDER it, and with no background at all the last bubble
          slid beneath the pill and stayed legible through it, which read as a
          rendering fault rather than as depth. */}
      <div className="rcq-floating-bar flex-none pb-[env(safe-area-inset-bottom)]">
        <div className="relative max-w-lg mx-auto px-3 py-3">
          {/* Everything that floats above the composer lives in ONE stack: the
              emoji panel on top, the reply/edit strip under it, both over the
              thread. They used to be two absolute layers pinned to the same
              edge, which is why opening the panel while replying put it BEHIND
              the strip. */}
          <div className="absolute bottom-full inset-x-0 px-3 mb-2 z-10 flex flex-col gap-2 pointer-events-none [&>*]:pointer-events-auto">
            <AnimatePresence>
              {showPicker && (
                <EmoticonPicker
                  key="picker"
                  uin={identity!.uin}
                  onPick={(code, asset) => insertEmoticon(code, asset)}
                />
              )}
            </AnimatePresence>
            <AnimatePresence>
              {editingRow && (
                <motion.div
                  key="editing"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{ duration: 0.14 }}
                  className="flex items-start gap-2 rounded-2xl bg-surface shadow-lg px-3 py-2 text-xs"
                >
                  <div className="border-l-2 border-accent/60 pl-2 flex-1 min-w-0">
                    <div className="font-mono text-[10px] text-accent uppercase tracking-wider">
                      {t('chat.edit.editing')}
                    </div>
                    <div className="text-fg-secondary truncate">{editingRow.text}</div>
                  </div>
                  <button
                    onClick={cancelEdit}
                    className="font-mono text-[10px] uppercase tracking-wider text-fg-dim hover:text-fg-primary"
                  >
                    × {t('chat.reply.cancel')}
                  </button>
                </motion.div>
              )}
              {replyTo && !editingRow && (
                <motion.div
                  key="replying"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{ duration: 0.14 }}
                  className="flex items-start gap-2 rounded-2xl bg-surface shadow-lg px-3 py-2 text-xs"
                >
                  <div className="border-l-2 border-accent/60 pl-2 flex-1 min-w-0">
                    <div className="font-mono text-[10px] text-fg-dim">
                      {t('chat.reply.replying_to', { name: replyTo.authorName })}
                    </div>
                    <div className="text-fg-secondary truncate"><EmoticonText text={replyTo.snippet} emoticonSize={14} /></div>
                  </div>
                  <button
                    onClick={cancelReply}
                    className="font-mono text-[10px] uppercase tracking-wider text-fg-dim hover:text-fg-primary"
                  >
                    × {t('chat.reply.cancel')}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {!isGroup && peer?.blocked ? (
            <div className="flex items-center justify-center gap-3 rounded-2xl bg-surface px-4 py-3 text-sm text-fg-secondary">
              <span>{t('chat.blocked.notice')}</span>
              <button
                onClick={() => void unblockPeer()}
                className="rounded-full bg-accent hover:bg-accent-dim text-white text-xs font-semibold px-3 py-1.5 transition-colors"
              >
                {t('chat.blocked.unblock')}
              </button>
            </div>
          ) : isGroup && group?.post_policy === 'owner_only' && identity != null && group.owner_uin !== identity.uin ? (
            // Broadcast group: only the owner posts. Match the iOS/Android
            // read-only notice (the server enforces it too now).
            <div className="flex items-center justify-center rounded-2xl bg-surface px-4 py-3 text-sm text-fg-secondary">
              <span>{t('chat.owner_only.notice')}</span>
            </div>
          ) : (
          <div className="relative">
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = '' // allow re-picking the same file
                if (file) void sendPhoto(file)
              }}
            />
            <input
              ref={docInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = '' // allow re-picking the same file
                if (file) void sendFile(file)
              }}
            />
            <div className="relative flex-none">
              <button
                onClick={() => setAttachMenuOpen((v) => !v)}
                disabled={(!peer && !group) || uploadingPhoto || uploadingFile}
                className="h-10 w-10 rounded-full flex items-center justify-center text-fg-secondary hover:bg-line/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title={t('chat.attach')}
                aria-label={t('chat.attach')}
              >
                {uploadingPhoto || uploadingFile ? <span className="text-xs">…</span> : <AttachIcon />}
              </button>
              <AnimatePresence>
                {attachMenuOpen && (
                  <>
                    {/* click-away backdrop */}
                    <div className="fixed inset-0 z-10" onClick={() => setAttachMenuOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 6 }}
                      transition={{ duration: 0.14 }}
                      data-chat-menu
                      className="absolute bottom-full left-0 mb-2 z-20 w-44 rounded-xl bg-surface shadow-lg overflow-hidden"
                    >
                      <button
                        onClick={() => {
                          setAttachMenuOpen(false)
                          fileInputRef.current?.click()
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm hover:bg-field transition-colors"
                      >
                        <AttachIcon />
                        {t('chat.attach.photo')}
                      </button>
                      <button
                        onClick={() => {
                          setAttachMenuOpen(false)
                          docInputRef.current?.click()
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm hover:bg-field transition-colors"
                      >
                        <DocIcon />
                        {t('chat.attach.file')}
                      </button>
                      <button
                        onClick={() => void sendLocation()}
                        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm hover:bg-field transition-colors"
                      >
                        <PinIcon />
                        {t('chat.attach.location')}
                      </button>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
            <button
              onClick={() => setShowPicker((v) => !v)}
              className={`h-10 w-10 rounded-full flex items-center justify-center flex-none transition-colors ${
                showPicker ? 'bg-accent/15 ring-1 ring-accent/40' : 'hover:bg-line/60'
              }`}
              title={t('chat.emoticons')}
              aria-label={t('chat.emoticons')}
            >
              <img
                src={emoticonAssetURL('smile')}
                alt=""
                width={22}
                height={22}
                draggable={false}
                className="select-none"
              />
            </button>
            <EmoticonInput
              ref={taRef}
              className="flex-1 rounded-2xl bg-surface px-4 py-2.5 text-sm outline-none leading-snug focus:ring-1 focus:ring-accent transition-colors max-h-[140px] overflow-y-auto"
              placeholder={
                isGroup && group
                  ? t('chat.placeholder.group', { name: group.name })
                  : peer
                    ? t('chat.placeholder', { nick: peer.nickname })
                    : t('chat.placeholder_loading')
              }
              value={input}
              onChange={(v) => { setInput(v); if (v) notifyTyping(); else stopTyping() }}
              onBlur={stopTyping}
              onSubmit={() => void send()}
              // Up-arrow on an empty composer edits your last message, the
              // habit every messenger and shell shares. Editing existed but was
              // reachable only by clicking the bubble and picking a menu item.
              onArrowUpEmpty={() => {
                if (editingRow) return
                const last = [...outgoing]
                  .reverse()
                  .find((r) => r.state === 'sent' && (!r.kind || r.kind === 'text'))
                if (last) startEdit(last)
              }}
              onPasteImage={(file) => void sendPhoto(file)}
              disabled={!peer && !group}
            />
            <button
              onClick={() => void send()}
              disabled={(!peer && !group) || !input.trim()}
              className="h-10 w-10 rounded-full bg-accent hover:bg-accent-dim text-white flex items-center justify-center flex-none disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label={t('chat.send')}
              title={t('chat.send')}
            >
              <SendIcon />
            </button>
          </div>
          </div>
          )}
        </div>
      </div>

      <ForwardModal
        visible={forwardingRow != null}
        onClose={() => setForwardingRow(null)}
        onPick={async (target) => {
          if (forwardingRow) await forwardTo(forwardingRow, target)
        }}
      />
    </div>
  )
}

function ActionButton({ onClick, label, icon, danger }: { onClick: () => void; label: string; icon?: string; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
        danger
          ? 'text-red-500 hover:bg-red-500/15'
          : 'text-fg-secondary hover:bg-field hover:text-fg-primary'
      }`}
    >
      {icon && <span>{icon}</span>}
      <span>{label}</span>
    </button>
  )
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  )
}

function AttachIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

/// Bookmark glyph for the Saved Messages («Заметки») chat header.
/// Handset glyph for "call this contact". Same weight as the other header
/// icons so the row reads as one set.
/// In flight: the island does not have it yet.
function ClockMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-dim" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

/// The island has it. Deliberately a SINGLE tick: two ticks mean "they have it"
/// everywhere anyone has seen them, and this client is never told that — there
/// is no delivery or read receipt on the web, only sending / sent / failed.
function TickMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden>
      <path d="M4 12.5l5 5L20 7" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  )
}

function HeaderPhoneIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
    </svg>
  )
}

/// Camcorder glyph for "call with video".
function HeaderCameraIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  )
}

function BookmarkIcon() {
  return (
    <svg className="text-accent flex-none" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
    </svg>
  )
}

/// Document glyph for the "File" attach-menu item — a sheet with a folded corner.
function DocIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="14 3 14 9 20 9" />
    </svg>
  )
}

/// Placeholder bubble for an incoming media kind the web can't render
/// yet (video/voice/file/location). Shows the kind + an "open in app"
/// hint rather than silently dropping the message.
function MediaPlaceholder({ mediaKind }: { mediaKind?: string }) {
  const { t } = useI18n()
  const icon =
    mediaKind === 'video' ? '🎬' :
    mediaKind === 'voice' ? '🎤' :
    mediaKind === 'location' ? '📍' : '📎'
  const label = mediaKind ? t(`chat.media.kind.${mediaKind}`) : t('chat.media.kind.file')
  return (
    <div className="rounded-lg px-3 py-2 bg-bubble-other">
      <div className="text-sm">{icon} {label}</div>
      <div className="text-[10px] text-fg-dim">{t('chat.media.in_app_only')}</div>
    </div>
  )
}

/// Group pinned announcement (#4 — web showed no pin at all). Collapsed to a
/// single truncated line; tapping expands it into a FIXED-height scrollable box
/// (#5 — a long pin must not push the whole chat down / become unscrollable).
/// One-line collapsed preview: strip invite links / URLs so the pinned bar
/// reads as clean text instead of raw `https://rcq.app/g/…` noise.
function pinPreview(text: string): string {
  return text
    .replace(/(?:https?:\/\/)?(?:www\.|chat\.)?rcq\.app\/g\/\d+/gi, '')
    .replace(/rcq:\/\/group\/\d+/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function PinnedBanner({ text, group, expanded, onToggle }: { text: string; group: RCQGroup; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  return (
    // Same treatment as the header (see `.rcq-header`): the pin is a bar that
    // floats over the thread, so it takes the page's own colour at reduced
    // alpha with a blur behind it. The grey `bg-field` it used to have made it
    // read as a third surface stacked between the header and the messages.
    <div className="rcq-floating-bar flex-none relative z-20">
      <div className="max-w-2xl mx-auto w-full relative">
        <button
          type="button"
          onClick={onToggle}
          className="w-full px-4 py-2 flex items-center gap-2 text-left hover:bg-line/30"
        >
          <PinIcon />
          {expanded ? (
            <div className="flex-1 min-w-0 text-[13px] font-medium text-fg-secondary">{t('chat.pin.title')}</div>
          ) : (
            <div className="flex-1 min-w-0 truncate text-[13px] text-fg-secondary">{pinPreview(text)}</div>
          )}
          <span className="text-fg-dim text-xs shrink-0">{expanded ? '▲' : '▼'}</span>
        </button>
        {/* Smooth expand/collapse (#pin-animate). overflow-hidden clips the
            height tween; the inner box keeps its own scroll + bottom padding so
            the last group card never touches the edge (#pin-card-padding).

            Absolute, hanging off the bottom of the bar rather than sitting in
            the column: expanding used to add height to a flex-none row, which
            pushed the whole thread down and shoved the messages you were
            reading off the screen. Opening a pin is a glance, not a
            re-layout, so it now unfolds OVER the conversation and carries the
            bar's own blur so the thread stays visible behind it. */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="pin-body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="rcq-floating-panel absolute left-0 right-0 top-full overflow-hidden shadow-lg shadow-black/5"
            >
              <div className="px-4 pt-1 pb-3 max-h-96 overflow-y-auto text-[13px] text-fg-secondary">
                <PinnedRichText text={text} group={group} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function PinIcon() {
  return (
    <svg className="text-fg-secondary shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14l-1.5-3V6a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v8L5 17z" />
    </svg>
  )
}

/// Renders the pinned announcement the way the native apps do (#pin-native):
/// group-invite links become join CARDS, #UIN mentions become clickable nicks,
/// plain URLs become clickable links, everything else is plain text. Whitespace
/// preserved so multi-line pins keep their shape.
function PinnedRichText({ text, group }: { text: string; group: RCQGroup }) {
  const nodes: ReactNode[] = []
  // group-invite link | generic URL | #UIN mention
  const re = /((?:https?:\/\/)?(?:www\.|chat\.)?rcq\.app\/g\/\d+(?:@[a-z0-9.-]+)?|rcq:\/\/group\/\d+(?:@[a-z0-9.-]+)?)|(https?:\/\/[^\s]+)|#(\d{3,})/gi
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  const pushText = (s: string) => { if (s) nodes.push(<span key={key++}>{s}</span>) }
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index))
    last = m.index + m[0].length
    if (m[1]) {
      const inv = parseGroupInvite(m[1])
      if (inv != null) {
        nodes.push(<div key={key++} className="my-1.5"><GroupJoinCard groupId={inv.id} host={inv.host} /></div>)
      } else {
        pushText(m[0])
      }
    } else if (m[2]) {
      nodes.push(
        <a key={key++} href={m[2]} target="_blank" rel="noreferrer" className="text-accent hover:underline break-all">{m[2]}</a>,
      )
    } else if (m[3]) {
      const uin = Number(m[3])
      const nick = group.members.find((x) => x.uin === uin)?.nickname
      nodes.push(
        <Link key={key++} to={`/profile/${uin}`} className="text-accent hover:text-accent-dim transition-colors">{nick ?? `#${uin}`}</Link>,
      )
    }
  }
  pushText(text.slice(last))
  return <div className="whitespace-pre-wrap break-words">{nodes}</div>
}

/// Renders a group poll inline (#7 — polls were invisible on web). The ballot
/// comes from the envelope; live tallies + the caller's vote come from
/// /polls/{id}. Tap an option to (un)vote.
function PollBubble({ poll }: { poll: PollRow }) {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const [tally, setTally] = useState<PollOut | null>(null)
  useEffect(() => {
    if (!identity) return
    let alive = true
    void Api.loadPoll(identity, poll.pollId)
      .then((p) => { if (alive) setTally(p) })
      .catch(() => {})
    return () => { alive = false }
  }, [identity, poll.pollId])
  const total = tally?.total_votes ?? 0
  const myVotes = tally?.my_votes ?? []
  const closed = tally?.closed_at != null
  async function vote(i: number) {
    if (closed || !identity) return
    try { setTally(await Api.votePoll(identity, poll.pollId, i)) } catch { /* ignore */ }
  }
  return (
    <div className="rounded-lg px-3 py-2 bg-bubble-other w-[18rem] max-w-full">
      <div className="text-sm font-semibold">{poll.question}</div>
      <div className="text-[10px] text-fg-dim mb-2">
        {poll.single ? t('poll.single') : t('poll.multi')}
        {poll.anon ? ` · ${t('poll.anon')}` : ''}
      </div>
      <div className="flex flex-col gap-1.5">
        {poll.options.map((opt, i) => {
          const count = tally?.tallies.find((x) => x.option_index === i)?.count ?? 0
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          const mine = myVotes.includes(i)
          return (
            <button
              key={i}
              type="button"
              disabled={closed}
              onClick={() => void vote(i)}
              className="relative text-left rounded-md overflow-hidden bg-field px-2 py-1.5 disabled:cursor-default"
            >
              <div className="absolute inset-y-0 left-0 bg-accent/20" style={{ width: `${pct}%` }} />
              <div className="relative flex items-center gap-2 text-[13px]">
                <span className="flex-1 truncate">{mine ? '✓ ' : ''}{opt}</span>
                <span className="text-fg-secondary tabular-nums whitespace-nowrap">{count} · {pct}%</span>
              </div>
            </button>
          )
        })}
      </div>
      <div className="text-[11px] text-fg-dim mt-2">
        {t('poll.votes', { n: total })}{closed ? ` · ${t('poll.closed')}` : ''}
      </div>
    </div>
  )
}
