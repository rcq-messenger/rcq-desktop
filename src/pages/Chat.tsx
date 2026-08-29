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

import { relativeLastSeen } from '../lib/last-seen'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { scopedKey } from '../lib/account-scope'
import { AnimatePresence, motion } from 'framer-motion'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { EmoticonInput, insertEmoticonAt, serialize as serializeComposer } from '../components/EmoticonInput'
import { EmoticonPicker } from '../components/EmoticonPicker'
import { EmoticonText } from '../components/EmoticonText'
import { ForwardModal, type ForwardTarget } from '../components/ForwardModal'
import { ReactionAuthors, type ReactionAuthor } from '../components/ReactionAuthors'
import { ReactionPicker } from '../components/ReactionPicker'
import { PersonAvatar } from '../components/PersonAvatar'
import { SenderAvatar } from '../components/SenderAvatar'
import { Api, peerBundleFrom, type Contact, type RCQGroup, type UserInfo } from '../lib/api'
import { isTauri, openExternal } from '../lib/desktop'
import {
  useIncoming,
  useGroupIncoming,
  setActiveThread,
  groupUnreadCount,
  peerUnreadCount,
  applyReaction,
  reactionsForTarget,
  aggregateReactions,
  useReactionsVersion,
  markDeleted,
  isDeleted,
  useDeletedVersion,
  noteOwnEnvelope,
  sweepExpiredIncoming,
  takePendingUnreadFor,
  type IncomingRow,
} from '../lib/incoming-store'
import { PartialFanOutError, sendV2 } from '../lib/signal-device'
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
  ownExpiry,
  setEditSink,
  setOutgoingSink,
  setReceiptSink,
} from '../lib/outgoing-store'
import { noteThreadViewed } from '../lib/read-receipts'
import { buildGroupDualSend, encryptGroupEnvelope, withGroupSendLock } from '../lib/group-crypto'
import { parseGroupInvite } from '../lib/group-invite'
import { ShareGroupSheet } from '../components/ShareGroupSheet'
import {
  clearMention,
  markMentionSeen,
  mentionSeenAt,
  mentionsMe,
  type MentionRoster,
} from '../lib/mentions'
import type { MentionContext } from '../components/EmoticonText'
import { groupApiCtx } from '../lib/visited-islands'
import { ensureRoster, memberCount } from '../lib/group-roster'
import { useGroupChanged } from '../lib/group-events'
import { compactCount } from '../lib/format-count'
import {
  SWEEP_INTERVAL_MS,
  TTL_OPTIONS,
  lapsed,
  remainingLabel,
  setThreadTtl,
  threadTtl,
  ttlLabelKey,
  ttlThreadKey,
  useThreadTtl,
} from '../lib/disappearing'
import { noteReactionUsed } from '../lib/reaction-usage'
import { canOpenProfileCard } from '../lib/profile-card-privacy'
import { GroupJoinCard } from '../components/GroupJoinCard'
import { GroupAvatar } from '../components/GroupAvatar'
import { DecryptedImage } from '../components/DecryptedImage'
import { DecryptedVideo } from '../components/DecryptedVideo'
import { FileBubble } from '../components/FileBubble'
import { VoiceBubble } from '../components/VoiceBubble'
import { uploadEncryptedImage, uploadEncryptedFile, uploadEncryptedAudio, downloadEncryptedFile } from '../lib/media'
import { emoticonAssetURL } from '../lib/emoticons'
import { useI18n } from '../lib/i18n-context'
import { useToast } from '../lib/toast'
import { useIdentity } from '../lib/identity-context'
import { isSentSoundEnabled, playSound } from '../lib/sounds'
import { useCall } from '../lib/call'
import { contactAlias, useContactAliases } from '../lib/local-store'
import { useWS } from '../lib/ws'

/// Envelope kinds `shipEnvelopeToCurrentThread` is allowed to encrypt + send.
/// (Carbons take a separate path; this gates the in-thread sends.) `edit` was
/// missing here, which silently rejected edit propagation to the peer.
const SHIPPABLE_KINDS = new Set<Envelope['kind']>(['text', 'reaction', 'photo', 'video', 'file', 'edit', 'delete', 'location'])

/// Message kinds we mirror to the user's other devices via a carbon
/// (NOT reactions — those sync through their own self-echo).
///
/// `edit` and `delete` joined 2026-08-21: the group fan-out deliberately
/// skips self (group-crypto), so the carbon is the ONLY road an edit or a
/// retract has to the account's other devices — without them the founder
/// edited a message on the desktop and the phone kept the old text forever.
const CARBON_KINDS = new Set<Envelope['kind']>(['text', 'photo', 'video', 'file', 'location', 'edit', 'delete'])

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

/// Slowmode: when the NEXT message may go, per group. Module-level because the
/// Chat route remounts on every navigation — a countdown that survives only in
/// component state would reset by leaving the chat and coming right back.
const _slowUntil = new Map<number, number>()

/// How far along the delivery ladder each outgoing state sits. Receipts and
/// send-completions both write through this so a row only ever climbs:
/// sending -> sent -> delivered -> read. 'failed' shares the floor with
/// 'sending' — neither has been vouched for by anyone.
const DELIVERY_RANK: Record<OutgoingRow['state'], number> = {
  sending: 0,
  failed: 0,
  sent: 1,
  delivered: 2,
  read: 3,
}

export function Chat() {
  const { identity } = useIdentity()
  const { t, lang } = useI18n()
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
  // Owner-only group we cannot post in (founder item 24). The composer stays on
  // screen and goes DISABLED rather than being swapped for a notice: the notice
  // used to replace it, and unmounting the bar froze `--rcq-composer-h` at its
  // last value, so the thread kept paying for a composer that was not there.
  // A greyed-out field with the reason in its placeholder also says the same
  // thing in the place the user is already looking.
  const readOnlyHere =
    isGroup && group?.post_policy === 'owner_only' && identity != null && group.owner_uin !== identity.uin
  /// This thread's disappearing-message timer, in seconds, or null when it is
  /// off (founder item 20). Per thread and per DEVICE: it decides what the rows
  /// this browser composes ask their recipients to do, and it never travels to
  /// the peer as a setting of its own. Same model as iOS `ChatSettingsStore`.
  const ttlKey =
    isGroup && groupId != null
      ? ttlThreadKey(true, groupId)
      : peerUIN != null
        ? ttlThreadKey(false, peerUIN)
        : null
  const threadTtlSec = useThreadTtl(ttlKey)
  /// A group nobody new may join. A SEPARATE fact from `readOnlyHere`: on the
  /// island `is_closed` is purely a join gate (groups.py) and says nothing about
  /// who may post, so the two must never be folded together. It matters here for
  /// one thing only: the empty-state invitation to say hello, which in a closed
  /// room with no history is an invitation to nobody.
  const closedHere = isGroup && !!group?.is_closed
  const [myInfo, setMyInfo] = useState<UserInfo | null>(null)
  const [input, setInput] = useState('')
  const [showPicker, setShowPicker] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [uploadingFile, setUploadingFile] = useState(false)
  // The attach button opens a small menu (Photo / File) — the web couldn't
  // send documents before (#16). Each picks a different hidden <input>.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  /// A picture waiting for its caption (#798): pasting or picking one no
  /// longer fires the send — it parks here, a strip above the composer shows
  /// it, whatever gets typed becomes the caption, and the send button ships
  /// both as ONE message. ✕ or Escape lets go.
  const [pendingPhoto, setPendingPhoto] = useState<{ file: File; url: string } | null>(null)
  function stagePhoto(file: File) {
    setPendingPhoto((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return { file, url: URL.createObjectURL(file) }
    })
  }
  function unstagePhoto() {
    setPendingPhoto((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
  }

  /// Voice capture (megalist B2). null = idle; otherwise the live recorder.
  /// AAC-in-MP4 where the platform can (both phones' native format), Opus/WebM
  /// otherwise; button hidden when MediaRecorder can do neither.
  const [rec, setRec] = useState<{ recorder: MediaRecorder; stream: MediaStream; startedAt: number } | null>(null)
  const [recElapsed, setRecElapsed] = useState(0)
  useEffect(() => {
    if (!rec) return
    const id = setInterval(() => setRecElapsed(Math.floor((Date.now() - rec.startedAt) / 1000)), 250)
    return () => clearInterval(id)
  }, [rec])
  // One of my groups, to hand over as an invite link. Existed on Android long
  // before the desktop had it (#578). The poll composer used to sit beside it
  // and is gone (founder item 14a).
  const [shareGroupOpen, setShareGroupOpen] = useState(false)
  /// Which face the attach menu is showing: its own list, or the
  /// disappearing-message timers. One panel with two views rather than a second
  /// floating menu, so the outside-click and Escape handling that already knows
  /// about `[data-attach-menu]` covers both without a second set of rules.
  const [attachView, setAttachView] = useState<'main' | 'ttl'>('main')
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
  /// The composer bar, measured so the thread can scroll under it. See the
  /// comment on the bar itself.
  const composerRef = useRef<HTMLDivElement>(null)
  /// The title/search/pin stack, measured for the same reason.
  const topBarsRef = useRef<HTMLDivElement>(null)
  /// What those two measured last time. The publishing effect writes four CSS
  /// custom properties and may re-pin the scroll, which is a full layout: it
  /// is worth a comparison to skip when neither bar has actually moved.
  const lastBarHRef = useRef(-1)
  const lastTopHRef = useRef(-1)
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
  /// Does that menu hang above its bubble rather than below, and how tall may
  /// it be before it scrolls inside itself? See toggleActions.
  const [actionsUp, setActionsUp] = useState(false)
  const [actionsMax, setActionsMax] = useState(260)
  const [reactionForRowId, setReactionForRowId] = useState<string | null>(null)
  /// The URL the click that opened the actions menu landed on, if any —
  /// prepends "open link / copy link" rows. A message link never navigates
  /// by itself; the menu is the only way through (founder, 21.08).
  const [actionsLink, setActionsLink] = useState<string | null>(null)
  /// Row whose file the menu's download action is decrypting right now —
  /// keeps the chip's spinner honest while the work happens up here.
  const [downloadingRowId, setDownloadingRowId] = useState<string | null>(null)
  /// Long-press gesture state for pressMenu — see the comment there.
  const pressRef = useRef({ timer: null as number | null, sx: 0, sy: 0, firedAt: 0 })
  /// The incoming message being reported to the island's operators, or null.
  const [reportingMsg, setReportingMsg] = useState<{ from: number; excerpt: string } | null>(null)
  /// Slowmode countdown: when the next send is allowed, and the ticking
  /// seconds left (0 = free to send). Seeded from the module map so the
  /// countdown survives leaving and reopening the chat.
  const [slowUntil, setSlowUntil] = useState<number>(() =>
    isGroup && groupId != null ? _slowUntil.get(groupId) ?? 0 : 0,
  )
  const [slowLeft, setSlowLeft] = useState(0)
  /// What is being forwarded: just the text and who wrote it. It used to be an
  /// OutgoingRow, which quietly limited forwarding to your own messages.
  const [forwardingRow, setForwardingRow] = useState<{ text: string; author: string } | null>(null)
  /// Message id whose reaction authors are on screen, or null.
  const [reactionAuthorsFor, setReactionAuthorsFor] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<ReplyContext | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  // Search inside this conversation. Android has had it; the web had no way to
  // find anything you had said, in a thread that can run for months.
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
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

  // How many unread messages this thread had at the moment it was opened —
  // the only thing anywhere that knows where reading stopped (#462). Nothing
  // on the server does: `queue_cursor` is a per-device delivery ack, not a
  // read position, so this has to be answered locally, the same way Android
  // answers it.
  //
  // Read during RENDER, on purpose. The effect below marks the thread active,
  // which clears the counter — by the time any effect runs the answer is gone.
  // Guarded on the thread key so the second render StrictMode does, and every
  // re-render after it, keeps the first answer instead of re-reading a counter
  // we have since zeroed.
  const unreadOnOpenRef = useRef<{ key: string; n: number } | null>(null)
  if (persistKey && unreadOnOpenRef.current?.key !== persistKey) {
    unreadOnOpenRef.current = {
      key: persistKey,
      n:
        isGroup && groupId != null
          ? groupUnreadCount(groupId)
          : peerUIN != null
            ? peerUnreadCount(peerUIN)
            : 0,
    }
  }
  /// The message the unread run starts at, and the thread that answer belongs
  /// to. Decided once per thread and never recomputed as new messages arrive:
  /// deriving it from the current length makes the marker slide down the
  /// thread while it is being read, a regression Android has already paid for
  /// and documented. `id: null` is a decision too — it means "open at the
  /// newest, there is no divider".
  const [unreadAnchor, setUnreadAnchor] = useState<{ key: string; id: string | null } | null>(null)
  const unreadAnchorId = unreadAnchor?.key === persistKey ? unreadAnchor.id : null
  const anchorDecidedRef = useRef<string | null>(null)
  const unreadDividerRef = useRef<HTMLLIElement>(null)
  const didUnreadScrollRef = useRef<string | null>(null)
  /// What the list is currently being held against: the newest message, the
  /// unread divider, or nothing (the user has taken over).
  const pinTargetRef = useRef<'bottom' | 'unread' | null>('bottom')

  // Re-render this view whenever ANY reaction changes (received or our own
  // optimistic toggle); the per-row chips read the store directly.
  // Captured, not just called: the "who reacted" sheet memoises off it.
  const reactionsVersion = useReactionsVersion()
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
    setAttachView('main')
    // The unread machinery too. This component is not keyed by route, so a
    // chat-to-chat jump reuses the instance — and the anchor effect below
    // bails before claiming the key when the new thread has no rows yet, which
    // would leave the PREVIOUS thread's decision in place and paint its
    // divider again on the way back.
    setUnreadAnchor(null)
    anchorDecidedRef.current = null
    didUnreadScrollRef.current = null
    posRestoredRef.current = null
    // Slowmode belongs to the thread, and the useState seeding above only
    // ran at mount — a group-to-group jump inside the same instance was
    // still counting down the PREVIOUS room's cooldown.
    setSlowUntil(isGroup && groupId != null ? _slowUntil.get(groupId) ?? 0 : 0)
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
          //
          // ⚠ The keys are OUR OWN, and they have to be real. They were two
          // empty strings for as long as a note never left the browser; the
          // moment notes started shipping over the wire (#469) the first note
          // sent from the desktop died on "recipient identityKey is not 32
          // bytes", because that is what an empty string decodes to.
          //
          // The key comes from the island rather than from this browser's own
          // copy, on purpose: what matters is that the OTHER devices of the
          // account can open the note, and the island's copy is the one every
          // sender in the network seals to. The local public key is the
          // fallback for an island that will not answer — better a note this
          // device can still read than a send that fails.
          let selfKeys = { identity_key: bytesToB64(identity.identityPub), signing_key: bytesToB64(identity.signingPub) }
          try {
            const me = await Api.userInfo(identity, peerUIN)
            if (me.identity_key) {
              selfKeys = { identity_key: me.identity_key, signing_key: me.signing_key || selfKeys.signing_key }
            }
          } catch {
            // island unreachable — keep the local copy
          }
          setPeer({
            uin: peerUIN,
            nickname: t('chat.saved.title'),
            status: 'online',
            blocked: false,
            ...selfKeys,
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
            // §5e: the name and the picture here are whatever the peer last
            // DEPOSITED, not the one-shot snapshot from their key card. The
            // blob sits on our island (they PUT it there), so the header draws
            // it exactly like a same-island one.
            avatar_media_id: ci.avatarMediaId ?? null,
            avatar_media_key: ci.avatarMediaKey ?? null,
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
  // Where reading LEFT OFF in each thread, as a distance from the bottom —
  // founder batch 21.08, item 13a: leaving a chat and coming back must land
  // in the same place, the way every messenger does it. Distance-from-bottom
  // rather than a scrollTop: the number stays meaningful when older history
  // hydrates above. The UNREAD divider always wins over this (new messages
  // move the landing point to where reading actually stopped); the saved spot
  // only answers the quiet case where nothing new arrived.
  const savedPosKey = (k: string) => scopedKey(`chat.pos.${k}`)
  const posRestoredRef = useRef<string | null>(null)
  const posSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The same fact as `atBottomRef`, but in state so the view can react to it:
  // a ref cannot render the "jump to newest" button, which is why there never
  // was one. Kept as a pair rather than replacing the ref — the scroll effect
  // reads it synchronously inside requestAnimationFrame.
  const [atBottom, setAtBottom] = useState(true)
  // New messages that arrived while the user was reading further up, so the
  // button can say how many are waiting instead of just pointing down.
  const [unseenBelow, setUnseenBelow] = useState(0)
  // The ids behind that number, oldest first. The badge counts DOWN as these
  // rows scroll into view (the way the phones and every other messenger do),
  // so each one has to be crossed off individually, not zeroed wholesale.
  const unseenIdsRef = useRef<string[]>([])

  // Escape backs out of whatever is open, innermost first, and a click
  // anywhere else closes the floating bits. Neither existed: the only key this
  // screen handled was Enter, and the action menu / reaction picker / emoji
  // panel could only be dismissed by hitting the very same button again.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (searchOpen) { setSearchOpen(false); setQuery(''); return }
      if (pendingPhoto) return unstagePhoto()
      if (attachMenuOpen && attachView === 'ttl') return setAttachView('main')
      if (attachMenuOpen) return setAttachMenuOpen(false)
      if (showPicker) return setShowPicker(false)
      if (reactionForRowId) return setReactionForRowId(null)
      if (actionsForRowId) return setActionsForRowId(null)
      if (editingRow) return cancelEdit()
      if (replyTo) return setReplyTo(null)
    }
    function onDown(e: MouseEvent) {
      const el = e.target as HTMLElement | null
      // The attach menu and the button that opens it are not "outside" (#602:
      // clicking an empty part of the window left the menu standing while the
      // button's own highlight went away, so the two disagreed about whether
      // anything was open). It used to carry its own `fixed inset-0` backdrop,
      // which cannot work where it sits: `.rcq-floating-bar` has a
      // `backdrop-filter`, and a filtered element is the containing block for
      // its fixed descendants — so that "full screen" backdrop only ever
      // covered the composer bar. This handler already watches the whole
      // document for the sibling menus; the attach menu just rides along.
      if (!el?.closest('[data-attach-menu]')) {
        setAttachMenuOpen(false)
        setAttachView('main')
      }
      // Let the bubble's own handler decide — it toggles its menu, and closing
      // here first would make the click a no-op.
      if (el?.closest('[data-chat-menu]')) return
      setActionsForRowId(null)
      setReactionForRowId(null)
      // The emoticon panel and the button that opens it are not "outside".
      // This handler runs on mousedown, i.e. BEFORE the click it belongs to, so
      // without this the panel closed under the pointer that was reaching for
      // it and the click landed on nothing (founder, 2026-08-13).
      if (el?.closest('[data-emoji-panel]')) return
      setShowPicker(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [searchOpen, attachMenuOpen, attachView, showPicker, reactionForRowId, actionsForRowId, editingRow, replyTo])

  // Publish the composer's height so the thread can reserve exactly that much
  // room. A ResizeObserver rather than a constant: the bar is a different
  // height with a reply strip open, with the emoji panel up, and on every line
  // the input wraps to.
  //
  // ⚠⚠ This used to carry NO dependency array at all, so it tore down and
  // rebuilt the observer after every single render and, worse, ran a
  // read(offsetHeight) → write(4 custom properties) → read(scrollHeight) →
  // write(scrollTop) cycle each time. Every keystroke and every delivery
  // receipt paid for a full layout of the thread, which is what made sending
  // a reply feel like a freeze (founder item 30b). The observer is the part
  // that has to be live, and it already is: it fires whenever either bar
  // actually changes height, which is the only thing this effect reacts to.
  // Both elements are unconditional in the tree, so there is nothing to
  // re-subscribe to except a change of thread.
  useEffect(() => {
    const bar = composerRef.current
    const top = topBarsRef.current
    if (!bar || !top) return
    // Forget the cached measurements on (re)subscribe: the variables may be
    // carrying another thread's numbers, and the first apply() below must
    // write whatever it measures rather than compare against a stale cache.
    lastBarHRef.current = -1
    lastTopHRef.current = -1
    const apply = () => {
      const barH = bar.offsetHeight
      const topH = top.offsetHeight
      // Nothing moved: no writes, no relayout. The ResizeObserver fires an
      // initial callback on observe() and again on every subpixel reflow of
      // either bar, and rewriting the same four values from there is what
      // kicked the list's OWN observer (see below) into a scroll → onScroll →
      // setState → render loop.
      if (barH === lastBarHRef.current && topH === lastTopHRef.current) return
      const grew = barH > lastBarHRef.current
      lastBarHRef.current = barH
      lastTopHRef.current = topH
      const root = bar.parentElement
      root?.style.setProperty('--rcq-composer-h', `${barH}px`)
      root?.style.setProperty('--rcq-topbars-h', `${topH}px`)
      // ...and on the document root, because the emoji panel is PORTALLED to
      // body (the composer bar's backdrop-filter makes it the containing block
      // for anything fixed inside it) and still has to sit exactly on top of
      // this bar. A variable set on the composer's parent is invisible from
      // there; one on the root is visible everywhere.
      document.documentElement.style.setProperty('--rcq-composer-h', `${barH}px`)
      // A bar that GROWS (a wrapped line, the reply strip, the emoji panel)
      // adds padding under the last message without moving the scroll — so
      // the message the reader was looking at slides under the bar. If they
      // were at the newest, keep them there. ⚠ Only on growth: a bar that
      // shrank (the reply strip closing, the emoji panel going away) gives
      // room back rather than taking it, and re-pinning there is exactly the
      // scroll the list's own observer already performs.
      if (grew && atBottomRef.current) {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      }
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(bar)
    ro.observe(top)
    return () => ro.disconnect()
  }, [persistKey])

  /** Pin the list to the bottom and mark it as followed. Called when the user
   *  does something that means "I want to be at the newest": sending, or
   *  tapping the jump button. */
  /** Nothing is waiting below any more — empty the id list WITH the number,
   *  or the next arrival resurrects a count the user has already read past. */
  function clearUnseenBelow() {
    unseenIdsRef.current = []
    setUnseenBelow(0)
  }

  function stickToBottom() {
    atBottomRef.current = true
    pinTargetRef.current = 'bottom'
    setAtBottom(true)
    clearUnseenBelow()
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
  /** Put the unread divider at the top of the pane. Measured rather than read
   *  off `offsetTop`, because the divider's offsetParent is not this element;
   *  and driven through `scrollRef` rather than `scrollIntoView`, which was
   *  tried for the open scroll before and landed short (see the note on
   *  `scrollRef` above). */
  function scrollToUnreadDivider(initial = false) {
    const el = scrollRef.current
    const div = unreadDividerRef.current
    if (!el || !div) return
    el.scrollTop += div.getBoundingClientRect().top - el.getBoundingClientRect().top
    // The correction below may only run on the INITIAL jump. Re-derived on
    // every ResizeObserver re-pin it fired transiently while the photos under
    // the divider were still skeletons: "we're at the bottom" for one layout
    // pass, clearUnseenBelow(), pin gone — and the count on the jump button
    // with it (B8 flicker, second mechanism).
    if (!initial) return

    // Where we ACTUALLY ended up, which is not always where we aimed: a thread
    // barely longer than the pane cannot scroll the divider to the top, and
    // then the list is still showing the newest message. Saying otherwise
    // would leave it marked "the user is reading further up" for good — it
    // would stop following new arrivals and offer a jump button that jumps
    // nowhere. Re-derived on every re-pin rather than once, because the
    // decrypting photos above the divider keep changing the answer.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      pinTargetRef.current = 'bottom'
      atBottomRef.current = true
      setAtBottom(true)
      clearUnseenBelow()
    }
  }

  /** Reaching the bottom naturally puts the divider behind you: the unread
   *  pin has served. The BOTTOM pin is different — it IS "we're at the
   *  bottom, keep following growth" and must survive this. */
  function releaseUnreadPin() {
    if (pinTargetRef.current === 'unread') pinTargetRef.current = null
  }

  /** The user took the wheel. Whatever we were holding the view against —
   *  the divider or the bottom — their hand wins now, or the next image that
   *  finishes decrypting drags them back (B8). */
  function releasePinByUser() {
    if (pinTargetRef.current === 'unread' || pinTargetRef.current === 'bottom') {
      pinTargetRef.current = null
    }
  }

  // Where reading stopped. Decided once per thread, and only once the store
  // has rows to count back over: hydration is awaited behind the socket, so on
  // a cold open `incoming` is briefly empty and there is nothing to point at.
  useEffect(() => {
    if (!persistKey) return
    if (anchorDecidedRef.current === persistKey) return
    if (incoming.length === 0) return
    anchorDecidedRef.current = persistKey

    // The claimed-at-render count, upgraded by whatever hydration parked: on
    // a cold open straight onto a chat URL the render-time read runs before
    // hydration and claims 0, while the REAL count arrives with the store —
    // the divider then never showed at all (B8, cold-open half).
    const parked = takePendingUnreadFor(persistKey)
    let n = unreadOnOpenRef.current?.key === persistKey ? unreadOnOpenRef.current.n : 0
    if (parked != null && parked > n) {
      n = parked
      unreadOnOpenRef.current = { key: persistKey, n }
    }
    // n larger than the history we still hold means the counter outran it — a
    // restored backup, a pruned log, a fresh install replaying a month of
    // queue. We genuinely do not know where reading stopped there, so the
    // newest message is the answer; guessing the very top would be this report
    // again in the other direction. n EQUAL to the length is different and
    // common (a group opened for the first time): everything held is unread,
    // and the divider belongs above all of it.
    if (n < 1 || n > incoming.length) {
      setUnreadAnchor({ key: persistKey, id: null })
      return
    }

    let seen = 0
    let anchor: string | null = null
    const run: string[] = []
    for (let i = incoming.length - 1; i >= 0; i--) {
      // Count back over other people's messages only. Rows persisted before
      // addGroupIncoming grew its self-echo guard can still hold carbons of
      // our own, and counting one puts the divider inside the unread run
      // rather than above it.
      if (identity && incoming[i].from === identity.uin) continue
      run.push(incoming[i].id)
      seen += 1
      if (seen === n) {
        anchor = incoming[i].id
        break
      }
    }
    // The rows behind the divider, oldest first — what the jump-button badge
    // will cross off one by one as they scroll into view.
    unseenIdsRef.current = anchor ? run.reverse() : []
    setUnreadAnchor({ key: persistKey, id: anchor })
  }, [persistKey, incoming, identity])

  // ...and go there, once, as soon as the divider is in the DOM.
  useEffect(() => {
    if (!persistKey || unreadAnchor?.key !== persistKey) return
    if (didUnreadScrollRef.current === persistKey) return
    const el = scrollRef.current
    if (!el) return
    didUnreadScrollRef.current = persistKey

    if (!unreadAnchor.id) {
      // A null anchor decided AFTER hydration landed used to shove the view
      // to the bottom over a position the resume path had just restored —
      // and the programmatic scroll's own onScroll then DELETED the saved
      // spot 250ms later (dist < 80 clears the key). If a resume happened
      // for this thread, the reader is where they chose to be; leave them
      // there (B8: «не запоминается, где остановился»).
      if (posRestoredRef.current === persistKey) return
      pinTargetRef.current = 'bottom'
      atBottomRef.current = true
      setAtBottom(true)
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
      return
    }
    pinTargetRef.current = 'unread'
    atBottomRef.current = false
    setAtBottom(false)
    // The jump button carries the backlog rather than starting at zero, so the
    // way back to the newest message is one click from the moment the thread
    // opens. Sized by the id list the anchor effect just built, so the badge
    // and the rows it can cross off never disagree.
    setUnseenBelow(unseenIdsRef.current.length)
    // May correct all of the above on the spot, if the thread turns out to be
    // too short to scroll.
    scrollToUnreadDivider(true)
  }, [persistKey, unreadAnchor])

  const lastCountRef = useRef(0)
  const lastIncomingLenRef = useRef(0)
  useEffect(() => {
    const switched = lastThreadRef.current !== persistKey
    lastThreadRef.current = persistKey
    const total = outgoing.length + incoming.length
    const prevTotal = lastCountRef.current
    const grew = switched ? 0 : Math.max(0, total - prevTotal)
    lastCountRef.current = total
    const prevIncomingLen = switched ? incoming.length : lastIncomingLenRef.current
    lastIncomingLenRef.current = incoming.length
    // Opening a thread that has unread messages is the one case where the
    // newest message is NOT where the user wants to land, so the bottom jump
    // is left to the effect above, which knows whether a divider exists.
    const openingOnUnread = switched && (unreadOnOpenRef.current?.n ?? 0) > 0
    // The quiet re-entry (item 13a): no unread, but a saved reading spot.
    // Attempted on the switch itself, or on the hydration tick right after it
    // (a cold open briefly has no rows — there is nothing to scroll yet).
    // Once per thread visit; scrolling past the guard just overwrites the
    // saved spot with a fresher one.
    let resumeFromBottom: number | null = null
    if (
      persistKey &&
      posRestoredRef.current !== persistKey &&
      total > 0 &&
      (unreadOnOpenRef.current?.key !== persistKey || (unreadOnOpenRef.current?.n ?? 0) < 1) &&
      (switched || prevTotal === 0)
    ) {
      try {
        const v = Number(localStorage.getItem(savedPosKey(persistKey)))
        if (Number.isFinite(v) && v > 80) resumeFromBottom = v
      } catch {
        /* storage gone — open at the bottom as always */
      }
    }
    if (resumeFromBottom != null) posRestoredRef.current = persistKey
    if (switched) {
      if (openingOnUnread) {
        pinTargetRef.current = null
        // The previous thread's unseen ids must not leak into this one — the
        // anchor effect rebuilds the list once this thread's rows are in.
        // ⚠ The NUMBER goes with the ids. Emptying the list alone left the
        // badge painting the previous conversation's count until the anchor
        // effect got around to reseeding it, so opening a read chat straight
        // after an unread one flashed a figure that belonged to neither.
        //
        // ⚠⚠ ...but NOT when the anchor effect has already claimed this thread,
        // which is every in-app open: the store is hydrated by then, so that
        // effect runs on the first commit, in this same passive-effect pass and
        // BEFORE this one. A blanket clear here threw away the backlog it had
        // just built, the go-there effect then seeded the badge from an empty
        // array, and the arrow came up bare with nothing for `onScroll` to
        // cross off (founder item 30a, the other half of it). Only a reload
        // straight onto a chat URL escaped, because there the first commit has
        // no rows yet.
        if (anchorDecidedRef.current === persistKey) setUnseenBelow(unseenIdsRef.current.length)
        else clearUnseenBelow()
      } else if (resumeFromBottom != null) {
        pinTargetRef.current = null
        atBottomRef.current = false
        setAtBottom(false)
        clearUnseenBelow()
      } else {
        pinTargetRef.current = 'bottom'
        setAtBottom(true)
        clearUnseenBelow()
      }
    } else if (resumeFromBottom != null) {
      pinTargetRef.current = null
      atBottomRef.current = false
      setAtBottom(false)
    } else if (grew && !atBottomRef.current) {
      // Arrived while the user is reading further up: count it for the jump
      // button instead of yanking the list, which is what the early return
      // below has always (correctly) done. By id and others-only — counting
      // the combined length growth let a carbon of my own send inflate the
      // badge with something that was never waiting to be read.
      const fresh = incoming
        .slice(prevIncomingLen)
        .filter((m) => !(identity && m.from === identity.uin) && !unseenIdsRef.current.includes(m.id))
        .map((m) => m.id)
      if (fresh.length) {
        unseenIdsRef.current = [...unseenIdsRef.current, ...fresh]
        setUnseenBelow(unseenIdsRef.current.length)
      }
    }
    const el = scrollRef.current
    if (!el) return
    // Defer past layout so late content (queued history, decrypted images) is
    // measured before we pin to the bottom — otherwise the jump lands short
    // and the last bubbles hide under the composer.
    requestAnimationFrame(() => {
      if (resumeFromBottom != null) {
        el.scrollTo({ top: Math.max(0, el.scrollHeight - el.clientHeight - resumeFromBottom), behavior: 'auto' })
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight
        // A thread shorter than the pane cannot resume anywhere but the
        // bottom — report where we actually are, not where we aimed.
        atBottomRef.current = dist < 80
        setAtBottom(dist < 80)
        return
      }
      if (switched) {
        if (openingOnUnread) return
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
        atBottomRef.current = true
        return
      }
      if (!atBottomRef.current) return
      // ⚠ Always instant. The smooth variant animated across several frames,
      // onScroll read a mid-flight distance > 80, dropped atBottom, and the
      // jump-button count flashed in and out on every arrival — the founder's
      // «оно то есть, то его нет» (B8). iOS scrolls instantly here too.
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
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
    const ro = new ResizeObserver((entries) => {
      // Which box moved decides what to do about it. CONTENT growing can drag
      // the unread marker out of view (a photo above it swelling from its
      // skeleton), so that case holds the divider in place until the user
      // scrolls. The PANE shrinking cannot move the divider at all — it is the
      // composer taking room from below — and re-pinning to the divider there
      // would yank the list back the moment you started typing a reply.
      const paneOnly = entries.every((e) => e.target === el)
      if (!paneOnly && pinTargetRef.current === 'unread') {
        scrollToUnreadDivider()
        return
      }
      if (atBottomRef.current) el.scrollTo({ top: el.scrollHeight })
    })
    ro.observe(content)
    // And the PANE itself, not just what is in it. The list is `flex-1` between
    // the header and the composer, so anything that makes the composer taller —
    // a draft wrapping to a second line, a reply strip, the font-size knob —
    // takes that height away from the list from BELOW. The content never
    // changed, so a content-only observer stayed silent while the newest
    // message slid under the composer: "своё сообщение появляется под полем
    // ввода". Android re-pins on every keyboard-inset frame for exactly this.
    ro.observe(el)
    return () => ro.disconnect()
  }, [persistKey])

  // Disappearing messages, the on-screen half (founder item 20).
  //
  // The store's own sweeper handles every thread that is NOT open, plus the
  // copies on disk. The open thread is different: `Chat` OWNS its outgoing rows
  // in component state, and the persist effect above would write an unfiltered
  // copy of them straight back over anything the store swept. So the rows this
  // component holds are filtered here, on the same interval, and the received
  // half is nudged in the same tick so the two sides of a conversation are never
  // seen to expire seconds apart.
  //
  // ⚠ `setOutgoing` returns the SAME array when nothing lapsed. A new array
  // every ten seconds would re-run the persist effect, the scroll effect and
  // every memoised bubble on the thread, for no change at all.
  useEffect(() => {
    if (!persistKey) return
    const tick = () => {
      sweepExpiredIncoming()
      setOutgoing((rows) => {
        const now = Date.now()
        const kept = rows.filter((r) => !lapsed(r.expiresAt, now))
        return kept.length === rows.length ? rows : kept
      })
    }
    tick()
    const iv = setInterval(tick, SWEEP_INTERVAL_MS)
    return () => clearInterval(iv)
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
  // The receipt sink rides along: the open thread owns its rows in state, so
  // a delivered/read receipt has to land here (the store's own localStorage
  // write would be overwritten by the persist effect above) (#637).
  useEffect(() => {
    if (!persistKey) return
    setOutgoingSink(persistKey, (row) =>
      setOutgoing((rows) => (rows.some((r) => r.id === row.id) ? rows : [...rows, row])),
    )
    setReceiptSink((ids, state) => {
      const idSet = new Set(ids)
      // Rank, not a hand-written pair of cases. A receipt can arrive while the
      // row still says 'sending': the peer got the copy over their live socket
      // and answered before our own POST resolved. Comparing ranks lets that
      // one land (and attemptSendRow's later 'sent' is itself rank-guarded, so
      // it cannot walk the row back down).
      setOutgoing((rows) =>
        rows.map((r) => (idSet.has(r.id) && DELIVERY_RANK[state] > DELIVERY_RANK[r.state] ? { ...r, state } : r)),
      )
    })
    // Edit carbons land here for the same reason receipts do: this thread's
    // rows live in state while it is open.
    setEditSink((targetID, text) =>
      setOutgoing((rows) => rows.map((r) => (r.id === targetID ? { ...r, text, edited: true } : r))),
    )
    return () => {
      setOutgoingSink(null, null)
      setReceiptSink(null)
      setEditSink(null)
    }
  }, [persistKey])

  // The sending half of read receipts (#636): the peer's messages in a 1:1
  // thread count as read while it is open on a visible tab. Local island
  // only in v1 (the receipt path is same-island API + sessions), and never
  // for Saved Messages. Re-runs on new arrivals and on the tab coming back.
  useEffect(() => {
    if (!identity || isGroup || isSelf || peerUIN == null) return
    // ⚠ Local island only in v1 (the receipt path is same-island API +
    // sessions) — and the cross-island test has to hold BEFORE the contacts
    // fetch answers. `peer` is null on a cold load, so gating on peer?.host
    // alone treated a foreign thread as local for that window and shipped
    // receipts to whoever holds that bare number on OUR island — a real
    // account, since numbers collide across islands. `islandHost` comes off
    // the route synchronously; `peer` is required too, so nothing is
    // announced until we actually know who this thread belongs to.
    if (islandHost || !peer || peer.host) return
    const announce = () => {
      if (document.visibilityState !== 'visible') return
      noteThreadViewed(identity, peerUIN, peerIncoming)
    }
    announce()
    document.addEventListener('visibilitychange', announce)
    return () => document.removeEventListener('visibilitychange', announce)
  }, [identity, isGroup, isSelf, peerUIN, peer, islandHost, peerIncoming])

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
    // Let the optimistic paint land before the sealing starts. An async
    // function runs synchronously up to its first real await, and in a large
    // group the per-member fan-out is hundreds of envelopes sealed on the
    // main thread — a reaction tapped in RCQ Beta sat invisible until the
    // whole batch finished ("реакция ставится лагающе"). One macrotask of
    // yield gives React + the compositor the frame; the seal then runs at
    // the same speed it always did.
    await new Promise((r) => setTimeout(r, 0))
    // ⚠ Saved Messages ("Заметки") used to stop here, never touching the wire:
    // the note lived in this browser's localStorage and nowhere else. That is
    // why a note written on the desktop never appeared on the phone, while the
    // other direction worked — Android has always sent notes through the sealed
    // path to itself (report #469). A note is now shipped like any other
    // message, to our own number, so every device on the account receives it.
    // The echo that comes straight back is dropped by `noteOwnEnvelope`, which
    // is what keeps this device from showing the note twice.
    // Reactions in Saved Messages stay local (see below), so only the kinds
    // that carry an id of their own are registered.
    if (isSelf && 'id' in envelope) noteOwnEnvelope(envelope.id)
    // The server ships this as the ws packet `type` to the recipient (so a web
    // receiver routes a control envelope live) and gates owner_only posts +
    // pushes on it. Reaction/edit/delete carry their own type; content is
    // "message".
    //
    // ⚠ A NOTE goes out as "carbon", not "message" (#599). A note is addressed
    // to our own number — that is what makes it appear on our other devices at
    // all — and the island cannot tell it from a stranger's letter, because
    // sealed sender means it never sees who sent what. So it pushed it, and the
    // phone rang for something its owner had typed a second earlier on this
    // very screen.
    //
    // No new wire type for it: "carbon" is already outside _PUSHABLE_TYPES on
    // the island and already routed live by every client, which is exactly what
    // a note needs. A brand-new label would have been invisible to the clients
    // in the field until they updated. iOS already had this right — its notes
    // go through sendMessageCarbon.
    const etype =
      envelope.kind === 'reaction'
        ? 'reaction'
        : envelope.kind === 'edit'
          ? 'edit'
          : envelope.kind === 'delete'
            ? 'delete'
            : isSelf
              ? 'carbon'
              : 'message'
    try {
      if (isGroup && group && gctx) {
        // A roster with just US in it is not an error to post to: everyone
        // else left (or never joined), and Android in the same group happily
        // "sends" — empty fan-out, state SENT, carbon to the other devices
        // (Session.fanOutGroup). The web threw "no one else in this group"
        // instead, so the very message the phone accepted showed as failed
        // here. No one to seal to means the wire part is simply empty — the
        // carbon below is the whole delivery.
        // ⚠ Gate on OUR OWN row being present: an empty members list is an
        // UNLOADED roster (see forwardTo), and skipping the wire on one would
        // fake-send into a group that does have people.
        const me = gctx.ident.uin
        const isSolo = (g: { members: Array<{ uin: number }> }) =>
          g.members.some((m) => m.uin === me) && !g.members.some((m) => m.uin !== me)
        // ⚠⚠ And CONFIRM it against the island before acting on it. This
        // roster is read once when the chat opens and then cached for the
        // whole tab: a member who joins by invite link while the chat sits
        // open is invisible here. Believing a stale "solo" would skip the
        // wire and mark the message sent — the silent loss this allowance
        // must not become. One extra request, only ever in the solo case.
        // If the island cannot be reached we do NOT take the shortcut: the
        // ordinary path then fails loudly, which is the honest answer when
        // we could not check.
        let roster = group
        let soloGroup = false
        if (isSolo(group)) {
          const fresh = await Api.groupInfo(gctx.ident, gctx.gid).catch(() => null)
          if (fresh) {
            roster = { ...group, members: fresh.members }
            soloGroup = isSolo(fresh)
          }
        }
        // Sender-keys dual-send (only for a LOCAL group — cross-island groups
        // keep the legacy per-member path in v1; their capability lookup +
        // broadcast endpoint live on the foreign island we have no token for).
        const anyCapable = !roster.host && roster.members.some((m) => m.sender_keys && m.uin !== gctx.ident.uin)
        if (soloGroup) {
          /* No other member to seal to: nothing goes on the group wire, and
             the row in this thread's log is the whole of it. */
        } else if (anyCapable) {
          await withGroupSendLock(gctx.gid, async () => {
          const ds = await buildGroupDualSend(envelope, gctx.ident, gctx.gid, roster.members)
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
          })
        } else {
          // Foreign group, or a group where nobody is capable yet: original
          // per-member fan-out unchanged.
          const { payloads, skipped } = await encryptGroupEnvelope(envelope, gctx.ident, roster.members)
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
          const reached = await sendV2(identity, peer.uin, envelope, etype).catch((e) => {
            // Everything else means v=2 did not happen at all, and the v=1
            // envelope below is the way through. A fan-out that reached only
            // SOME of the peer's devices is not that: the v=1 copy would reach
            // the device that already has this message and still not the one
            // that missed it. It is a failed send, and the retry fans out again.
            if (e instanceof PartialFanOutError) throw new Error(t('chat.error.send_failed'))
            return 0
          })
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
      // Mirror this message to the user's other devices. Best-effort, and that
      // includes the solo-group case.
      //
      // ⚠ It was briefly awaited there, on the idea that in a group of one the
      // carbon IS the delivery. It is not: a group with no other members has
      // no recipient at all, so nothing is in flight to lose. The carbon is
      // the same courtesy copy it is everywhere else — and awaiting it read as
      // a guarantee it cannot give, since it swallows its own errors, skips
      // the kinds outside CARBON_KINDS (video) and skips foreign groups
      // entirely. The row in this thread's log is the artifact, exactly as on
      // the phone, where a solo group posts an empty fan-out and files the
      // message locally.
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
    // ⚠ A ballot from before polls were cut (founder item 14a). Nothing
    // composes one any more, but a row whose send never finished is still in
    // the log as 'failed', and the chain below has no poll branch left: it
    // would fall through to the final `else` and ship the QUESTION to the room
    // as an ordinary text message under the poll's own id, with no options and
    // no ballot, while the sender's own bubble kept drawing the "no longer
    // supported" placeholder and flipped to ✓ sent. A retired feature answers
    // instead of vanishing: the row stays where it is and says it cannot go.
    if (row.kind === 'poll') {
      setOutgoing((rows) =>
        rows.map((r) => (r.id === row.id ? { ...r, state: 'failed', error: t('chat.media.retired') } : r)),
      )
      toast(t('chat.media.retired'), 'error')
      return
    }
    // The disappearing instruction this row is carrying, in the shape the wire
    // wants it: seconds of life plus the moment they start counting. Derived
    // back out of the row's own deadline rather than read from the thread's
    // timer, so a RETRY of a message sent ten minutes ago tells the recipient
    // what is actually left of it instead of restarting the clock, and so a
    // row written before the timer was changed keeps the terms it was sent on.
    const dying = ((): { ttl?: number; ts?: number } => {
      if (row.expiresAt == null) return {}
      const secs = Math.max(1, Math.round((row.expiresAt - row.sentAt) / 1000))
      return { ttl: secs, ts: Math.floor(row.sentAt / 1000) }
    })()
    if (row.kind === 'photo' && row.mediaId && row.mediaKey) {
      env = {
        kind: 'photo',
        id: row.id,
        mediaID: row.mediaId,
        mediaKey: row.mediaKey,
        ...(row.text ? { caption: row.text } : {}),
        ...dying,
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
        ...dying,
        ...(row.replyTo ? { reply: row.replyTo } : {}),
        ...(row.fwdName ? { fwdName: row.fwdName } : {}),
      }
    } else if (row.kind === 'voice' && row.mediaId && row.mediaKey) {
      env = {
        kind: 'voice',
        id: row.id,
        mediaID: row.mediaId,
        mediaKey: row.mediaKey,
        durationSec: row.durationSec ?? 0,
        ...dying,
      }
    } else if (row.kind === 'other' && row.mediaKind === 'location' && row.lat != null && row.lng != null) {
      env = {
        kind: 'location',
        id: row.id,
        lat: row.lat,
        lng: row.lng,
        ...(row.text ? { caption: row.text } : {}),
        ...dying,
        ...(row.replyTo ? { reply: row.replyTo } : {}),
      }
    } else {
      env = {
        kind: 'text',
        id: row.id,
        text: row.text,
        ...dying,
        ...(row.replyTo ? { reply: row.replyTo } : {}),
        ...(row.fwdName ? { fwdName: row.fwdName } : {}),
      }
    }
    const res = await shipEnvelopeToCurrentThread(env)
    if (res.ok) {
      setOutgoing((rows) =>
        // 'sent' only if the row has not already climbed past it: a receipt
        // can beat our own POST's response home (see the receipt sink).
        rows.map((r) =>
          r.id === row.id && DELIVERY_RANK[r.state] < DELIVERY_RANK.sent
            ? { ...r, state: 'sent', error: undefined }
            : r.id === row.id
              ? { ...r, error: undefined }
              : r,
        ),
      )
      if (isSentSoundEnabled()) playSound('message_sent')
    } else {
      // A slowmode 429 from the island arrives as raw JSON — translate it to
      // the countdown the composer speaks, and re-arm the local timer from
      // the server's own clock (retry_after), so the button agrees with the
      // island about when the next try can work.
      let errText = res.error
      if (errText && slowmodeSec > 0 && /"code"\s*:\s*"rate_limited"/.test(errText)) {
        const m = /"retry_after"\s*:\s*(\d+)/.exec(errText)
        const wait = m ? Number(m[1]) : slowmodeSec
        errText = t('chat.slowmode.wait', { s: String(wait) })
        if (groupId != null && wait > 0) {
          const until = Date.now() + wait * 1000
          _slowUntil.set(groupId, until)
          setSlowUntil(until)
        }
      }
      // ⚠ Rank-guarded like the success branch. Under fan-out a peer device can
      // receipt the copy it got while the POST to their SECOND device is still
      // failing: the row is already 'delivered' (or 'read'), and stamping
      // 'failed' over it would throw away a receipt the peer never repeats,
      // show a red cross on a message they have read, and invite a retry that
      // sends them a duplicate. A row that has been vouched for keeps its
      // state; the error text still lands so the failure is not silent.
      setOutgoing((rows) =>
        rows.map((r) =>
          r.id !== row.id
            ? r
            : DELIVERY_RANK[r.state] > DELIVERY_RANK.sent
              ? { ...r, error: errText }
              : { ...r, state: 'failed', error: errText },
        ),
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

  /// The delete offered on an INCOMING row.
  ///
  /// In a conversation it hides the message here and nowhere else: there is no
  /// deleting somebody else's message off their device, and it is labelled
  /// "hide" for exactly that reason.
  ///
  /// In Saved Messages there is no somebody else. A row on the incoming side of
  /// the notes thread is a note THIS ACCOUNT wrote on another device — it is
  /// only "incoming" because that is the side of the wire it came in on — so
  /// hiding it locally left it standing on the phone that typed it, and neither
  /// a reload here nor a restart there could reconcile the two (report #601).
  /// Same gesture, and now it retracts the note everywhere: the `delete` goes
  /// to our own number, which is where every device of the account is listening.
  async function deleteIncoming(id: string) {
    setActionsForRowId(null)
    // `fromSelf` so the tombstone is written even if the row has already been
    // dropped from the incoming log — a note whose id lives in the OUTGOING log
    // on some other device still has to stay buried here across reloads.
    markDeleted(id, isSelf ? { fromSelf: true } : undefined)
    if (!isSelf) return
    const env: DeleteEnvelope = { kind: 'delete', targetID: id }
    const res = await shipEnvelopeToCurrentThread(env)
    if (!res.ok) toast(t('chat.error.send_failed'), 'error')
  }

  /// The deadline a row composed right now should carry, given this thread's
  /// timer. Empty when disappearing is off, so it spreads into a row literal
  /// without leaving an `expiresAt: undefined` key behind for JSON to persist.
  function dyingNow(sentAt: number): { expiresAt?: number } {
    const at = ownExpiry(threadTtlSec, sentAt)
    return at != null ? { expiresAt: at } : {}
  }

  async function send() {
    if (pendingPhoto) {
      const staged = pendingPhoto
      unstagePhoto()
      await sendPhoto(staged.file)
      return
    }
    if (!identity) return
    if (editingRow) {
      await saveEdit()
      return
    }
    // Broadcast group, and I am not the owner. The composer is disabled rather
    // than replaced now (item 24), so the guard has to live on the send paths
    // too: a draft typed before the owner flipped the policy, a dropped file,
    // and Enter on a stale render all reach here without going past a button.
    // The island refuses these deposits anyway; this is so the refusal is a
    // sentence rather than a red error from the wire.
    if (readOnlyHere) {
      toast(t('chat.owner_only.notice'), 'error')
      return
    }
    const trimmed = input.trim()
    if (!trimmed) return
    // Room rules (group content policy). The guard sits here, not in the
    // envelope path — an edit or a retry of an old row must never be eaten.
    if (isGroup && !linksAllowed && /https?:\/\//i.test(trimmed)) {
      toast(t('chat.links_off.notice'), 'error')
      return
    }
    if (slowmodeBlocked()) return
    armSlowmode()

    const msgId = newUUIDv4()
    const sentAt = Date.now()
    const row: OutgoingRow = {
      id: msgId,
      text: trimmed,
      sentAt,
      state: 'sending',
      ...(replyTo ? { replyTo } : {}),
      ...dyingNow(sentAt),
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
    if (readOnlyHere) {
      toast(t('chat.owner_only.notice'), 'error')
      return
    }
    // A photo is media like any other: the files-off room refused documents,
    // voice and drag-drop but let plain photos through - the one hole in the
    // policy, found when Android grew the same gates (29.08). Guarded here,
    // at the single choke point every photo path funnels into.
    if (isGroup && !filesAllowed) {
      toast(t('chat.files_off.chip'), 'error')
      return
    }
    if (slowmodeBlocked()) return
    setUploadingPhoto(true)
    try {
      const up = await uploadEncryptedImage(identity.apiBase, file, isGroup ? gctx?.host ?? undefined : peer?.host)
      if (!up) {
        toast(t('chat.error.upload_failed'), 'error')
        return
      }
      // Armed only once the upload made it — a failed upload must not lock
      // the composer over a message that never existed.
      armSlowmode()
      // Whatever is already typed becomes the caption, the way every web
      // messenger does it. The envelope has carried `caption` from the start
      // and both bubbles render it; there was simply no way to fill it in, so
      // people sent a picture and then a separate line about it.
      const caption = input.trim()
      const sentAt = Date.now()
      const row: OutgoingRow = {
        id: newUUIDv4(),
        text: caption,
        sentAt,
        state: 'sending',
        kind: 'photo',
        mediaId: up.mediaId,
        mediaKey: up.keyB64,
        ...(replyTo ? { replyTo } : {}),
        ...dyingNow(sentAt),
      }
      setOutgoing((rows) => [...rows, row])
      if (caption) setInput('')
      setReplyTo(null)
      // Sending is "put me at the bottom" whatever was sent. Only the text
      // path used to say so, so a photo, a file or a location sent while the
      // list was a few pixels off the bottom landed below the fold, under the
      // composer. Android has had one rule for all of them from the start.
      stickToBottom()
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
    if (readOnlyHere) {
      toast(t('chat.owner_only.notice'), 'error')
      return
    }
    if (!navigator.geolocation) {
      toast(t(isTauri() ? 'chat.error.no_geolocation.desktop' : 'chat.error.no_geolocation'), 'error')
      return
    }
    if (slowmodeBlocked()) return
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
    armSlowmode()
    const caption = input.trim()
    const sentAt = Date.now()
    const row: OutgoingRow = {
      id: newUUIDv4(),
      text: caption,
      sentAt,
      state: 'sending',
      kind: 'other',
      mediaKind: 'location',
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      ...(replyTo ? { replyTo } : {}),
      ...dyingNow(sentAt),
    }
    setOutgoing((rows) => [...rows, row])
    if (caption) setInput('')
    setReplyTo(null)
    stickToBottom()
    await attemptSendRow(row)
  }

  /// Send a group invite link into the open conversation. It goes as plain
  /// text, exactly as Android sends it (ChatScreen.kt:1706): every client
  /// already recognises the link and paints a join card over it, so this needs
  /// no envelope of its own and reaches old versions intact.
  async function sendGroupInvite(link: string) {
    if (!identity) return
    if (readOnlyHere) {
      toast(t('chat.owner_only.notice'), 'error')
      return
    }
    // An invite IS a link — a room with links off means all of them.
    if (isGroup && !linksAllowed) {
      toast(t('chat.links_off.notice'), 'error')
      return
    }
    if (slowmodeBlocked()) return
    armSlowmode()
    const sentAt = Date.now()
    const row: OutgoingRow = {
      id: newUUIDv4(),
      text: link,
      sentAt,
      state: 'sending',
      ...(replyTo ? { replyTo } : {}),
      ...dyingNow(sentAt),
    }
    setOutgoing((rows) => [...rows, row])
    setReplyTo(null)
    stickToBottom()
    await attemptSendRow(row)
  }

  /// Pick → encrypt → upload → send a document of any type (#16). Raw bytes
  /// (no canvas re-encode), sent as a `file` envelope; rendered as a download
  /// chip on both sides. Same upload-before-row pattern as sendPhoto.
  function voiceMimeSupported(): string | null {
    if (typeof MediaRecorder === 'undefined') return null
    for (const m of ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
      try { if (MediaRecorder.isTypeSupported(m)) return m } catch { /* jsdom etc. */ }
    }
    return null
  }

  async function startVoice() {
    if (rec || uploadingFile || readOnlyHere) return
    if (isGroup && !filesAllowed) {
      toast(t('chat.files_off.notice'), 'error')
      return
    }
    if (slowmodeBlocked()) return
    const mime = voiceMimeSupported()
    if (!mime) {
      toast(t('voice.unsupported'), 'error')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64_000 })
      recorder.start()
      setRec({ recorder, stream, startedAt: Date.now() })
      setRecElapsed(0)
    } catch (e) {
      // Denied is not unsupported: the wrong word sends people hunting for a
      // browser update when the fix is one permission prompt away.
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      toast(t(denied ? 'voice.denied' : 'voice.unsupported'), 'error')
    }
  }

  function stopVoiceTracks(r: { recorder: MediaRecorder; stream: MediaStream }) {
    for (const tr of r.stream.getTracks()) tr.stop()
  }

  function cancelVoice() {
    const r = rec
    if (!r) return
    setRec(null)
    try { r.recorder.stop() } catch { /* already stopped */ }
    stopVoiceTracks(r)
  }

  async function finishVoice() {
    const r = rec
    if (!r || !identity) return
    setRec(null)
    const durationSec = Math.max(1, Math.round((Date.now() - r.startedAt) / 1000))
    const chunks: BlobPart[] = []
    const done = new Promise<Blob>((resolve) => {
      r.recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
      r.recorder.onstop = () => resolve(new Blob(chunks, { type: r.recorder.mimeType }))
    })
    try { r.recorder.stop() } catch { /* already stopped */ }
    stopVoiceTracks(r)
    const blob = await done
    if (blob.size === 0) return
    setUploadingFile(true)
    try {
      const bytes = await blob.arrayBuffer()
      const up = await uploadEncryptedAudio(identity.apiBase, bytes, isGroup ? gctx?.host ?? undefined : peer?.host)
      if (!up) {
        toast(t('chat.error.file_upload_failed'), 'error')
        return
      }
      armSlowmode()
      const sentAt = Date.now()
      const row: OutgoingRow = {
        id: newUUIDv4(),
        text: '',
        sentAt,
        state: 'sending',
        kind: 'voice',
        mediaId: up.mediaId,
        mediaKey: up.keyB64,
        durationSec,
        ...dyingNow(sentAt),
      }
      setOutgoing((rows) => [...rows, row])
      stickToBottom()
      await attemptSendRow(row)
    } finally {
      setUploadingFile(false)
    }
  }

  async function sendFile(file: File) {
    if (!identity || uploadingFile) return
    if (readOnlyHere) {
      toast(t('chat.owner_only.notice'), 'error')
      return
    }
    // Files switched off by the group's owner — covers the attach menu, the
    // drop-to-send overlay and any future path in one place.
    if (isGroup && !filesAllowed) {
      toast(t('chat.files_off.notice'), 'error')
      return
    }
    if (slowmodeBlocked()) return
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
      // See sendPhoto: armed only once the upload made it.
      armSlowmode()
      const sentAt = Date.now()
      const row: OutgoingRow = {
        id: newUUIDv4(),
        text: '',
        sentAt,
        state: 'sending',
        kind: 'file',
        mediaId: up.mediaId,
        mediaKey: up.keyB64,
        fileName: file.name || 'file',
        fileMime: file.type || 'application/octet-stream',
        fileSize: up.size,
        ...(replyTo ? { replyTo } : {}),
        ...dyingNow(sentAt),
      }
      setOutgoing((rows) => [...rows, row])
      setReplyTo(null)
      stickToBottom()
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
    // Frequency for the quick bar's order (founder item 21). Only a reaction
    // being SET counts: clearing one is not a vote for it, and counting the
    // clear would push an asset up the bar every time somebody changed their
    // mind about it. Local, per account, and it never leaves the device.
    if (next != null) noteReactionUsed(next)
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
    // Media rows carry no text — quote the file name (or the generic
    // attachment label) so the reply strip is never blank. A row of mine that
    // is on its way out is quoted by label only, for the reason spelled out
    // beside `replyQuote` on the received side.
    startReplyTo(
      row.id,
      row.expiresAt != null
        ? t('chat.ttl.quoted')
        : row.text || row.fileName || t('chat.pin.attachment'),
      myNickname,
    )
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
    // §5d: hand the peer's island over with the number. Without it the call
    // machine signals down OUR island's socket, which resolves a bare `to_uin`
    // as one of ITS OWN accounts — which is how calling `1234@is2.rcq.app` used
    // to ring a local #1234 who had never heard of us. `peer.host` is set from
    // the cross-island store for a `?i=<host>` thread and absent otherwise.
    call.start(peer.uin, peer.nickname ?? `#${peer.uin}`, media, peer.host ?? islandHost)
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
    // The user has asked to be somewhere specific, so stop holding the view
    // against the unread divider: this moves the list without a wheel or a
    // touch, and the next image to finish decrypting would drag them back.
    releaseUnreadPin()
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightId(id)
    window.setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 1400)
  }

  /// Arriving from the home screen's global search: land on the message the
  /// hit named. Delayed until the list has painted; a row older than the
  /// loaded window gets jumpToMessage's honest "not loaded" toast. Deduped by
  /// value, not by a one-shot flag, so a second search into this same mounted
  /// screen still jumps.
  const location = useLocation()
  const handledJump = useRef<string | null>(null)
  useEffect(() => {
    const jump = (location.state as { jump?: string } | null)?.jump
    if (!jump || handledJump.current === jump) return
    handledJump.current = jump
    const timer = window.setTimeout(() => jumpToMessage(jump), 450)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  /// Copy a message's text to the clipboard (action-menu "copy").
  function copyText(text: string) {
    void navigator.clipboard?.writeText(text).catch(() => {})
    setActionsForRowId(null)
    toast(t('chat.copied'))
  }

  /// Owner / info-moderator may pin a chat message into the group's single
  /// pin slot. The slot is shared with the settings editor — pinning here
  /// replaces whatever was there, and saving from settings replaces this.
  /// My uin IN THIS GROUP'S NAMESPACE — the guest uin for a cross-island
  /// group (its roster and owner_uin live on the foreign island), my own
  /// otherwise. Every role check below keys on this; comparing the foreign
  /// roster against the home uin made moderators of nobody.
  const myGroupUin = isGroup ? gctx?.ident.uin ?? identity?.uin : identity?.uin

  const canPin =
    isGroup &&
    group != null &&
    myGroupUin != null &&
    (group.owner_uin === myGroupUin ||
      (group.members.find((m) => m.uin === myGroupUin)?.permissions?.includes('info') ?? false))

  /// Owner / admin may retract SOMEBODY ELSE'S message for the whole group
  /// (founder batch 21.08, item 3). Same wire as the author's own retract —
  /// each receiver checks this sender against its own roster before honoring
  /// it, so the button grants nothing the group did not already grant.
  /// The `delete` cap is the whole point of granting it (SPEC 6.6), and this
  /// check used to ignore it and test `role === "admin"` instead, which no
  /// island ever writes. So on web the owner alone could retract, and handing
  /// somebody the delete right did nothing. Android had it right all along
  /// (Group.kt:32). Same shape as `roomExempt` below.
  const canModerate =
    isGroup &&
    group != null &&
    myGroupUin != null &&
    (group.owner_uin === myGroupUin ||
      (() => {
        const me = group.members.find((m) => m.uin === myGroupUin)
        return me?.role === 'admin' || (me?.permissions?.includes('delete') ?? false)
      })())

  /// Exempt from the room's content rules (links/files off, slowmode): the
  /// owner, an admin, or a member holding any granted cap — the same set the
  /// server exempts on group-sealed, so the composer never promises a send
  /// the island then 429s.
  const roomExempt =
    !isGroup ||
    (group != null &&
      myGroupUin != null &&
      (group.owner_uin === myGroupUin ||
        (() => {
          const me = group.members.find((m) => m.uin === myGroupUin)
          return me?.role === 'admin' || (me?.permissions?.length ?? 0) > 0
        })()))
  /// Owner-set room rules. Absent fields (older island) mean allowed;
  /// moderators keep both abilities so they can inspect what they moderate.
  const linksAllowed = !isGroup || group?.links_allowed !== false || roomExempt
  const filesAllowed = !isGroup || group?.files_allowed !== false || roomExempt
  /// Effective slowmode step for ME in this room (0 = none).
  const slowmodeSec = isGroup && !roomExempt ? group?.slowmode_sec ?? 0 : 0
  const slowActive = slowmodeSec > 0 && slowLeft > 0

  /// True (and toasts why) when slowmode still holds the composer shut.
  function slowmodeBlocked(): boolean {
    if (slowmodeSec <= 0) return false
    const left = Math.ceil((slowUntil - Date.now()) / 1000)
    if (left <= 0) return false
    toast(t('chat.slowmode.wait', { s: String(left) }), 'error')
    return true
  }

  /// Start the cooldown after a message leaves. Armed at initiation, not on
  /// the receipt — the point is pacing the person, not their network.
  function armSlowmode() {
    if (slowmodeSec <= 0 || groupId == null) return
    const until = Date.now() + slowmodeSec * 1000
    _slowUntil.set(groupId, until)
    setSlowUntil(until)
  }

  /// The moderator's delete of a message that is not ours. Tombstoned locally
  /// with moderator power (the row sits in the INCOMING log under its author's
  /// name), then the same `delete` envelope the author's retract ships.
  async function deleteAsModerator(id: string) {
    setActionsForRowId(null)
    markDeleted(id, { fromSelf: true })
    const env: DeleteEnvelope = { kind: 'delete', targetID: id }
    const res = await shipEnvelopeToCurrentThread(env)
    if (!res.ok) toast(t('chat.error.send_failed'), 'error')
  }

  /// Pin a message's text (the pin slot is plaintext, so media without a
  /// caption falls back to a label). Updates the local group so the pinned
  /// bar reflects it immediately.
  function pinMessage(text: string) {
    if (!gctx || !canPin || !group) return
    // ⚠ The slot is 4096 chars on the island (GroupPatchIn.pinned_text, raised
    // from 500 on 2026-08-29, megalist A6). Pinning a longer message used to
    // 422 BEFORE the row was written, and the optimistic swap below then
    // showed the new pin until the next refresh quietly restored the old one:
    // a pin that looked like it worked and did nothing. Clamp here, and roll
    // the swap back on any refusal instead of swallowing it.
    const trimmed = text.trim() || t('chat.pin.attachment')
    const pinned = trimmed.length > 4096 ? trimmed.slice(0, 4095) + '…' : trimmed
    const previous = group
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
      .catch(() => {
        setGroup(previous)
        toast(t('chat.pin.failed'), 'error')
      })
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
    // ⚠ The TARGET thread's timer, not this one's. A forward is composed here
    // but lands over there, and it was the only send path that carried no `ttl`
    // at all: forwarding one line into a room set to five minutes left a
    // permanent message in it, on every participant's device, in a conversation
    // whose header says everything disappears. Same shape `dyingNow` gives the
    // other paths, read off the destination.
    const sentAt = Date.now()
    const targetTtl = threadTtl(ttlThreadKey(target.kind === 'group', target.kind === 'group' ? target.id : target.uin))
    const expiresAt = ownExpiry(targetTtl, sentAt)
    const dying: { ttl?: number; ts?: number } =
      targetTtl != null && expiresAt != null ? { ttl: targetTtl, ts: Math.floor(sentAt / 1000) } : {}
    const env: TextEnvelope = { kind: 'text', id: newId, text: row.text, fwdName, ...dying }
    try {
      if (target.kind === 'group') {
        // target.id may be a foreign-group alias — resolve the island ctx.
        const fctx = groupApiCtx(identity, target.id)
        // ⚠ The picker's list is fetched without rosters, so this group can
        // carry an empty member list. Sealing against that produces no
        // payloads at all, and the forward would report an empty group — or
        // worse, on a partial roster, quietly reach only some of it.
        const full = await ensureRoster(fctx.ident, target.group)
        // A solo group (only us in the fresh roster) takes the forward with an
        // empty wire, same as shipEnvelopeToCurrentThread — the row lands in
        // the target thread below and nobody else exists to reach.
        const soloTarget =
          full.members.some((m) => m.uin === fctx.ident.uin) && !full.members.some((m) => m.uin !== fctx.ident.uin)
        if (!soloTarget) {
          const { payloads, skipped } = await encryptGroupEnvelope(env, fctx.ident, full.members)
          if (payloads.length === 0) {
            throw new Error(
              skipped.length > 0
                ? t('chat.error.group_no_valid_members')
                : t('chat.error.group_empty'),
            )
          }
          await Api.sendGroupSealed(fctx.ident, fctx.gid, payloads)
        }
      } else {
        const wireB64 = encryptV1(env, identity, peerBundleFrom(target.contact))
        await Api.sendSealed(identity, target.uin, wireB64)
      }
      const newRow: OutgoingRow = {
        id: newId,
        text: row.text,
        sentAt,
        state: 'sent',
        fwdName,
        ...(expiresAt != null ? { expiresAt } : {}),
      }
      const targetKey =
        target.kind === 'group'
          ? storageKey(true, target.id)
          : storageKey(false, target.uin)
      appendToThreadLog(targetKey, newRow)
      if (isSentSoundEnabled()) playSound('message_sent')
      setForwardingRow(null)
      setActionsForRowId(null)
      toast(`${t('chat.forward.sent')}: ${target.name}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : t('chat.error.send_failed'), 'error')
    }
  }

  /// Open (or close) the menu for a bubble. `anchor` is the bubble itself: a
  /// column of seven actions is ~15rem tall, and one hanging off the LAST
  /// message would run into the composer and get clipped by the thread's own
  /// overflow — the menu simply ended halfway. So it flips above the bubble
  /// when there is not room below.
  function toggleActions(rowId: string, anchor?: HTMLElement | null, ev?: { target: EventTarget | null }) {
    if (anchor) {
      const { up, max } = placeMenu(anchor, MENU_ROOM_PX)
      setActionsUp(up)
      setActionsMax(max)
    }
    // A click that landed on a link span (data-msg-link, EmoticonText) opens
    // the same menu with "open link / copy link" on top — links never
    // navigate by themselves.
    const link = ev
      ? ((ev.target as HTMLElement | null)?.closest?.('[data-msg-link]')?.getAttribute('data-msg-link') ?? null)
      : null
    setActionsLink(link)
    setActionsForRowId((prev) => (prev === rowId ? null : rowId))
    setReactionForRowId(null)
  }

  /// "Open link" from the message menu — the one place a message link
  /// actually navigates. Desktop hands it to the system browser (the wry
  /// webview opens nothing itself); the web build opens a new tab.
  function openLinkFromMenu(url: string) {
    setActionsForRowId(null)
    if (!/^https?:\/\//i.test(url)) return
    void openExternal(url).then((took) => {
      if (!took) window.open(url, '_blank', 'noopener,noreferrer')
    })
  }

  /// "Download" from a file row's menu. The decrypt+save runs up here so the
  /// menu can close at once; `downloadingRowId` keeps the chip's spinner on.
  async function downloadRowFile(rowId: string, mediaId: string, mediaKey: string, name?: string, mime?: string) {
    setActionsForRowId(null)
    if (!identity || downloadingRowId != null) return
    setDownloadingRowId(rowId)
    const ok = await downloadEncryptedFile(groupMediaBase ?? identity.apiBase, mediaId, mediaKey, name || 'file', mime)
    setDownloadingRowId(null)
    if (!ok) toast(t('chat.media.unavailable'), 'error')
  }

  /// "Report" on somebody's message: collect what the modal needs. The
  /// excerpt rides in the report body — media messages describe the blob
  /// instead, since operators cannot decrypt it.
  function startReport(m: { from: number; text: string; kind?: string; fileName?: string; mediaId?: string }) {
    setActionsForRowId(null)
    const text = m.text?.trim()
    // Both halves capped: the file NAME is sender-controlled, and an
    // uncapped one pushed the whole reason past the server's 1000-char
    // limit — a 422 that made exactly the nastiest message unreportable.
    const excerpt = (
      text
        ? text
        : `${m.kind ?? 'media'}${m.fileName ? ` "${m.fileName.slice(0, 120)}"` : ''}${m.mediaId ? ` media:${m.mediaId}` : ''}`
    ).slice(0, 300)
    setReportingMsg({ from: m.from, excerpt })
  }

  /// Ship the abuse report. Cross-island groups report to the GROUP's island
  /// (its operators moderate its rooms), with the guest identity we already
  /// hold there.
  async function sendMessageReport(text: string) {
    const target = reportingMsg
    if (!identity || !target) return
    const ident = isGroup ? gctx?.ident ?? identity : identity
    const where = isGroup && gctx ? `group ${gctx.gid}` : '1:1'
    const reason = `${text.trim()}\n\n[${where}] message from #${target.from}: ${target.excerpt}`
    try {
      await Api.reportAbuse(ident, target.from, reason)
      setReportingMsg(null)
      toast(t('chat.report.sent'))
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : t('chat.report.error'), 'error')
    }
  }

  const { aliasFor: peerAliasFor } = useContactAliases()
  // ⚠ With the host: a cross-island alias lives under `uin@host` (see
  // aliasKey), and a bare-uin lookup here made every name set for a foreign
  // peer vanish from the chat while the contacts list showed it fine.
  const peerAlias = peerUIN ? peerAliasFor(peerUIN, peer?.host ?? islandHost) : undefined

  // ── @-mentions ──────────────────────────────────────────────────────
  // Everyone who can be named in this thread. Only a group has a roster: in a
  // 1:1 there is nobody to name as a third party, and `@`-typing there would
  // pop a picker of one person you are already talking to. `#<uin>` still
  // resolves in both, which is the form a pin or a link carries.
  const mentionRoster = useMemo<MentionRoster[]>(
    () =>
      isGroup && group
        ? group.members.map((m) => ({ uin: m.uin, nickname: m.nickname || '' }))
        : [],
    [isGroup, group],
  )
  /// Everything `nickOf` needs, refreshed on every render and read only when
  /// somebody actually calls it. `useContactAliases` hands back a NEW
  /// `aliasFor` every render, and with it in the dependency list below the
  /// mention context was a new object every render too — which fed a new prop
  /// into every bubble on the thread and made the memoised rows below
  /// pointless. The context is stable now; `aliasSig` is what carries the news
  /// that a name changed.
  const mentionLiveRef = useRef({ aliasFor: peerAliasFor, group, isGroup, navigate })
  mentionLiveRef.current = { aliasFor: peerAliasFor, group, isGroup, navigate }
  const mentionCtx = useMemo<MentionContext | undefined>(() => {
    if (!identity) return undefined
    return {
      roster: mentionRoster,
      // A `#<uin>` becomes a name only for someone actually here: my alias for
      // them first, then their group nick, then a contact. Anyone else stays
      // literal digits, so a pin cannot point the group at a stranger.
      nickOf: (uin: number) => {
        const live = mentionLiveRef.current
        return (
          live.aliasFor(uin) ||
          (live.isGroup ? live.group?.members.find((m) => m.uin === uin)?.nickname : null) ||
          contactAlias(uin) ||
          null
        )
      },
      onOpen: (uin: number) => mentionLiveRef.current.navigate(`/profile/${uin}`),
      meUin: identity.uin,
    }
  }, [identity, mentionRoster])
  /// The same thing for my own bubbles, which are tinted with the accent and
  /// therefore cannot show an accent-coloured name.
  const mentionCtxSelf = useMemo<MentionContext | undefined>(
    () => (mentionCtx ? { ...mentionCtx, tone: 'self' } : undefined),
    [mentionCtx],
  )

  /// Every `#<uin>` the bodies in this thread actually name.
  ///
  /// `nickOf` resolves those through the WHOLE alias map, not just this room's
  /// roster, so a mentioned NON-member (a contact of mine nobody here knows) is
  /// drawn by my alias for them and was invisible to the signature below.
  /// Renaming one left every memoised bubble printing the old name until the
  /// thread was remounted. Recomputed only when the message arrays change, the
  /// same cost `mentionIds` already pays a few lines down.
  const mentionedUins = useMemo<number[]>(() => {
    const found = new Set<number>()
    const re = /#(\d{3,})/g
    const scan = (s: string) => {
      let m: RegExpExecArray | null
      while ((m = re.exec(s)) !== null) found.add(Number(m[1]))
    }
    for (const r of incoming) if (r.text) scan(r.text)
    for (const r of outgoing) if (r.text) scan(r.text)
    return [...found]
  }, [incoming, outgoing])

  /// A signature of MY OWN names for the people this thread can name. The
  /// mention context above is deliberately stable, so it cannot tell a
  /// memoised bubble that an alias changed underneath it; this scalar can,
  /// because it is one of every row's props. Cheap: one lookup per member of
  /// the open group, one per uin the thread mentions, and in a 1:1 with no
  /// mentions in it nothing at all.
  const aliasSig = [
    peerAlias ?? '',
    mentionRoster.map((m) => peerAliasFor(m.uin) ?? '').join(','),
    mentionedUins.map((u) => peerAliasFor(u) ?? '').join(','),
  ].join('|')

  /// The open group's roster keyed by uin. The row loop below wants the
  /// sender's nickname and avatar for every message, and a linear find per row
  /// made that O(rows × members) on every render of a large group.
  const memberByUin = useMemo(() => {
    const byUin = new Map<number, RCQGroup['members'][number]>()
    if (isGroup && group) for (const m of group.members) byUin.set(m.uin, m)
    return byUin
  }, [isGroup, group])

  /// Does this body call me? Used for the bubble tint and for the jump list.
  const bodyMentionsMe = useCallback(
    (text: string) => (identity ? mentionsMe(text, identity.uin, myInfo?.nickname) : false),
    [identity, myInfo],
  )

  /// Inbound group messages that name me and are NEWER than the cut-off this
  /// group already showed me. Group-only, same gate the phones use. Own
  /// messages never count — writing your own name is not being called.
  const mentionIds = useMemo<string[]>(() => {
    if (!isGroup || groupId == null || !identity) return []
    const since = mentionSeenAt(groupId)
    return incoming
      .filter((m) => m.from !== identity.uin && m.at > since && bodyMentionsMe(m.text))
      .map((m) => m.id)
  }, [isGroup, groupId, identity, incoming, bodyMentionsMe])
  const [mentionCursor, setMentionCursor] = useState(0)
  useEffect(() => {
    setMentionCursor(0)
  }, [persistKey])
  // No wrap: stepping past the last one dismisses the button rather than
  // restarting the count, which is what makes it a queue and not a toy.
  const mentionsLeft = Math.max(0, mentionIds.length - mentionCursor)

  /// The `@partial` being typed at the tail of the draft, or null. Tail-anchored
  /// like Android's: an '@' further back is already a finished mention (or an
  /// email address), and re-opening a picker over it would fight the caret.
  const mentionQuery = useMemo<{ start: number; partial: string } | null>(() => {
    if (!isGroup) return null
    let i = input.length
    while (i > 0) {
      const ch = input[i - 1]
      if (ch === '@') {
        const partial = input.slice(i)
        return partial.length > 0 ? { start: i - 1, partial } : null
      }
      if (/\s/.test(ch)) return null
      i--
    }
    return null
  }, [isGroup, input])
  const mentionCandidates = useMemo<MentionRoster[]>(() => {
    if (!mentionQuery || !identity) return []
    const p = mentionQuery.partial.toLowerCase()
    return mentionRoster
      .filter((m) => m.uin !== identity.uin && m.nickname && m.nickname.toLowerCase().includes(p))
      .slice(0, 8)
  }, [mentionQuery, mentionRoster, identity])

  /// Complete the half-typed name.
  ///
  /// ⚠ The caret has to be put back by hand. The composer is a contenteditable
  /// that repaints itself from the new value, which destroys the selection, so
  /// without this the caret sits at the START of the field and the rest of the
  /// sentence is typed in front of the name that was just completed — which is
  /// exactly what happened the first time this was tried with rAF: the repaint
  /// is a child effect and it does not reliably run before the frame callback.
  /// A parent effect does, because child effects flush first.
  const caretToEndRef = useRef(false)
  function pickMention(nick: string) {
    if (!mentionQuery) return
    caretToEndRef.current = true
    setInput(input.slice(0, mentionQuery.start) + '@' + nick + ' ')
  }
  useEffect(() => {
    if (!caretToEndRef.current) return
    caretToEndRef.current = false
    const el = taRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    const r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(false)
    sel?.removeAllRanges()
    sel?.addRange(r)
  }, [input])

  // Leaving the thread marks what it showed as seen, so coming back does not
  // offer to walk you through the same mentions again. The newest timestamp
  // rather than "now": a message that lands while the thread is closing has
  // not been looked at.
  //
  // ⚠ The order of the two effects below is load-bearing. React runs the
  // cleanup of a keyed effect BEFORE the setups of that render, so the writer
  // must be declared FIRST — then at cleanup time the ref still holds the
  // thread being left, not the one being opened. Written in an effect rather
  // than during render for the same reason: a render-time write would already
  // be the new thread's value by the time the cleanup reads it.
  const mentionSweepRef = useRef<{ groupId: number; newest: number } | null>(null)
  useEffect(() => {
    mentionSweepRef.current =
      isGroup && groupId != null && identity
        ? {
            groupId,
            newest: incoming
              .filter((m) => m.from !== identity.uin && bodyMentionsMe(m.text))
              .reduce((acc, m) => Math.max(acc, m.at), 0),
          }
        : null
  })
  useEffect(() => {
    return () => {
      const s = mentionSweepRef.current
      if (!s) return
      if (s.newest > 0) markMentionSeen(s.groupId, s.newest)
      clearMention(s.groupId)
    }
  }, [persistKey])

  /// Turn the reaction store's (uin -> asset) map into rows the sheet can draw.
  /// Names come from wherever this thread knows them: the group roster in a
  /// group, the peer in a 1:1, and my own profile for my own reaction. My alias
  /// for someone wins over their nick, same rule as everywhere else.
  const reactionAuthors: ReactionAuthor[] = useMemo(() => {
    if (!reactionAuthorsFor || !identity) return []
    const map = reactionsForTarget(reactionAuthorsFor)
    if (!map) return []
    return [...map.entries()].map(([uin, asset]) => {
      const member = isGroup ? group?.members.find((m) => m.uin === uin) : undefined
      const mine = uin === identity.uin
      const name =
        peerAliasFor(uin, uin === peerUIN ? peer?.host ?? islandHost : undefined) ??
        (mine ? myNickname : undefined) ??
        member?.nickname ??
        (uin === peerUIN ? peer?.nickname : undefined) ??
        `#${uin}`
      // Where tapping this person goes (founder item 22). The rows used to be
      // inert: a name and a number that looked exactly like every other
      // clickable name in the app and did nothing.
      //
      // A cross-island card carries its island, because our own
      // `/users/{uin}/info` knows nothing about them and would 404. Same rule
      // `headerLink` follows a few lines down.
      //
      // ⚠ The privacy gate (`canOpenProfileCard`) is asked here rather than in
      // the sheet: this is where we know who the viewer is, whose thread it is,
      // and which of these people are held as contacts. It FAILS OPEN, and it
      // has to: the enforcement that counts is the island refusing to serve the
      // card, and until that exists a link that quietly stopped working would
      // read as a broken screen rather than as a setting.
      const host = uin === peerUIN ? peer?.host ?? islandHost : null
      const openable = canOpenProfileCard(
        { uin, profile_openable: uin === peerUIN ? peer?.profile_openable : undefined },
        { myUin: identity.uin, isContact: uin === peerUIN },
      )
      const profileTo = !openable
        ? null
        : mine
          ? '/profile'
          : host
            ? `/profile/${uin}?i=${encodeURIComponent(host)}`
            : `/profile/${uin}`
      return {
        uin,
        asset,
        name,
        status: (member?.status ?? (uin === peerUIN ? peer?.status : undefined) ?? 'offline') as ReactionAuthor['status'],
        avatarMediaId: member?.avatar_media_id ?? (uin === peerUIN ? peer?.avatar_media_id : undefined),
        avatarMediaKey: member?.avatar_media_key ?? (uin === peerUIN ? peer?.avatar_media_key : undefined),
        crossIsland: uin === peerUIN ? !!peer?.host : false,
        profileTo,
      }
    })
    // `reactionsVersion` is what makes this recompute when a reaction lands.
  }, [reactionAuthorsFor, identity, isGroup, group, peer, peerUIN, islandHost, myNickname, peerAliasFor, reactionsVersion])
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

  // Slowmode countdown tick. Runs only while a cooldown is armed; the
  // interval is momentary and cheap (a number in state 4x a second).
  useEffect(() => {
    const left = () => Math.max(0, Math.ceil((slowUntil - Date.now()) / 1000))
    setSlowLeft(left())
    if (slowUntil <= Date.now()) return
    const iv = setInterval(() => {
      const l = left()
      setSlowLeft(l)
      if (l <= 0) clearInterval(iv)
    }, 250)
    return () => clearInterval(iv)
  }, [slowUntil])

  // Live group-settings/roster refresh: the island broadcasts a patch as
  // `group_membership_changed` on any change. Without this, an owner flipping
  // slowmode reached members only on their next chat open. Both shapes of the
  // frame are handled in `group-events`. Above 100 members it degrades to the
  // id plus `owner_uin`, and the owner half of it lands here immediately, which
  // is what keeps `canPin` / `canModerate` / `readOnlyHere` from drawing the
  // previous owner's rights in a big room after a handover. Cross-island groups
  // ride a different island's socket, so they stay on the fetch-on-open path.
  useGroupChanged(
    { enabled: isGroup && gctx != null && !gctx.host, ident: gctx?.ident ?? null, gid: gctx?.gid ?? null },
    (patch) => {
      const gid = gctx?.gid
      setGroup((prev) => {
        // ⚠ The owner patch is MERGED into what we already hold. It carries the
        // owner and nothing else, so replacing the group with it would blank
        // the roster, and a blank roster is not a display problem here: it is
        // what the send path seals against.
        const next =
          patch.kind === 'snapshot'
            ? patch.group
            : prev
              ? { ...prev, owner_uin: patch.ownerUin }
              : prev
        if (next && gid != null) _groupCache.set(gid, next)
        return next
      })
    },
  )

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

  const headerSub: React.ReactNode = isGroup
    // Compact from 1000 up (founder item 27): "999", then "1K", "2.1K". The
    // thresholds live in `format-count.ts` so the phones can mirror the exact
    // same rules rather than each inventing their own rounding.
    ? group ? t('section.groups.members', { n: compactCount(memberCount(group)) }) : ''
    : isSelf
      ? t('chat.saved.subtitle')
      : peerTyping
        ? t('chat.typing')
      // Cross-island: show the peer's island (presence doesn't cross islands).
      : peer?.host ? `#${peerUIN} · ${peer.host}`
      // B1: the '#' the founder asked for, and — like the iOS header — an
      // offline peer's subtitle breathes between the uin and their last-seen.
      : peer?.status === 'offline' && peer.last_seen
        ? <AltSubtitle uin={peerUIN ?? 0} lastSeen={relativeLastSeen(peer.last_seen, t, lang)} />
        : `#${peerUIN}`
  // One ordered timeline of both halves of the conversation, with a day
  // separator inserted wherever the date changes. Until now the list showed
  // only HH:MM, so a message from last week looked exactly like one from an
  // hour ago and there was no way to tell what happened when.
  const timeline = useMemo(() => {
    // ⚠ A message can legitimately arrive on BOTH halves, and then it is one
    // message drawn twice: once on the left as something received, once on the
    // right as something sent.
    //
    // Notes-to-self is the case that makes it visible. The island delivers the
    // envelope (you are the addressee) AND the carbon (you are the sender), so
    // every note showed up twice on any device that was not the one that typed
    // it — the whole thread doubled, the second copy on the wrong side. The
    // sent half is the true one: it knows this device wrote it.
    const sentIds = new Set(outgoing.map((row) => row.id))
    const items = [
      ...outgoing
        // A 1:1 log is keyed by the BARE uin, so this thread and the thread for
        // the same number on another island are one log — two people, one key.
        // A call is the row that must be told apart (§5d): a real cross-island
        // call now happens, and "you called them for four minutes" in a local
        // namesake's conversation is a lie about a stranger. The island travels
        // on the row; here is where it decides whose conversation it is in.
        .filter((row) => row.kind !== 'call' || (row.peerHost ?? null) === (islandHost ?? null))
        .map((row) => ({ at: row.sentAt, kind: 'out' as const, row })),
      ...incoming
        .filter((m) => !sentIds.has(m.id))
        .map((m) => ({ at: m.at, kind: 'in' as const, msg: m })),
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
      | ((typeof items)[number] & { cont?: boolean })
      | { kind: 'day'; at: number }
      | { kind: 'unread'; at: number; count: number }
    > = []
    let lastDay = ''
    let lastAuthor: string | null = null
    let lastAt = 0
    let dividerPlaced = false
    for (const it of items) {
      const day = new Date(it.at).toDateString()
      if (day !== lastDay) {
        out.push({ kind: 'day', at: it.at })
        lastDay = day
        lastAuthor = null
      }
      // Where reading stopped, once. The run grouping is broken across it as
      // well, so the first unread message carries its own name and avatar
      // instead of reading as a continuation of the last one already seen.
      if (!dividerPlaced && unreadAnchorId && (it.kind === 'in' ? it.msg.id : it.row.id) === unreadAnchorId) {
        out.push({ kind: 'unread', at: it.at, count: 0 })
        dividerPlaced = true
        lastAuthor = null
      }
      const author = it.kind === 'out' ? 'me' : `in:${it.msg.from}`
      const cont = author === lastAuthor && it.at - lastAt < RUN_GAP_MS
      out.push({ ...it, cont })
      lastAuthor = author
      lastAt = it.at
    }
    // The number on the divider, so it reads "Unread messages (7)" the way the
    // Android divider does (#701 asked for one look across the clients). Counted
    // over what the divider actually divides: inbound items below it.
    const div = out.find((x) => x.kind === 'unread')
    if (div && 'count' in div) {
      const from = out.indexOf(div)
      div.count = out.slice(from + 1).filter((x) => x.kind === 'in').length
    }
    return out
  }, [outgoing, incoming, deletedVersion, unreadAnchorId, islandHost])

  /// Ids of the messages containing the query, newest last — the same order
  /// they sit in the thread, so stepping through them walks the conversation
  /// rather than jumping about.
  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [] as { id: string; text: string; at: number; mine: boolean; author?: string }[]
    return timeline.flatMap((it) => {
      if (it.kind === 'day' || it.kind === 'unread') return []
      // A call row's "text" is a pipe-joined list of i18n KEYS, not anything
      // anyone wrote, so searching it matched things like "video" against a
      // conversation that never contained the word — and stepping to the hit
      // did nothing, because the row carries no `msg-` anchor to scroll to.
      if (it.kind === 'out' && it.row.kind === 'call') return []
      const text = it.kind === 'out' ? it.row.text : it.msg.text
      const id = it.kind === 'out' ? it.row.id : it.msg.id
      const at = it.kind === 'out' ? it.row.sentAt : it.msg.at
      if (!text || !text.toLowerCase().includes(q)) return []
      return [{
        id,
        text,
        at,
        mine: it.kind === 'out',
        author: it.kind === 'out'
          ? undefined
          : isGroup
            ? (peerAliasFor(it.msg.from) || memberByUin.get(it.msg.from)?.nickname || `#${it.msg.from}`)
            : undefined,
      }]
    })
  }, [timeline, query])


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

  // ── What a bubble may do ────────────────────────────────────────────
  // Every callback a message row can reach, in ONE object whose identity NEVER
  // changes. The rows are memoised (see IncomingMessageRow / OutgoingMessageRow
  // below) and React.memo compares props by identity: a bundle rebuilt each
  // render would fail that comparison for every bubble on the thread and the
  // memo would buy nothing at all.
  //
  // The methods delegate through a ref that is refreshed on every render, so a
  // row that has not re-rendered for a hundred keystrokes still calls today's
  // closure. That matters: `downloadRowFile` reads `downloadingRowId`, `retry`
  // reads the outgoing log — a frozen copy of either would act on state that
  // is minutes old.
  const rowLiveRef = useRef<RowActions | null>(null)
  rowLiveRef.current = {
    toggleActions,
    toggleReactionPicker: (rowId, anchor) => {
      // Both menus float from the same anchor, so they must not be open
      // together. The actions toggle already clears this one; this is the
      // other half of the pair.
      setActionsUp(placeMenu(anchor, PICKER_ROOM_PX).up)
      setActionsForRowId(null)
      setReactionForRowId((id) => (id === rowId ? null : rowId))
    },
    openReactionPicker: (rowId) => {
      setActionsForRowId(null)
      setReactionForRowId(rowId)
    },
    showReactionAuthors: setReactionAuthorsFor,
    toggleReaction: (targetId, asset) => void toggleReaction(targetId, asset),
    jumpToMessage,
    startReplyTo,
    startReply,
    startEdit,
    copyText,
    openLink: openLinkFromMenu,
    pinMessage,
    startForward: (text, author) => {
      setForwardingRow({ text, author })
      setActionsForRowId(null)
    },
    startReport,
    downloadRowFile: (rowId, mediaId, mediaKey, name, mime) =>
      void downloadRowFile(rowId, mediaId, mediaKey, name, mime),
    deleteIncoming: (id) => void deleteIncoming(id),
    deleteAsModerator: (id) => void deleteAsModerator(id),
    deleteForEveryone: (row) => void deleteForEveryone(row),
    retry: (id) => void retry(id),
    dismiss,
  }
  const rowActionsRef = useRef<RowActions | null>(null)
  if (!rowActionsRef.current) {
    rowActionsRef.current = {
      toggleActions: (...a) => rowLiveRef.current!.toggleActions(...a),
      toggleReactionPicker: (...a) => rowLiveRef.current!.toggleReactionPicker(...a),
      openReactionPicker: (...a) => rowLiveRef.current!.openReactionPicker(...a),
      showReactionAuthors: (...a) => rowLiveRef.current!.showReactionAuthors(...a),
      toggleReaction: (...a) => rowLiveRef.current!.toggleReaction(...a),
      jumpToMessage: (...a) => rowLiveRef.current!.jumpToMessage(...a),
      startReplyTo: (...a) => rowLiveRef.current!.startReplyTo(...a),
      startReply: (...a) => rowLiveRef.current!.startReply(...a),
      startEdit: (...a) => rowLiveRef.current!.startEdit(...a),
      copyText: (...a) => rowLiveRef.current!.copyText(...a),
      openLink: (...a) => rowLiveRef.current!.openLink(...a),
      pinMessage: (...a) => rowLiveRef.current!.pinMessage(...a),
      startForward: (...a) => rowLiveRef.current!.startForward(...a),
      startReport: (...a) => rowLiveRef.current!.startReport(...a),
      downloadRowFile: (...a) => rowLiveRef.current!.downloadRowFile(...a),
      deleteIncoming: (...a) => rowLiveRef.current!.deleteIncoming(...a),
      deleteAsModerator: (...a) => rowLiveRef.current!.deleteAsModerator(...a),
      deleteForEveryone: (...a) => rowLiveRef.current!.deleteForEveryone(...a),
      retry: (...a) => rowLiveRef.current!.retry(...a),
      dismiss: (...a) => rowLiveRef.current!.dismiss(...a),
    }
  }
  const rowActions = rowActionsRef.current

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
        if (file.type.startsWith('image/')) stagePhoto(file)
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
      {/* The top stack — title bar, in-chat search, pinned banner — is one
          OVERLAY for the same reason the composer below is: while these sat in
          the flex column, `main` began exactly where they ended and nothing
          ever passed behind them, so their `backdrop-filter` had no backdrop
          and the blur simply did not exist. Measured, because the stack is one
          bar, two or three depending on whether search is open and the group
          has a pin. */}
      {/* Opening a message menu fades the rest of the thread out behind it.
          Not decoration: seven small actions hanging off one bubble in a wall
          of other bubbles is hard to read, and this puts the message you are
          acting on — and only it — in front.

          The layering, all in this column's own stacking context: the veil at
          z-[19] — OVER the header and the composer, not under them — and the
          message that owns the menu lifted to z-[20]. It used to sit at z-[15]
          with the bars at z-[18] left sharp above it, which read as the thread
          alone having gone milky while the two black bars stayed put: founder,
          on the desktop, "почему белый блюр то? блюр должен совпадать с шапкой
          и панелью". Dimming everything except the message being acted on is
          also the honest version of what this is for.

          ⚠ `bg-black`, not `bg-ink-black`: that token means "the primary
          foreground colour" and flips to near-WHITE in the dark theme (see
          index.css), so the veil meant to darken the thread was painting a
          white wash over it. That is the white the screenshot showed.

          Blur is deliberately light (2px). The thread behind is TEXT, and a
          heavy blur turns a page of words into a grey smear that reads as a
          rendering fault rather than as depth. */}
      <AnimatePresence>
        {(actionsForRowId || reactionForRowId) && (
          <motion.div
            key="menu-veil"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="absolute inset-0 z-[19] bg-black/45 backdrop-blur-[2px]"
          />
        )}
      </AnimatePresence>
      {/* z-[18] rather than z-10: see the veil above. */}
      <div ref={topBarsRef} className="absolute top-0 inset-x-0 z-[18]">
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
            {/* The picture stays the picture while the peer types: only the UIN
                line below turns into "typing…" (see headerSub). Swapping the
                flower for a pencil hid the one thing the header is for —
                whether the person is online — and made the avatar change on
                every keystroke. Android never did the swap; this is parity. */}
            {!isGroup && !isSelf && peer && (
              <PersonAvatar
                status={peer.status}
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
              {/* Proportional, not mono. This line is a member count, a number
                  or the word for Notes -- none of them a column that has to
                  line up with anything, and mono made the header read like a
                  terminal (founder, 24.08). */}
              <div className="text-xs text-fg-dim truncate">{headerSub}</div>
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
              if (searchOpen) setQuery('')
            }}
            aria-label={t('chat.search.open')}
            title={t('chat.search.open')}
            className={`p-2 transition-colors ${searchOpen ? 'text-accent' : 'text-fg-secondary hover:text-fg-primary'}`}
          >
            <SearchIcon />
          </button>
          {/* A contact on another island is callable now (§5d): the signal is
              sealed and deposited to their island instead of being shouted down
              ours, where a bare `to_uin` used to resolve as a LOCAL number and
              ring a stranger who shared the digits. The buttons were hidden for
              exactly as long as that was true. */}
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

      {searchOpen &&
        createPortal(
          /* In-chat search, the iOS way (megalist B10): not a strip that
             steps the thread through hits, but a blurred sheet OVER the
             thread with the hits listed on it — tap one, the sheet closes and
             the thread jumps there. Portaled for the usual backdrop-filter
             containing-block reason. */
          <div className="fixed inset-0 z-40 flex flex-col bg-surface/60 backdrop-blur-2xl" role="dialog" aria-modal="true">
            <div className="max-w-2xl w-full mx-auto flex-1 min-h-0 flex flex-col">
              <div className="flex items-center gap-2 px-4 pt-4 pb-3">
                <SearchGlyph />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { setSearchOpen(false); setQuery('') }
                    if (e.key === 'Enter' && searchHits.length > 0) {
                      const last = searchHits[searchHits.length - 1]
                      setSearchOpen(false); setQuery('')
                      jumpToMessage(last.id)
                    }
                  }}
                  placeholder={t('chat.search.placeholder')}
                  className="flex-1 min-w-0 h-10 bg-transparent text-lg outline-none placeholder:text-fg-dim"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label={t('common.cancel')}
                    className="text-fg-secondary hover:text-fg-primary"
                  >
                    ×
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { setSearchOpen(false); setQuery('') }}
                  className="text-sm text-accent font-medium"
                >
                  {t('common.cancel')}
                </button>
              </div>
              <div className="h-px bg-line/40" />
              {query.trim() === '' ? (
                <div className="flex-1 flex flex-col items-center pt-16 gap-2 text-fg-secondary">
                  <SearchGlyph size={30} />
                  <div className="text-xs text-center px-10">{t('chat.search.empty.idle')}</div>
                </div>
              ) : searchHits.length === 0 ? (
                <div className="flex-1 flex flex-col items-center pt-16 text-xs text-fg-secondary">
                  {t('chat.search.empty.none')}
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-8">
                  <div className="px-4 pt-3 pb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-fg-secondary">
                    {t('chat.search.section')}
                  </div>
                  {[...searchHits].reverse().slice(0, 100).map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => {
                        setSearchOpen(false); setQuery('')
                        jumpToMessage(h.id)
                      }}
                      className="w-full text-left px-4 py-2.5 hover:bg-fg-primary/[0.05] transition-colors"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-semibold text-fg-secondary truncate">
                          {h.mine ? t('rooms.you') : (h.author ?? (isSelf ? '' : peer?.nickname ?? ''))}
                        </span>
                        <span className="text-[0.625rem] text-fg-dim flex-none">
                          {new Date(h.at).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })}
                        </span>
                      </div>
                      <div className="text-sm text-fg-primary line-clamp-2 break-words">{h.text}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}

      {isGroup && group?.pinned_text && (
        <PinnedBanner
          text={group.pinned_text}
          group={group}
          expanded={pinExpanded}
          onToggle={() => setPinExpanded((v) => !v)}
          linksAllowed={linksAllowed}
        />
      )}


      </div>
      <main
        ref={scrollRef}
        onWheel={releasePinByUser}
        onTouchStart={releasePinByUser}
        onScroll={(e) => {
          const el = e.currentTarget
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          // Reaching the bottom means the divider is behind you whatever moved
          // the list — a wheel, a key, or the jump a reply quote performs. The
          // wheel/touch handlers cannot see those.
          if (bottom) releaseUnreadPin()
          if (pinTargetRef.current === 'bottom' && !bottom) {
            // Mid-layout distance while the follow pin holds: content just
            // grew and the re-pin has not landed yet. Believing this instant
            // reading is what flashed the jump button on every arrival (B8);
            // the pin answers "are we at the bottom" while it exists.
          } else {
            atBottomRef.current = bottom
            setAtBottom(bottom)
          }
          // Remember where reading is, debounced (item 13a). At the bottom the
          // spot is cleared — "resume at the newest" is just opening normally.
          if (posSaveTimer.current) clearTimeout(posSaveTimer.current)
          const key = persistKey
          posSaveTimer.current = setTimeout(() => {
            const live = scrollRef.current
            if (!key || !live) return
            const dist = Math.round(live.scrollHeight - live.scrollTop - live.clientHeight)
            try {
              if (dist < 80) localStorage.removeItem(savedPosKey(key))
              else localStorage.setItem(savedPosKey(key), String(dist))
            } catch {
              /* quota — resuming is a nicety, not state */
            }
          }, 250)
          // Cross rows off the jump-button badge as they come into view. The
          // floor is the composer's top edge, the same maths as roomAround: a
          // row still under the blurred bar has not been seen. The list is a
          // contiguous tail, so only the front needs checking — O(newly seen).
          //
          // ⚠⚠ NOT while the view is still being held against the unread
          // divider by us rather than by the reader. Opening a thread on the
          // divider seeds the badge and writes `scrollTop` in the same breath,
          // and that write calls this handler back: with the divider parked at
          // the top of the pane the whole unread run measures as "above the
          // floor", so every id was crossed off before a word of it had been
          // read and the badge went straight to 0 (founder item 30a: "счётчик
          // непрочитанных на стрелке пропал"). A wheel or a touch releases the
          // pin (see releaseUnreadPin), and from that moment on this is a
          // genuine account of what the reader has passed.
          const pinned = pinTargetRef.current === 'unread'
          const ids = unseenIdsRef.current
          if (pinned) {
            /* held against the divider — nothing has been read yet */
          } else if (bottom) {
            clearUnseenBelow()
          } else if (ids.length) {
            const cs = el.parentElement ? getComputedStyle(el.parentElement) : null
            const composerH = cs ? parseFloat(cs.getPropertyValue('--rcq-composer-h')) || 0 : 0
            const floor = el.getBoundingClientRect().bottom - composerH
            let crossed = 0
            while (crossed < ids.length) {
              const row = document.getElementById(`msg-${ids[crossed]}`)
              // A row that is gone (deleted, pruned) can never scroll into
              // view — cross it off too, or the badge sticks forever.
              if (row && row.getBoundingClientRect().top >= floor) break
              crossed += 1
            }
            if (crossed) {
              unseenIdsRef.current = ids.slice(crossed)
              setUnseenBelow(unseenIdsRef.current.length)
            }
          }
        }}
        className="flex-1 max-w-2xl w-full mx-auto px-4 py-4 overflow-y-auto no-scrollbar"
        style={{
          // Both bars are overlays, so this pane ALREADY spans the whole
          // column: it just pays their height back as padding, and the content
          // scrolls under them (which is what gives `backdrop-filter` a
          // backdrop).
          //
          // ⚠⚠ It used to also pull itself out from under them with negative
          // margins — left over from when the bars were in the flow. With them
          // absolute that stretched the pane 70px PAST the bottom of a
          // `h-screen overflow-hidden` column, and `overflow: hidden` does not
          // stop a browser from scrolling a box: focusing the composer
          // scrolled the column by 45px, which slid the header half off the
          // top of the screen and left the newest message sitting UNDER the
          // composer, with a dead strip below it. Reported 16.08 as "последнее
          // сообщение под полем для ввода".
          paddingTop: 'calc(1rem + var(--rcq-topbars-h, 0px))',
          paddingBottom: 'calc(1rem + var(--rcq-composer-h, 0px))',
        }}
      >
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600 mb-4">
            {error}
          </div>
        )}


        {timeline.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6 -mt-8">
            <div className="text-4xl select-none">{isSelf ? '🔖' : readOnlyHere ? '📣' : '👋'}</div>
            <div className="text-fg-secondary text-sm max-w-xs">
              {isSelf
                ? t('chat.empty.saved')
                : readOnlyHere
                  ? t('chat.empty.readonly')
                  : t('chat.empty.peer', { name: headerName })}
            </div>
            {/* No invitation to say hello where saying hello is not on offer:
                an owner-only group (the composer is disabled, so the button
                would fill a field nobody can send from) and a group closed to
                new members with nothing in it yet (a room nobody can join,
                with no conversation to open, is not waiting for a greeting).
                The empty state itself stays either way: "nothing here yet" is
                still the thing the reader came to find out. */}
            {!readOnlyHere && !closedHere && (
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
            )}
          </div>
        )}
        <ul ref={contentRef} className="space-y-2">
          {timeline
            .map((item) => {
              if (item.kind === 'day') {
                return (
                  <li key={`day-${item.at}`} className="flex justify-center py-2">
                    <span className="px-2 py-0.5 rounded-full bg-surface text-fg-dim text-[0.6875rem] font-medium">
                      {dayLabel(item.at)}
                    </span>
                  </li>
                )
              }
              if (item.kind === 'unread') {
                return (
                  <li key="unread-divider" ref={unreadDividerRef} className="flex items-center gap-3 py-2">
                    <span className="flex-1 h-px bg-accent/40" />
                    {/* whitespace-nowrap keeps the label on one line: the rules
                        are flex-basis 0, so a narrow column pushes all of the
                        shrinking onto the label, whose auto min-width is its
                        longest word - the Russian "Непрочитанные сообщения"
                        then breaks in two. The rules collapse instead, and if
                        even that is not enough the label ellipsizes. */}
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] font-medium text-accent">
                      {t('chat.unread_divider')}
                      {item.count > 0 ? ` (${item.count})` : ''}
                    </span>
                    <span className="flex-1 h-px bg-accent/40" />
                  </li>
                )
              }
              // A finished call is not a bubble from either side: it is a
              // note the conversation keeps, centred, the way both phones
              // draw it. Rendered before the ordinary outgoing branch because
              // it lives in the same log.
              if (item.kind === 'out' && item.row.kind === 'call') {
                const [media, dir, tail] = item.row.text.split('|')
                return (
                  <li key={`call-${item.row.id}`} className="flex justify-center py-1">
                    <span className="flex items-center gap-1.5 px-2 py-0.5 text-[0.6875rem] text-fg-dim">
                      <CallLogIcon missed={!!item.row.callMissed} outgoing={dir === 'call.log.outgoing'} />
                      {t(media)} · {tail.includes(':') ? tail : t(tail)}
                    </span>
                  </li>
                )
              }
              // ⚠⚠ EVERY prop handed to the two row components below is either
              // a scalar or an object whose identity is stable while its
              // contents are (the row itself, the mention context, the action
              // bundle). That is the whole point: they are memoised, React
              // compares those props by identity, and one object literal or
              // one inline arrow built here would fail the comparison for every
              // bubble on the thread — putting the tokenisation of every
              // message back on the keystroke and the send path, which is the
              // freeze item 30b reported. Anything a row needs that is derived
              // from state (a name, a flag, whether ITS menu is open) is
              // narrowed to a scalar here rather than passed whole.
              const rowId = item.kind === 'in' ? item.msg.id : item.row.id
              const openMenu = actionsForRowId === rowId
              const openPicker = reactionForRowId === rowId
              if (item.kind === 'in') {
                const m = item.msg
                const senderMember = isGroup ? memberByUin.get(m.from) : undefined
                // My own name for them wins over the nick they chose, exactly as
                // it does in the 1:1 header. Setting an alias and then still
                // reading their nick over every message in a group read as the
                // alias not having been saved at all.
                const senderName = isGroup
                  ? peerAliasFor(m.from) || senderMember?.nickname || `#${m.from}`
                  : null
                // ⚠ NO aliases in here: ReplyContext ships INSIDE the sealed
                // envelope, so the quote's author label reaches the peer. My
                // own name for someone is device-only by contract — sending it
                // to the very person it describes is the one leak worse than
                // storing it. Their self-chosen nickname only.
                const replyAuthor = (isGroup ? senderMember?.nickname : peer?.nickname) ?? `#${m.from}`
                return (
                  <IncomingMessageRow
                    key={`in-${m.id}`}
                    msg={m}
                    cont={!!item.cont}
                    highlighted={highlightId === m.id}
                    showActions={openMenu}
                    showReactionPicker={openPicker}
                    menuUp={(openMenu || openPicker) && actionsUp}
                    menuMax={openMenu ? actionsMax : 0}
                    actionsLink={openMenu ? actionsLink : null}
                    isSelf={isSelf}
                    canPin={canPin}
                    canModerate={canModerate}
                    // Links stay clickable when the READER is exempt or the
                    // SENDER is: a links-off room is an anti-spam rule for
                    // members, and it was eating the owner's own announcements
                    // in everyone else's view (founder, 29.08).
                    linksAllowed={
                      linksAllowed ||
                      (isGroup && group != null &&
                        (group.owner_uin === m.from ||
                          senderMember?.role === 'admin' ||
                          (senderMember?.permissions?.length ?? 0) > 0))
                    }
                    filesAllowed={filesAllowed}
                    downloading={downloadingRowId === m.id}
                    senderName={senderName}
                    senderAvatarId={senderMember?.avatar_media_id}
                    senderAvatarKey={senderMember?.avatar_media_key}
                    replyAuthor={replyAuthor}
                    mention={mentionCtx}
                    mediaBase={groupMediaBase}
                    myUin={identity.uin}
                    aliasSig={aliasSig}
                    reactionsVersion={reactionsVersion}
                    pressState={pressRef}
                    t={t}
                    h={rowActions}
                  />
                )
              }
              const row = item.row
              return (
                <OutgoingMessageRow
                  key={row.id}
                  row={row}
                  cont={!!item.cont}
                  highlighted={highlightId === row.id}
                  showActions={openMenu}
                  showReactionPicker={openPicker}
                  menuUp={(openMenu || openPicker) && actionsUp}
                  menuMax={openMenu ? actionsMax : 0}
                  actionsLink={openMenu ? actionsLink : null}
                  canPin={canPin}
                  linksAllowed={linksAllowed}
                  filesAllowed={filesAllowed}
                  downloading={downloadingRowId === row.id}
                  myNickname={myNickname}
                  mention={mentionCtxSelf}
                  mediaBase={groupMediaBase}
                  myUin={identity.uin}
                  aliasSig={aliasSig}
                  reactionsVersion={reactionsVersion}
                  pressState={pressRef}
                  t={t}
                  h={rowActions}
                />
              )
            })}
        </ul>
        {/* Scroll anchor — keeps the newest message in view. */}
        <div ref={bottomRef} />
      </main>

      {/* Jump to the newest. Only while the user has scrolled up: the list
          deliberately does not follow new messages then, so without this the
          only way back was dragging the scrollbar, and a message that arrived
          meanwhile gave no sign of itself at all.

          Above it, the @-jump: the messages in this group that called your name
          and that you have not stepped through yet. INDEPENDENT of scroll
          position, unlike the one below — being at the bottom of a group of
          forty tells you nothing about the message eighty rows up that asked
          you a question, which is the whole reason Telegram has this button and
          the whole reason it was reported missing here. */}
      {(!atBottom || mentionsLeft > 0) && (
        <div className="relative max-w-2xl w-full mx-auto">
          {mentionsLeft > 0 && (
            <button
              type="button"
              onClick={() => {
                const id = mentionIds[mentionCursor]
                if (id) jumpToMessage(id)
                // Stepping past the last one takes the cursor to the end, which
                // hides the button — tapping the final mention dismisses it
                // rather than starting the count over.
                setMentionCursor((c) => c + 1)
              }}
              aria-label={t('chat.jump_to_mention')}
              title={t('chat.jump_to_mention')}
              className="absolute right-4 z-20 h-10 min-w-10 px-2 rounded-full bg-surface shadow-lg text-accent flex items-center justify-center gap-1 hover:bg-field transition-colors"
              // ⚠ Off `--rcq-composer-h`, not a viewport-bottom constant: the
              // composer is an OVERLAY, so `bottom-2` put these buttons ON the
              // bar, not above it. Same variable the emoji panel hangs off,
              // and it tracks the bar as a reply strip or a wrapped line grows
              // it. Takes the lower slot when the ↓ arrow is hidden.
              style={{
                bottom: atBottom
                  ? 'calc(var(--rcq-composer-h, 4rem) + 0.5rem)'
                  : 'calc(var(--rcq-composer-h, 4rem) + 3.5rem)',
              }}
            >
              <span aria-hidden="true" className="text-base leading-none font-semibold">@</span>
              <span className="text-xs font-semibold tabular-nums">{mentionsLeft}</span>
            </button>
          )}
          {!atBottom && (
            <button
              type="button"
              onClick={stickToBottom}
              aria-label={t('chat.jump_to_newest')}
              title={t('chat.jump_to_newest')}
              className="absolute right-4 z-20 h-10 min-w-10 px-2 rounded-full bg-surface shadow-lg text-fg-primary flex items-center justify-center gap-1 hover:bg-field transition-colors"
              style={{ bottom: 'calc(var(--rcq-composer-h, 4rem) + 0.5rem)' }}
            >
              <span aria-hidden="true" className="text-base leading-none">↓</span>
              {unseenBelow > 0 && (
                <span className="text-xs font-semibold tabular-nums">{unseenBelow}</span>
              )}
            </button>
          )}
        </div>
      )}

      {/* Composer: the input is a bordered round pill, side buttons are round,
          and the emoji panel is a floating overlay ABOVE the composer — it does
          not push the input down or the messages up.
          The bar itself carries the same translucent blur as the header: the
          thread scrolls UNDER it, and with no background at all the last bubble
          slid beneath the pill and stayed legible through it, which read as a
          rendering fault rather than as depth. */}
      {/* ⚠ An OVERLAY, not a flex row, and that is the whole point of the blur
          above. While this was `flex-none` the three bands were stacked edge to
          edge: <main> began exactly where the header ended and ended exactly
          where this began, so nothing ever passed BEHIND either bar and
          `backdrop-filter` had nothing to filter. The CSS was there, the blur
          was not, and the founder reported it as missing — correctly. Measured
          rather than guessed because this bar grows: a wrapped line, the reply
          strip, the emoji panel. `main` pays the height back as padding, so the
          last message still clears the pill and `scrollHeight` stays honest for
          the bottom-pin maths. */}
      <div
        ref={composerRef}
        className="rcq-floating-bar absolute bottom-0 inset-x-0 z-[18] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="relative max-w-lg mx-auto px-3 py-3">
          {/* Everything that floats above the composer lives in ONE stack: the
              emoji panel on top, the reply/edit strip under it, both over the
              thread. They used to be two absolute layers pinned to the same
              edge, which is why opening the panel while replying put it BEHIND
              the strip. */}
          {/* The emoticon panel is a dialog, centred, over a dimmed and blurred
              window — the shape every other picker in this app already has.
              It used to hang off the left edge of the composer column, which on
              a desktop window reads as a stray box rather than as a choice you
              are making now.

              ⚠ Through a portal for the same reason the pinned-message modal
              is: `.rcq-floating-bar` carries a backdrop-filter, and that makes
              it the containing block for `position: fixed` children, so a
              fixed overlay rendered here would be clipped to the composer. */}
          {createPortal(
            <AnimatePresence>
              {showPicker && (
                <motion.div
                  key="picker-veil"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                  onClick={() => setShowPicker(false)}
                  /// Transparent, deliberately. This panel is a composer
                  /// accessory, not a dialog: veiling and blurring the whole
                  /// window for it read as "the app is busy" when the user only
                  /// reached for an emoticon. The layer stays because it
                  /// swallows the click that closes the panel and because the
                  /// panel positions against it; only the paint goes.
                  className="fixed inset-0 z-50"
                >
                  {/* Over the composer, not in the middle of the window. It was
                      centred for a while and that is the wrong place for it:
                      this panel is part of writing a message, so it belongs
                      where the message is being written, the way it does on the
                      phones. The one that stays a centred dialog is the pack
                      PICKER (EmoticonConfigSheet) — that one is a setting, not
                      a keystroke.
                      ⚠ Positioned off `--rcq-composer-h`, published by the
                      ResizeObserver above: the bar's height changes with a
                      reply strip, a wrapped line and this very panel, so a
                      constant offset would drift off it. */}
                  <motion.div
                    initial={{ y: 12, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 12, opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    onClick={(e) => e.stopPropagation()}
                    data-emoji-panel
                    style={{ bottom: 'calc(var(--rcq-composer-h, 4rem) + 0.5rem)' }}
                    className="fixed inset-x-0 mx-auto w-full max-w-sm px-3"
                  >
                    <EmoticonPicker
                      uin={identity!.uin}
                      onPick={(code, asset) => insertEmoticon(code, asset)}
                    />
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>,
            document.body,
          )}
          <div className="absolute bottom-full inset-x-0 px-3 mb-2 z-10 flex flex-col gap-2 pointer-events-none [&>*]:pointer-events-auto">
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
                    <div className="text-[0.625rem] text-accent uppercase tracking-wider">
                      {t('chat.edit.editing')}
                    </div>
                    <div className="text-fg-secondary truncate">{editingRow.text}</div>
                  </div>
                  <button
                    onClick={cancelEdit}
                    className="text-[0.625rem] uppercase tracking-wider text-fg-dim hover:text-fg-primary"
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
                    <div className="text-[0.625rem] text-fg-dim">
                      {t('chat.reply.replying_to', { name: replyTo.authorName })}
                    </div>
                    <div className="text-fg-secondary truncate"><EmoticonText text={replyTo.snippet} emoticonSize={14} /></div>
                  </div>
                  <button
                    onClick={cancelReply}
                    className="text-[0.625rem] uppercase tracking-wider text-fg-dim hover:text-fg-primary"
                  >
                    × {t('chat.reply.cancel')}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
            {/* Naming someone in a group meant typing their nick exactly, from
                memory, including whatever punctuation they chose. Last in the
                stack so it sits closest to the field the partial is in. */}
            {mentionCandidates.length > 0 && (
              <div className="rounded-2xl bg-surface shadow-lg overflow-hidden max-h-56 overflow-y-auto">
                {mentionCandidates.map((m) => (
                  <button
                    key={m.uin}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickMention(m.nickname)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-field transition-colors"
                  >
                    <span className="flex-1 truncate text-sm">{m.nickname}</span>
                    <span className="text-[0.6875rem] text-fg-dim">#{m.uin}</span>
                  </button>
                ))}
              </div>
            )}
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
                if (file) stagePhoto(file)
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
            {/* While a voice note records, the bar takes the whole row: the
                attach / emoticon / mic buttons leave, which is also what lets
                the row survive a minimized window (founder, 29.08). */}
            <div className={`relative flex-none ${rec ? 'hidden' : ''}`}>
              <button
                data-attach-menu
                onClick={() => {
                  // Always reopens on the main list. A menu that remembers it
                  // was last showing the timers would hide the attachments
                  // behind a back arrow for no reason anyone could guess.
                  setAttachView('main')
                  setAttachMenuOpen((v) => !v)
                }}
                disabled={(!peer && !group) || uploadingPhoto || uploadingFile || readOnlyHere}
                className="h-10 w-10 rounded-full flex items-center justify-center text-fg-secondary hover:bg-line/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title={t('chat.attach')}
                aria-label={t('chat.attach')}
              >
                {uploadingPhoto || uploadingFile ? <span className="text-xs">…</span> : <AttachIcon />}
              </button>
              <AnimatePresence>
                {attachMenuOpen && (
                  <>
                    <motion.div
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 6 }}
                      transition={{ duration: 0.14 }}
                      data-chat-menu
                      data-attach-menu
                      // Wide enough for the longest label in the longest
                      // language: RU's «Приглашение в группу» wrapped to two
                      // lines at w-44 and left the row ragged next to the
                      // one-word ones.
                      className="absolute bottom-full left-0 mb-2 z-20 w-52 rounded-xl bg-surface shadow-lg overflow-hidden"
                    >
                      {attachView === 'ttl' ? (
                        // Disappearing-message timers (founder item 20). A
                        // second VIEW of this panel rather than a menu of its
                        // own: the outside-click handler and Escape already know
                        // `[data-attach-menu]`, and a second floating layer over
                        // a `backdrop-filter` bar is exactly the trap this repo
                        // has hit twice.
                        <>
                          <button
                            onClick={() => setAttachView('main')}
                            className="flex w-full items-center gap-2.5 whitespace-nowrap border-b border-line/60 px-3 py-2.5 text-left text-sm text-fg-secondary hover:bg-field transition-colors"
                          >
                            ← {t('chat.ttl.title')}
                          </button>
                          {TTL_OPTIONS.map((opt) => (
                            <button
                              key={opt.i18n}
                              onClick={() => {
                                if (ttlKey) setThreadTtl(ttlKey, opt.seconds)
                                setAttachView('main')
                                setAttachMenuOpen(false)
                              }}
                              className={`flex w-full items-center gap-2.5 whitespace-nowrap px-3 py-2.5 text-left text-sm hover:bg-field transition-colors ${
                                (threadTtlSec ?? null) === opt.seconds ? 'text-accent' : ''
                              }`}
                            >
                              <span className="w-3.5 flex-none text-center">
                                {(threadTtlSec ?? null) === opt.seconds ? '✓' : ''}
                              </span>
                              {t(opt.i18n)}
                            </button>
                          ))}
                          {/* Said in words, because it is the one thing about
                              this feature people get wrong: the timer decides
                              what THIS device asks recipients to do from now on,
                              it does not reach back into what was already sent
                              and it is not a promise about anybody's device. */}
                          <div className="border-t border-line/60 px-3 py-2 text-[0.625rem] leading-snug text-fg-dim">
                            {t('chat.ttl.hint')}
                          </div>
                        </>
                      ) : (
                      <>
                      <button
                        onClick={() => {
                          setAttachMenuOpen(false)
                          fileInputRef.current?.click()
                        }}
                        className="flex w-full items-center gap-2.5 whitespace-nowrap px-3 py-2.5 text-left text-sm hover:bg-field transition-colors"
                      >
                        <AttachIcon />
                        {t('chat.attach.photo')}
                      </button>
                      {/* Files switched off by the group's owner: no dead
                          button — the entry simply is not there. sendFile
                          still guards, for drag-drop and stale menus. */}
                      {filesAllowed && (
                        <button
                          onClick={() => {
                            setAttachMenuOpen(false)
                            docInputRef.current?.click()
                          }}
                          className="flex w-full items-center gap-2.5 whitespace-nowrap px-3 py-2.5 text-left text-sm hover:bg-field transition-colors"
                        >
                          <DocIcon />
                          {t('chat.attach.file')}
                        </button>
                      )}
                      <button
                        onClick={() => void sendLocation()}
                        className="flex w-full items-center gap-2.5 whitespace-nowrap px-3 py-2.5 text-left text-sm hover:bg-field transition-colors"
                      >
                        <PinIcon />
                        {t('chat.attach.location')}
                      </button>
                      {/* An invite is a link, so a links-off room hides it. */}
                      {linksAllowed && (
                        <button
                          onClick={() => {
                            setAttachMenuOpen(false)
                            setShareGroupOpen(true)
                          }}
                          className="flex w-full items-center gap-2.5 whitespace-nowrap px-3 py-2.5 text-left text-sm hover:bg-field transition-colors"
                        >
                          <GroupInviteIcon />
                          {t('chat.attach.group')}
                        </button>
                      )}
                      {/* Where the poll composer used to be (founder item
                          14a). The timer is the one thing in this menu that is
                          not a thing to send but a rule for everything sent
                          after it, so it sits last, under a divider. */}
                      <button
                        onClick={() => setAttachView('ttl')}
                        className="flex w-full items-center gap-2.5 whitespace-nowrap border-t border-line/60 px-3 py-2.5 text-left text-sm hover:bg-field transition-colors"
                      >
                        <ClockIcon className="text-fg-secondary" />
                        <span className="flex-1">{t('chat.ttl.title')}</span>
                        <span className={`text-[0.625rem] ${threadTtlSec ? 'text-accent' : 'text-fg-dim'}`}>
                          {/* A number some future build wrote and this one has
                              no label for prints as seconds rather than as
                              "Off", which would be a lie about a live timer. */}
                          {ttlLabelKey(threadTtlSec) ? t(ttlLabelKey(threadTtlSec)!) : `${threadTtlSec}s`}
                        </span>
                      </button>
                      </>
                      )}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
            {pendingPhoto && (
              <div className="absolute bottom-full left-0 right-0 mb-1">
                <div className="max-w-2xl mx-auto flex items-center gap-3 rounded-xl bg-surface/90 backdrop-blur-md px-3 py-2 shadow-lg">
                  <img src={pendingPhoto.url} alt="" className="h-12 w-12 rounded-md object-cover flex-none" />
                  <span className="flex-1 min-w-0 text-xs text-fg-secondary truncate">
                    {t('chat.photo.caption_hint')}
                  </span>
                  <button
                    type="button"
                    onClick={unstagePhoto}
                    aria-label={t('common.cancel')}
                    className="text-fg-secondary hover:text-fg-primary px-1"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
            <button
              data-emoji-panel
              onClick={() => setShowPicker((v) => !v)}
              className={`h-10 w-10 rounded-full flex items-center justify-center flex-none transition-colors ${
                showPicker ? 'bg-accent/15 ring-1 ring-accent/40' : 'hover:bg-line/60'
              } ${rec ? 'hidden' : ''}`}
              title={t('chat.emoticons')}
              aria-label={t('chat.emoticons')}
            >
              {/* 'smile' left with the retired pack (2026-08-20) and a broken
                  img made the whole button read as MISSING. i-m_so_happy is
                  the current pack's face for the job. */}
              <img
                src={emoticonAssetURL('i-m_so_happy')}
                alt=""
                width={22}
                height={22}
                draggable={false}
                className="select-none"
              />
            </button>
            <button
              onClick={() => void startVoice()}
              disabled={(!peer && !group) || readOnlyHere || !!rec || uploadingFile}
              className={`h-10 w-10 rounded-full flex items-center justify-center flex-none hover:bg-line/60 transition-colors disabled:opacity-40 ${rec ? 'hidden' : ''}`}
              title={t('voice.label')}
              aria-label={t('voice.label')}
            >
              <MicGlyph />
            </button>
            {rec ? (
              // The pulsing dot and the timer already say "recording"; the
              // word said it a third time and, in a narrow window, wrapped to
              // a second line and shoved Send off the edge (founder, 29.08).
              // min-w-0 lets the bar shrink with the window instead of
              // overflowing it; the buttons never wrap or ellipsize.
              <div className="flex-1 min-w-0 h-10 rounded-2xl bg-surface px-4 flex items-center gap-3">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse flex-none" />
                <span className="text-sm text-fg-secondary tabular-nums flex-none">
                  {Math.floor(recElapsed / 60)}:{String(recElapsed % 60).padStart(2, '0')}
                </span>
                <span className="flex-1" />
                <button onClick={cancelVoice} className="text-xs text-fg-secondary hover:text-fg-primary flex-none whitespace-nowrap">
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => void finishVoice()}
                  className="h-8 px-3 rounded-full bg-accent text-white text-xs font-semibold flex-none whitespace-nowrap"
                >
                  {t('chat.send')}
                </button>
              </div>
            ) : (
            <EmoticonInput
              ref={taRef}
              className="flex-1 rounded-2xl bg-surface px-4 py-2.5 text-sm outline-none leading-snug focus:ring-1 focus:ring-accent transition-colors max-h-[8.75rem] overflow-y-auto"
              placeholder={
                // The reason, where the user is already looking. A broadcast
                // group used to swap the whole bar for a notice; the bar is
                // still here and simply cannot be typed in, which is the same
                // sentence without the layout consequences (see readOnlyHere).
                readOnlyHere
                  ? t('chat.owner_only.notice')
                  : isGroup && group
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
                  .find((r) => (r.state === 'sent' || r.state === 'delivered' || r.state === 'read') && (!r.kind || r.kind === 'text'))
                if (last) startEdit(last)
              }}
              onPasteImage={stagePhoto}
              disabled={(!peer && !group) || readOnlyHere}
            />
            )}
            <button
              onClick={() => void send()}
              disabled={(!peer && !group) || (!input.trim() && !pendingPhoto) || slowActive || readOnlyHere}
              className="h-10 w-10 rounded-full bg-accent hover:bg-accent-dim text-white flex items-center justify-center flex-none disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label={slowActive ? t('chat.slowmode.wait', { s: String(slowLeft) }) : t('chat.send')}
              title={slowActive ? t('chat.slowmode.wait', { s: String(slowLeft) }) : t('chat.send')}
            >
              {/* Slowmode: the button IS the countdown — the seconds left
                  where the arrow was, ticking down to sendable. */}
              {slowActive ? (
                <span className="text-[0.6875rem] font-semibold tabular-nums">{slowLeft}</span>
              ) : (
                <SendIcon />
              )}
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

      {reportingMsg && (
        <ReportMessageModal
          targetUin={reportingMsg.from}
          onClose={() => setReportingMsg(null)}
          onSend={(text) => sendMessageReport(text)}
        />
      )}

      <ReactionAuthors
        visible={reactionAuthorsFor != null && reactionAuthors.length > 0}
        authors={reactionAuthors}
        onClose={() => setReactionAuthorsFor(null)}
      />

      {shareGroupOpen && (
        <ShareGroupSheet
          onClose={() => setShareGroupOpen(false)}
          onPick={(link) => void sendGroupInvite(link)}
        />
      )}
    </div>
  )
}

// ── One message, memoised ───────────────────────────────────────────────
// The thread is not virtualised and it never will be cheap to rebuild: every
// bubble runs EmoticonText's tokeniser over its body, and there can be
// hundreds on screen. Before this split, one `setOutgoing` — a keystroke's
// worth of draft, a delivery receipt, the optimistic row a send inserts — re-
// rendered every bubble in the conversation, which is what made sending a
// reply feel like the window had frozen (founder item 30b). iOS reached the
// same conclusion first and marks its row `.equatable()` (Views/MessageRow).
//
// ⚠⚠ React.memo's DEFAULT comparison is used on purpose, and it is what makes
// this safe: it compares every prop there is, so no prop can be forgotten out
// of a hand-written check and silently stop a row from repainting. The
// obligation moves to the caller instead — every prop must be a scalar, or an
// object whose identity changes exactly when its contents do. Two props
// (`aliasSig`, `reactionsVersion`) exist only to carry that news for state the
// rows read out of the shared stores rather than take as data.

/// The i18n translator, as handed down to a row.
type Translate = (key: string, params?: Record<string, string | number>) => string

/// The long-press gesture's shared scratch space (see pressMenuAttrs).
interface PressState {
  timer: number | null
  sx: number
  sy: number
  firedAt: number
}

/// Everything a bubble can ask the thread to do. Built once, in Chat, with a
/// stable identity — see the note where it is assembled.
interface RowActions {
  toggleActions: (rowId: string, anchor?: HTMLElement | null, ev?: { target: EventTarget | null }) => void
  toggleReactionPicker: (rowId: string, anchor: HTMLElement) => void
  openReactionPicker: (rowId: string) => void
  showReactionAuthors: (targetId: string) => void
  toggleReaction: (targetId: string, asset: string | null) => void
  jumpToMessage: (id: string) => void
  startReplyTo: (id: string, text: string, authorName: string) => void
  startReply: (row: OutgoingRow) => void
  startEdit: (row: OutgoingRow) => void
  copyText: (text: string) => void
  openLink: (url: string) => void
  pinMessage: (text: string) => void
  startForward: (text: string, author: string) => void
  startReport: (m: { from: number; text: string; kind?: string; fileName?: string; mediaId?: string }) => void
  downloadRowFile: (rowId: string, mediaId: string, mediaKey: string, name?: string, mime?: string) => void
  deleteIncoming: (id: string) => void
  deleteAsModerator: (id: string) => void
  deleteForEveryone: (row: OutgoingRow) => void
  retry: (id: string) => void
  dismiss: (id: string) => void
}

/// What both sides of the conversation need to draw one bubble.
interface CommonRowProps {
  t: Translate
  h: RowActions
  /// This row is a continuation of the one above it (same author, same day,
  /// close enough in time) — it loses its name and tightens the gap.
  cont: boolean
  /// A quote or a search hit landed on this row: flash it.
  highlighted: boolean
  showActions: boolean
  showReactionPicker: boolean
  /// Where the floating menu hangs and how tall it may be. Only meaningful
  /// while this row's own menu is open, so the caller sends constants
  /// otherwise — a shared "which way is up" would repaint the whole thread
  /// every time anybody opened a menu.
  menuUp: boolean
  menuMax: number
  actionsLink: string | null
  linksAllowed: boolean
  filesAllowed: boolean
  /// This row's file is being decrypted for saving right now.
  downloading: boolean
  mention: MentionContext | undefined
  mediaBase: string | undefined
  myUin: number
  /// Repaint triggers, deliberately unused in the body: the chips read the
  /// reactions store directly and the mention context reads the alias store,
  /// and neither can tell a memoised row that it changed. See the note above.
  aliasSig: string
  reactionsVersion: number
  pressState: { current: PressState }
}

interface IncomingRowProps extends CommonRowProps {
  msg: IncomingRow
  isSelf: boolean
  canPin: boolean
  canModerate: boolean
  senderName: string | null
  senderAvatarId: string | null | undefined
  senderAvatarKey: string | null | undefined
  replyAuthor: string
}

interface OutgoingRowProps extends CommonRowProps {
  row: OutgoingRow
  canPin: boolean
  myNickname: string
}

/// Reaction chips under a bubble — one per distinct asset with a count;
/// the viewer's own asset is highlighted. Tapping a chip toggles it.
/// `align` matches the bubble side. Reads the shared reactions store, which
/// is why every row carries `reactionsVersion`.
function reactionChips(targetId: string, align: 'start' | 'end', myUin: number, h: RowActions) {
  const chips = aggregateReactions(targetId, myUin)
  if (chips.length === 0) return null
  // Long-press is the touch equivalent of the right-click below. Cancelled by
  // moving or lifting early so a scroll never opens the sheet.
  let pressTimer: ReturnType<typeof setTimeout> | undefined
  const holdStart = () => {
    pressTimer = setTimeout(() => {
      pressTimer = undefined
      h.showReactionAuthors(targetId)
    }, 450)
  }
  const holdCancel = () => {
    if (pressTimer) clearTimeout(pressTimer)
    pressTimer = undefined
  }
  return (
    <div className={`flex flex-wrap gap-1 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      {chips.map((c) => (
        <button
          key={c.asset}
          onClick={() => h.toggleReaction(targetId, c.asset)}
          onContextMenu={(e) => {
            e.preventDefault()
            h.showReactionAuthors(targetId)
          }}
          onPointerDown={holdStart}
          onPointerUp={holdCancel}
          onPointerLeave={holdCancel}
          onPointerCancel={holdCancel}
          className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 transition-colors ${
            c.mine ? 'bg-accent/25' : 'bg-field hover:bg-line/60'
          }`}
          title={c.asset}
        >
          {/* ⚠ `w-auto`, not a square. The kolobki are not square images (21x25,
              33x40, 37x25 …), and a fixed w-4 h-4 box squeezed every one of them
              into it — the same flattening `object-contain` fixed in the picker,
              still here under the bubble. The height is what a chip needs to
              agree on; the width is the picture's own business. */}
          <img
            src={emoticonAssetURL(c.asset)}
            alt={c.asset}
            className="h-4 w-auto max-w-6 select-none object-contain"
            draggable={false}
          />
          {c.count > 1 && <span className="text-[0.625rem] text-fg-secondary">{c.count}</span>}
        </button>
      ))}
    </div>
  )
}

/// Swipe-left-to-reply (touch, mobile-web "like on phones"). Returns touch
/// handlers for a message row; a quick leftward drag fires `onReply`.
function swipeReplyAttrs(onReply: () => void) {
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

/// Right-click / long-press handlers that open a message's actions menu —
/// for the bubbles that are not a plain <button> (photo, video, file, invite,
/// placeholder): their tap keeps doing what it does (lightbox, play, join), and
/// THIS is how the menu — report, reply, download — is reached on them
/// (founder, 21.08: "я не могу пожаловаться даже на сообщение").
function pressMenuAttrs(rowId: string, pressState: { current: PressState }, h: RowActions) {
  // One shared scratch space, not per-call closures: this runs again on every
  // render of the row, and a timer held in a closure would be orphaned by a
  // re-render mid-gesture — firing 450ms after touchstart even though the
  // finger already left. Only one touch gesture exists at a time, so the whole
  // thread shares it. `firedAt` guards the Android double: the OS fires a
  // contextmenu ~500ms into the same long-press our timer resolves at 450ms,
  // and the second event would toggle the just-opened menu straight back shut.
  const st = pressState.current
  const clear = () => {
    if (st.timer != null) {
      clearTimeout(st.timer)
      st.timer = null
    }
  }
  return {
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault()
      if (Date.now() - st.firedAt < 800) return
      h.toggleActions(rowId, e.currentTarget, e)
    },
    onTouchStart: (e: React.TouchEvent<HTMLElement>) => {
      const tch = e.touches[0]
      if (!tch) return
      st.sx = tch.clientX
      st.sy = tch.clientY
      // currentTarget is gone by the time the timer fires — capture now.
      const el = e.currentTarget
      clear()
      st.timer = window.setTimeout(() => {
        st.timer = null
        st.firedAt = Date.now()
        h.toggleActions(rowId, el)
      }, 450)
    },
    onTouchMove: (e: React.TouchEvent<HTMLElement>) => {
      const tch = e.touches[0]
      if (!tch) return
      if (Math.abs(tch.clientX - st.sx) > 10 || Math.abs(tch.clientY - st.sy) > 10) clear()
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
  }
}

/// A row the outgoing menu may open for. 'sending'/'failed' rows have
/// their own inline controls (retry/dismiss) and render no menu — letting
/// a press open one would only dim the thread over nothing.
function vouchedOut(row: OutgoingRow): boolean {
  return row.state === 'sent' || row.state === 'delivered' || row.state === 'read'
}

/// One received message.
const IncomingMessageRow = memo(function IncomingMessageRow({
  msg: m,
  t,
  h,
  cont,
  highlighted,
  showActions,
  showReactionPicker,
  menuUp,
  menuMax,
  actionsLink,
  linksAllowed,
  filesAllowed,
  downloading,
  mention,
  mediaBase,
  myUin,
  pressState,
  isSelf,
  canPin,
  canModerate,
  senderName,
  senderAvatarId,
  senderAvatarKey,
  replyAuthor,
}: IncomingRowProps) {
  const invite = parseGroupInvite(m.text)
  const isPlainText =
    m.kind !== 'photo' &&
    m.kind !== 'video' &&
    m.kind !== 'file' &&
    m.kind !== 'other' &&
    m.kind !== 'poll' &&
    invite == null
  const press = () => pressMenuAttrs(m.id, pressState, h)
  /// What a reply to this message may quote.
  ///
  /// ⚠ A quote is permanent, the message it quotes may not be. The timer is
  /// per-side (see `disappearing.ts`), so a reply of mine to a peer's message
  /// with five minutes on it carries no `ttl` of its own whenever MY thread
  /// timer is off: copying the body into `replyTo.snippet` would ship it back
  /// to them, persist it in this device's log and write it into a `.rcqbak`
  /// export, and the one line the sender was promised would go stays word for
  /// word inside the answer to it. Quote the label instead. The reply still
  /// carries the message id, so both sides keep the thread and the jump to it.
  const replyQuote =
    m.expiresAt != null ? t('chat.ttl.quoted') : m.text || m.fileName || t('chat.pin.attachment')
  return (
    <li id={`msg-${m.id}`} className={`group flex justify-start rounded-lg transition-colors duration-500 ${cont ? '-mt-1' : ''} ${highlighted ? 'bg-accent/15' : ''} ${showActions || showReactionPicker ? 'relative z-[20]' : ''}`} {...swipeReplyAttrs(() => h.startReplyTo(m.id, replyQuote, replyAuthor))}>
      <div className="relative max-w-[80%] flex flex-col items-start gap-1">
        {senderName && !cont && (
          <Link
            to={`/profile/${m.from}`}
            className="flex items-center gap-1.5 text-[0.625rem] text-fg-dim px-1 hover:text-accent transition-colors"
          >
            {/* Beside the nick, never instead of it, and only
                when there is a picture. */}
            <SenderAvatar mediaId={senderAvatarId} mediaKey={senderAvatarKey} size={16} />
            {senderName}
          </Link>
        )}
        {m.replyTo && (
          <button
            type="button"
            onClick={() => h.jumpToMessage(m.replyTo!.id)}
            className="border-l-2 border-accent/60 pl-2 max-w-full text-left rounded-r hover:bg-line/30 transition-colors cursor-pointer"
          >
            <div className="text-[0.625rem] text-fg-dim">{m.replyTo.authorName}</div>
            <div className="text-[0.6875rem] text-fg-secondary line-clamp-3 break-words max-w-[18rem]"><EmoticonText text={m.replyTo.snippet} emoticonSize={14} /></div>
          </button>
        )}
        {m.kind === 'poll' ? (
          // A ballot from an old peer, or one this account received before
          // polls were cut (founder item 14a). It renders as "no longer
          // supported" rather than vanishing: the reader has to be able to see
          // that something was said here, or the answers below it make no
          // sense. Everything else about the row still works (reply, report,
          // hide) because the menu hangs off the same handle.
          <div className="relative" data-chat-menu {...press()}>
            <MediaPlaceholder mediaKind="poll" />
            <BubbleMenuButton tone="chrome" label={t('chat.actions.more')} open={showActions} onOpen={(el) => h.toggleActions(m.id, el)} />
          </div>
        ) : m.kind === 'photo' && m.mediaId && m.mediaKey ? (
          <div className="flex flex-col items-start gap-1" data-chat-menu {...press()}>
            <div className="relative">
              <DecryptedImage mediaId={m.mediaId} mediaKey={m.mediaKey} apiBase={mediaBase} />
              <BubbleMenuButton tone="over" label={t('chat.actions.more')} open={showActions} onOpen={(el) => h.toggleActions(m.id, el)} />
            </div>
            {m.text && (
              <div className="rounded-lg px-3 py-2 text-sm bg-bubble-other rcq-selectable" onClick={(e) => h.toggleActions(m.id, e.currentTarget, e)}>
                <EmoticonText text={m.text} emoticonSize={18} mention={mention} link={{ enabled: linksAllowed }} />
              </div>
            )}
          </div>
        ) : m.kind === 'video' && m.mediaId && m.mediaKey ? (
          <div className="flex flex-col items-start gap-1" data-chat-menu {...press()}>
            <div className="relative">
              <DecryptedVideo
                mediaId={m.mediaId}
                mediaKey={m.mediaKey}
                thumbnailB64={m.thumbnailB64}
                durationSec={m.durationSec}
                apiBase={mediaBase}
              />
              <BubbleMenuButton tone="over" label={t('chat.actions.more')} open={showActions} onOpen={(el) => h.toggleActions(m.id, el)} />
            </div>
            {m.text && (
              <div className="rounded-lg px-3 py-2 text-sm bg-bubble-other rcq-selectable" onClick={(e) => h.toggleActions(m.id, e.currentTarget, e)}>
                <EmoticonText text={m.text} emoticonSize={18} mention={mention} link={{ enabled: linksAllowed }} />
              </div>
            )}
          </div>
        ) : m.kind === 'voice' && m.mediaId && m.mediaKey ? (
          <div className="flex flex-col items-start gap-1" data-chat-menu {...press()}>
            <div className="relative rounded-lg px-3 py-1.5 bg-bubble-other rcq-selectable">
              <VoiceBubble
                apiBase={mediaBase}
                mediaId={m.mediaId}
                mediaKey={m.mediaKey}
                durationSec={m.durationSec}
              />
              <BubbleMenuButton tone="over" label={t('chat.actions.more')} open={showActions} onOpen={(el) => h.toggleActions(m.id, el)} />
            </div>
          </div>
        ) : m.kind === 'file' && m.mediaId && m.mediaKey ? (
          <div className="flex flex-col items-start gap-1" data-chat-menu {...press()}>
            <FileBubble
              mediaId={m.mediaId}
              mediaKey={m.mediaKey}
              fileName={m.fileName}
              mime={m.fileMime}
              size={m.fileSize}
              apiBase={mediaBase}
              onPress={(el) => h.toggleActions(m.id, el)}
              busy={downloading}
              disabledNote={filesAllowed ? undefined : t('chat.files_off.chip')}
            />
            {m.text && (
              <div className="rounded-lg px-3 py-2 text-sm bg-bubble-other rcq-selectable" onClick={(e) => h.toggleActions(m.id, e.currentTarget, e)}>
                <EmoticonText text={m.text} emoticonSize={18} mention={mention} link={{ enabled: linksAllowed }} />
              </div>
            )}
          </div>
        ) : m.kind === 'other' ? (
          <div className="relative" data-chat-menu {...press()}>
            <MediaPlaceholder mediaKind={m.mediaKind} />
            <BubbleMenuButton tone="chrome" label={t('chat.actions.more')} open={showActions} onOpen={(el) => h.toggleActions(m.id, el)} />
          </div>
        ) : invite != null ? (
          // A join card renders in a links-off room too (founder, 29.08,
          // reversing the "an invite IS a link" call): the card is RCQ's own
          // join mechanic, not an external URL, and SENDING one in a
          // links-off room is still gated to the owner and moderators, so
          // what appears here already passed that gate.
          <div className="relative" data-chat-menu {...press()}>
            <GroupJoinCard groupId={invite.id} host={invite.host} menuSpace />
            <BubbleMenuButton tone="chrome" label={t('chat.actions.more')} open={showActions} onOpen={(el) => h.toggleActions(m.id, el)} />
          </div>
        ) : (
          <button
            data-chat-menu
            onClick={(e) => h.toggleActions(m.id, e.currentTarget, e)}
            onContextMenu={(e) => { e.preventDefault(); h.toggleActions(m.id, e.currentTarget, e) }}
            className="rounded-lg px-3 py-2 text-sm text-left bg-bubble-other rcq-selectable hover:brightness-110 transition-colors"
          >
            <EmoticonText text={m.text} emoticonSize={18} mention={mention} link={{ enabled: linksAllowed }} />
            {m.edited && <span className="ml-1 text-[0.625rem] text-fg-dim italic">{t('chat.edit.edited')}</span>}
          </button>
        )}
        {reactionChips(m.id, 'start', myUin, h)}
        <div className="flex items-center gap-1 text-[0.625rem] text-fg-dim">
          {new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {m.expiresAt != null && <ExpiryMark expiresAt={m.expiresAt} t={t} />}
        </div>
        {/* ⚠ Floats, like the reaction picker right below. As an
            in-flow block it grew the row and shoved every message
            under it down the thread, so opening a menu moved the
            text you were about to act on. Same anchor
            (`top-full` on the bubble's `relative` column), one
            layer above the picker; the two are never open at once,
            both toggles close the other. */}
        <AnimatePresence>
        {showActions && (
          <ActionMenu align="start" up={menuUp} max={menuMax}>
            {/* The click that opened this menu landed on a URL:
                opening and copying it lead — a link never
                navigates by itself anymore. */}
            {actionsLink != null && (
              <ActionButton
                onClick={() => h.openLink(actionsLink)}
                label={t('chat.actions.open_link')}
                icon={<MenuLinkIcon />}
              />
            )}
            {actionsLink != null && (
              <ActionButton onClick={() => h.copyText(actionsLink)} label={t('chat.actions.copy_link')} icon={<MenuCopyIcon />} />
            )}
            {/* A file downloads from HERE now, not from the tap
                itself — the tap opens this menu. */}
            {m.kind === 'file' && m.mediaId && m.mediaKey && filesAllowed && (
              <ActionButton
                onClick={() => h.downloadRowFile(m.id, m.mediaId!, m.mediaKey!, m.fileName, m.fileMime)}
                label={t('chat.actions.download')}
                icon={<MenuDownloadIcon />}
              />
            )}
            {/* The only way in on a touch screen. The ☺ beside
                the bubble is `rcq-hover-only` — deliberately, it
                needs a pointer to hover it — so without this row
                a phone browser could not react at all, and on an
                OWN message not even a desktop menu offered it. */}
            <ActionButton
              onClick={() => h.openReactionPicker(m.id)}
              label={t('chat.actions.react')}
              icon={<MenuReactIcon />}
            />
            <ActionButton
              onClick={() => h.startReplyTo(m.id, replyQuote, replyAuthor)}
              label={t('chat.actions.reply')}
              icon={<MenuReplyIcon />}
            />
            {m.kind === 'text' && (
              <ActionButton onClick={() => h.copyText(m.text)} label={t('chat.actions.copy')} icon={<MenuCopyIcon />} />
            )}
            {canPin && isPlainText && (
              <ActionButton onClick={() => h.pinMessage(m.text)} label={t('chat.actions.pin')} icon={<MenuPinIcon />} />
            )}
            {m.kind === 'text' && (
              <ActionButton
                onClick={() => h.startForward(m.text, replyAuthor)}
                label={t('chat.actions.forward')}
                icon={<MenuForwardIcon />}
              />
            )}
            {/* Reporting somebody's message to the island's
                operators — reachable on EVERY kind now, which
                was the founder's point: a video or file offered
                no menu at all, so no way to report it. */}
            {!isSelf && (
              <ActionButton
                onClick={() => h.startReport(m)}
                label={t('chat.actions.report')}
                icon={<MenuFlagIcon />}
              />
            )}
            {/* The group's owner / an admin retracts anybody's
                message for everyone (founder batch 21.08 item
                3). Sits above "hide": one is moderation, the
                other is housekeeping, and they answer different
                questions. */}
            {canModerate && !isSelf && (
              <ActionButton
                onClick={() => h.deleteAsModerator(m.id)}
                label={t('chat.actions.delete')}
                icon={<MenuTrashIcon />}
                danger
              />
            )}
            {/* Hides it HERE only. There is no deleting somebody
                else's message off their device, and offering a
                button that looks like it might is worse than not
                offering one — hence the wording, not "delete".
                Saved Messages is the one thread where the "other
                device" is mine, so there it really does delete
                everywhere and says so — see [deleteIncoming]. */}
            <ActionButton
              onClick={() => h.deleteIncoming(m.id)}
              label={t(isSelf ? 'chat.actions.delete' : 'chat.actions.hide')}
              icon={isSelf ? <MenuTrashIcon /> : <MenuHideIcon />}
              danger={isSelf}
            />
          </ActionMenu>
        )}
        </AnimatePresence>
        <AnimatePresence>
          {showReactionPicker && (
            <motion.div
              key="rp"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.12 }}
              className={`absolute z-20 left-0 ${menuUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
            >
              <ReactionPicker
                uin={myUin}
                current={reactionsForTarget(m.id)?.get(myUin) ?? null}
                onPick={(asset) => h.toggleReaction(m.id, asset)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <button
        type="button"
        data-chat-menu
        onClick={(e) => h.toggleReactionPicker(m.id, e.currentTarget)}
        aria-label={t('chat.actions.react')}
        title={t('chat.actions.react')}
        className="self-center ml-1 h-7 w-7 rounded-full bg-surface text-fg-dim opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex-none rcq-hover-only items-center justify-center"
      >
        <MenuReactIcon />
      </button>
    </li>
  )
})

/// One message of mine, in every shape it can take.
const OutgoingMessageRow = memo(function OutgoingMessageRow({
  row,
  t,
  h,
  cont,
  highlighted,
  showActions,
  showReactionPicker,
  menuUp,
  menuMax,
  actionsLink,
  linksAllowed,
  filesAllowed,
  downloading,
  mention,
  mediaBase,
  myUin,
  pressState,
  canPin,
  myNickname,
}: OutgoingRowProps) {
  /// Right-click/long-press attrs for MY media rows — only once the row has
  /// a menu to show (see vouchedOut).
  const pressAttrs = () =>
    vouchedOut(row) ? { 'data-chat-menu': true, ...pressMenuAttrs(row.id, pressState, h) } : {}
  /// The visible half of the same thing. Same gate: a row still in flight has
  /// no menu to open, so it gets no handle to open one with either. The parent
  /// has to be `relative` (the handle pins itself to its corner).
  const menuButton = (tone: 'over' | 'chrome') =>
    vouchedOut(row) ? (
      <BubbleMenuButton
        tone={tone}
        label={t('chat.actions.more')}
        open={showActions}
        onOpen={(el) => h.toggleActions(row.id, el)}
      />
    ) : null
  /// The floating menu + reaction picker for MY photo/video/file rows — the
  /// media rows had neither (no way to reply to your own photo from a
  /// desktop, no way to retract a file). One helper, because the three
  /// branches would otherwise carry three copies of the same overlay.
  const mediaOverlays = () => (
    <>
      <AnimatePresence>
        {showActions && vouchedOut(row) && (
          <ActionMenu align="end" up={menuUp} max={menuMax}>
            {actionsLink != null && (
              <ActionButton onClick={() => h.openLink(actionsLink)} label={t('chat.actions.open_link')} icon={<MenuLinkIcon />} />
            )}
            {actionsLink != null && (
              <ActionButton onClick={() => h.copyText(actionsLink)} label={t('chat.actions.copy_link')} icon={<MenuCopyIcon />} />
            )}
            {row.kind === 'file' && row.mediaId && row.mediaKey && filesAllowed && (
              <ActionButton
                onClick={() => h.downloadRowFile(row.id, row.mediaId!, row.mediaKey!, row.fileName, row.fileMime)}
                label={t('chat.actions.download')}
                icon={<MenuDownloadIcon />}
              />
            )}
            <ActionButton
              onClick={() => h.openReactionPicker(row.id)}
              label={t('chat.actions.react')}
              icon={<MenuReactIcon />}
            />
            <ActionButton onClick={() => h.startReply(row)} label={t('chat.actions.reply')} icon={<MenuReplyIcon />} />
            <ActionButton onClick={() => h.deleteForEveryone(row)} label={t('chat.actions.delete')} icon={<MenuTrashIcon />} danger />
          </ActionMenu>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showReactionPicker && (
          <motion.div
            key="rp"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className={`absolute z-20 right-0 ${menuUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
          >
            <ReactionPicker
              uin={myUin}
              current={reactionsForTarget(row.id)?.get(myUin) ?? null}
              onPick={(asset) => h.toggleReaction(row.id, asset)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
  /// The delivery line under one of my bubbles: the clock, the ticks, and the
  /// retry/dismiss pair a failed send offers.
  ///
  /// `retryable` is false for a row this build can no longer put on the wire at
  /// all (a legacy poll): offering ↻ there promises a send that `attemptSendRow`
  /// refuses, and used to promise a worse one than that.
  const deliveryLine = (withDismiss: boolean, retryable = true) => (
    <div className="flex items-center justify-end gap-1 text-[0.625rem] text-fg-dim">
      {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      {row.expiresAt != null && <ExpiryMark expiresAt={row.expiresAt} t={t} />}
      {row.state === 'sending' && <ClockMark />}
      <DeliveryMarks state={row.state} />
      {row.state === 'failed' && (
        <>
          <span className="text-red-500">·{t('chat.delivery.failed')}</span>
          {retryable && (
            <button
              onClick={() => h.retry(row.id)}
              className="ml-1 rounded px-1.5 py-0.5 text-red-600 hover:bg-red-500/15 transition-colors"
            >
              ↻ {t('chat.delivery.retry')}
            </button>
          )}
          {withDismiss && (
            <button
              onClick={() => h.dismiss(row.id)}
              className="rounded px-1.5 py-0.5 text-fg-dim hover:bg-line transition-colors"
            >
              × {t('chat.delivery.dismiss')}
            </button>
          )}
        </>
      )}
    </div>
  )
  const liClass = `group flex justify-end rounded-lg transition-colors duration-500 ${cont ? '-mt-1' : ''} ${highlighted ? 'bg-accent/15' : ''} ${showActions || showReactionPicker ? 'relative z-[20]' : ''}`

  // Links-off rooms render the raw text bubble instead (same rule
  // as the incoming side — a join card is a link).
  const outInvite = linksAllowed ? parseGroupInvite(row.text) : null
  if (outInvite != null) {
    // A group-invite link I shared — show the join card
    // (not a raw URL bubble) with the delivery state below.
    return (
      <li id={`msg-${row.id}`} className={liClass}>
        <div className="relative max-w-[80%] flex flex-col items-end gap-1" {...pressAttrs()}>
          {/* An invite I sent had no menu on any gesture at all:
              the card swallowed the tap into Join and the row
              carried nothing else. Retracting your own invite is
              the whole point of having one here. */}
          <div className="relative">
            <GroupJoinCard groupId={outInvite.id} host={outInvite.host} menuSpace />
            {menuButton('chrome')}
          </div>
          {reactionChips(row.id, 'end', myUin, h)}
          {mediaOverlays()}
          {deliveryLine(false)}
        </div>
      </li>
    )
  }
  if (row.kind === 'photo' && row.mediaId && row.mediaKey) {
    // A photo I sent — render the image bubble + delivery state.
    return (
      <li id={`msg-${row.id}`} className={liClass}>
        <div className="relative max-w-[80%] flex flex-col items-end gap-1" {...pressAttrs()}>
          <div className="relative">
            <DecryptedImage mediaId={row.mediaId} mediaKey={row.mediaKey} apiBase={mediaBase} />
            {menuButton('over')}
          </div>
          {row.text && (
            <div className="rounded-lg px-3 py-2 text-sm bg-bubble-self rcq-selectable" onClick={vouchedOut(row) ? (e) => h.toggleActions(row.id, e.currentTarget, e) : undefined}>
              <EmoticonText text={row.text} emoticonSize={18} mention={mention} link={{ enabled: linksAllowed }} />
            </div>
          )}
          {reactionChips(row.id, 'end', myUin, h)}
          {mediaOverlays()}
          {deliveryLine(true)}
        </div>
      </li>
    )
  }
  if (row.kind === 'voice' && row.mediaId && row.mediaKey) {
    // A voice note I sent (here, or elsewhere via a carbon).
    return (
      <li id={`msg-${row.id}`} className={liClass}>
        <div className="relative max-w-[80%] flex flex-col items-end gap-1" {...pressAttrs()}>
          <div className="relative rounded-lg px-3 py-1.5 bg-bubble-self rcq-selectable">
            <VoiceBubble
              apiBase={mediaBase}
              mediaId={row.mediaId}
              mediaKey={row.mediaKey}
              durationSec={row.durationSec}
              accent
            />
            {menuButton('over')}
          </div>
          {reactionChips(row.id, 'end', myUin, h)}
          {mediaOverlays()}
          {deliveryLine(true)}
        </div>
      </li>
    )
  }
  if (row.kind === 'video' && row.mediaId && row.mediaKey) {
    // A video I sent (echoed from another device via a carbon) —
    // render the player + delivery state.
    return (
      <li id={`msg-${row.id}`} className={liClass}>
        <div className="relative max-w-[80%] flex flex-col items-end gap-1" {...pressAttrs()}>
          <div className="relative">
            <DecryptedVideo
              mediaId={row.mediaId}
              mediaKey={row.mediaKey}
              thumbnailB64={row.thumbnailB64}
              durationSec={row.durationSec}
              apiBase={mediaBase}
            />
            {menuButton('over')}
          </div>
          {row.text && (
            <div className="rounded-lg px-3 py-2 text-sm bg-bubble-self rcq-selectable" onClick={vouchedOut(row) ? (e) => h.toggleActions(row.id, e.currentTarget, e) : undefined}>
              <EmoticonText text={row.text} emoticonSize={18} mention={mention} link={{ enabled: linksAllowed }} />
            </div>
          )}
          {reactionChips(row.id, 'end', myUin, h)}
          {mediaOverlays()}
          <div className="flex items-center justify-end gap-1 text-[0.625rem] text-fg-dim">
            {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {row.expiresAt != null && <ExpiryMark expiresAt={row.expiresAt} t={t} />}
            <span className="text-accent">✓</span>
          </div>
        </div>
      </li>
    )
  }
  if (row.kind === 'file' && row.mediaId && row.mediaKey) {
    // A document I sent — render the download chip + delivery state.
    return (
      <li id={`msg-${row.id}`} className={liClass}>
        <div className="relative max-w-[80%] flex flex-col items-end gap-1" {...pressAttrs()}>
          <FileBubble
            mediaId={row.mediaId}
            mediaKey={row.mediaKey}
            fileName={row.fileName}
            mime={row.fileMime}
            size={row.fileSize}
            apiBase={mediaBase}
            onPress={vouchedOut(row) ? (el) => h.toggleActions(row.id, el) : undefined}
            busy={downloading}
            disabledNote={filesAllowed ? undefined : t('chat.files_off.chip')}
          />
          {row.text && (
            <div className="rounded-lg px-3 py-2 text-sm bg-bubble-self rcq-selectable" onClick={vouchedOut(row) ? (e) => h.toggleActions(row.id, e.currentTarget, e) : undefined}>
              <EmoticonText text={row.text} emoticonSize={18} mention={mention} link={{ enabled: linksAllowed }} />
            </div>
          )}
          {reactionChips(row.id, 'end', myUin, h)}
          {mediaOverlays()}
          {deliveryLine(true)}
        </div>
      </li>
    )
  }
  if (row.kind === 'poll') {
    // A ballot this account posted before polls were cut (founder item 14a).
    // Same placeholder the received half shows: the row stays where it was in
    // the conversation and says what it used to be, rather than leaving a hole
    // that everything around it still refers to.
    return (
      <li id={`msg-${row.id}`} className={liClass}>
        <div className="relative max-w-[80%] flex flex-col items-end gap-1" {...pressAttrs()}>
          <div className="relative">
            <MediaPlaceholder mediaKind="poll" />
            {menuButton('chrome')}
          </div>
          {reactionChips(row.id, 'end', myUin, h)}
          {mediaOverlays()}
          {/* No ↻ here: this build has no way to put a ballot on the wire, so
              the only honest offer on a failed one is to dismiss it. */}
          {deliveryLine(true, false)}
        </div>
      </li>
    )
  }
  if (row.kind === 'other') {
    // A still-unsupported media (voice/location) the user sent from
    // another device, echoed here via a carbon.
    return (
      <li id={`msg-${row.id}`} className={liClass}>
        <div className="relative max-w-[80%] flex flex-col items-end gap-1" {...pressAttrs()}>
          <div className="relative">
            <MediaPlaceholder mediaKind={row.mediaKind} />
            {menuButton('chrome')}
          </div>
          {reactionChips(row.id, 'end', myUin, h)}
          {mediaOverlays()}
          <div className="flex items-center justify-end gap-1 text-[0.625rem] text-fg-dim">
            {new Date(row.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {row.expiresAt != null && <ExpiryMark expiresAt={row.expiresAt} t={t} />}
            <span className="text-accent">✓</span>
          </div>
        </div>
      </li>
    )
  }
  return (
    <li id={`msg-${row.id}`} className={liClass} {...swipeReplyAttrs(() => h.startReply(row))}>
      <div className="relative max-w-[80%] flex flex-col items-end gap-1">
        {row.fwdName && (
          <div className="text-[0.625rem] uppercase tracking-wider text-fg-dim">
            ↗ {t('chat.forwarded_label', { name: row.fwdName })}
          </div>
        )}
        {row.replyTo && (
          <button
            type="button"
            onClick={() => h.jumpToMessage(row.replyTo!.id)}
            className="border-l-2 border-accent/60 pl-2 max-w-full text-left rounded-r hover:bg-line/30 transition-colors cursor-pointer"
          >
            <div className="text-[0.625rem] text-fg-dim">{row.replyTo.authorName}</div>
            <div className="text-[0.6875rem] text-fg-secondary line-clamp-3 break-words max-w-[18rem]">
              <EmoticonText text={row.replyTo.snippet} emoticonSize={14} />
            </div>
          </button>
        )}
        <button
          data-chat-menu
          onClick={(e) => h.toggleActions(row.id, e.currentTarget, e)}
          // Right-click opens the same actions. On a phone, tapping a
          // bubble to get reply/edit/delete is the obvious gesture; on
          // a desktop it is not, and a right-click just produced the
          // browser's own menu — so desktop Windows reported that
          // deleting a note "is still not there" when it had been
          // there all along, one left-click away.
          onContextMenu={(e) => { e.preventDefault(); h.toggleActions(row.id, e.currentTarget, e) }}
          className={`rounded-lg px-3 py-2 text-sm text-left transition-colors ${
            row.state === 'failed'
              ? 'bg-red-50 border border-red-200'
              : 'bg-bubble-self rcq-selectable hover:bg-bubble-self rcq-selectable/90'
          }`}
        >
          <EmoticonText text={row.text} emoticonSize={18} mention={mention} link={{ enabled: linksAllowed }} />
          {row.edited && <span className="ml-1 text-[0.625rem] text-fg-dim italic">{t('chat.edit.edited')}</span>}
        </button>
        {reactionChips(row.id, 'end', myUin, h)}
        {deliveryLine(true)}
        {row.state === 'failed' && row.error && (
          <div className="text-right text-[0.625rem] text-red-500/80 max-w-full break-words">
            {row.error}
          </div>
        )}
        {/* Floats for the same reason as the incoming side above,
            anchored right because this column is right-aligned. */}
        <AnimatePresence>
        {showActions && (row.state === 'sent' || row.state === 'delivered' || row.state === 'read') && (
          <ActionMenu align="end" up={menuUp} max={menuMax}>
            {actionsLink != null && (
              <ActionButton
                onClick={() => h.openLink(actionsLink)}
                label={t('chat.actions.open_link')}
                icon={<MenuLinkIcon />}
              />
            )}
            {actionsLink != null && (
              <ActionButton onClick={() => h.copyText(actionsLink)} label={t('chat.actions.copy_link')} icon={<MenuCopyIcon />} />
            )}
            {/* Reacting to your own message: the founder's report.
                The menu listed reply / edit / copy / forward / delete
                and nothing else, so the only route was the hover ☺ —
                which does not exist on a touch screen. */}
            <ActionButton
              onClick={() => h.openReactionPicker(row.id)}
              label={t('chat.actions.react')}
              icon={<MenuReactIcon />}
            />
            <ActionButton onClick={() => h.startReply(row)} label={t('chat.actions.reply')} icon={<MenuReplyIcon />} />
            {(!row.kind || row.kind === 'text') && (
              <ActionButton onClick={() => h.startEdit(row)} label={t('chat.actions.edit')} icon={<MenuEditIcon />} />
            )}
            {(!row.kind || row.kind === 'text') && (
              <ActionButton onClick={() => h.copyText(row.text)} label={t('chat.actions.copy')} icon={<MenuCopyIcon />} />
            )}
            {canPin && (
              <ActionButton onClick={() => h.pinMessage(row.text)} label={t('chat.actions.pin')} icon={<MenuPinIcon />} />
            )}
            <ActionButton onClick={() => h.startForward(row.text, myNickname)} label={t('chat.actions.forward')} icon={<MenuForwardIcon />} />
            <ActionButton onClick={() => h.deleteForEveryone(row)} label={t('chat.actions.delete')} icon={<MenuTrashIcon />} danger />
          </ActionMenu>
        )}
        </AnimatePresence>
        <AnimatePresence>
          {showReactionPicker && (
            <motion.div
              key="rp"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.12 }}
              className={`absolute z-20 right-0 ${menuUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
            >
              <ReactionPicker
                uin={myUin}
                current={reactionsForTarget(row.id)?.get(myUin) ?? null}
                onPick={(asset) => h.toggleReaction(row.id, asset)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <button
        type="button"
        data-chat-menu
        onClick={(e) => h.toggleReactionPicker(row.id, e.currentTarget)}
        aria-label={t('chat.actions.react')}
        title={t('chat.actions.react')}
        className="self-center mr-1 order-first h-7 w-7 rounded-full bg-surface text-fg-dim opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex-none rcq-hover-only items-center justify-center"
      >
        <MenuReactIcon />
      </button>
    </li>
  )
})

/// Reporting somebody's message to the island's operators. One textarea and
/// the honest note about what rides along (the excerpt + the author's UIN) —
/// the same /reports channel the phones use for abuse reports.
function ReportMessageModal({
  targetUin,
  onClose,
  onSend,
}: {
  targetUin: number
  onClose: () => void
  /// Resolves when the report round-trip is done (ok or toast-ed error) —
  /// the button un-busies either way; success unmounts the modal above.
  onSend: (text: string) => Promise<void>
}) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-md sm:items-center"
      >
        <motion.div
          initial={{ y: 16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 16, opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md rounded-t-xl sm:rounded-xl bg-surface shadow-lg overflow-hidden"
        >
          <header className="flex items-center justify-between gap-2 px-4 py-3">
            <span className="text-sm font-semibold">{t('chat.report.title', { uin: String(targetUin) })}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="text-fg-secondary hover:text-fg-primary px-1"
            >
              ✕
            </button>
          </header>
          <div className="px-4 pb-4 space-y-3">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 600))}
              rows={4}
              autoFocus
              placeholder={t('chat.report.placeholder')}
              className="w-full rounded-md bg-field px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent resize-none"
            />
            <p className="text-xs text-fg-dim">{t('chat.report.hint')}</p>
            <button
              onClick={() => {
                if (busy || !text.trim()) return
                setBusy(true)
                void onSend(text).finally(() => setBusy(false))
              }}
              disabled={busy || !text.trim()}
              className="w-full h-10 rounded-md bg-accent text-sm font-semibold text-white hover:bg-accent-dim disabled:opacity-40 transition-colors"
            >
              {busy ? t('chat.report.sending') : t('chat.report.send')}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

/// One row of the message menu: icon, then label, full width.
///
/// It used to be a chip in a horizontal strip, which is the shape that does
/// not survive growth — seven actions made a bar wider than the message it
/// belonged to, and on a phone it ran off the edge. A column reads top to
/// bottom at any length, which is what every phone messenger settled on.
function ActionButton({ onClick, label, icon, danger }: { onClick: () => void; label: string; icon?: ReactNode; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 h-7 text-left text-[0.75rem] whitespace-nowrap transition-colors ${
        danger ? 'text-red-500 hover:bg-red-500/15' : 'text-fg-primary hover:bg-field'
      }`}
    >
      <span className={`w-3.5 h-3.5 shrink-0 inline-flex items-center justify-center ${danger ? '' : 'text-fg-dim'}`}>{icon}</span>
      {/* The labels are lowercase in every dictionary because they used to be
          rendered in a uppercase mono chip. `first-letter` rather than
          `capitalize`: "удалить у всех" must not become "Удалить У Всех". */}
      <span className="first-letter:uppercase">{label}</span>
    </button>
  )
}

// The message-menu glyphs. Same visual language as the contact menu on the
// home screen (Lucide-style, 1.8 stroke, currentColor): the menu used to mix
// emoji with lone unicode marks (☺ ↩ ⧉ 📌 ↗ 🗑 ⊘), and each of those rendered
// in the platform's own emoji or symbol font — a different weight, size and
// colour per OS, some of them in full colour on a menu that is otherwise
// monochrome (founder, 21.08).
function MenuIconSvg({ children }: { children: ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

function MenuReactIcon() {
  return (
    <MenuIconSvg>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </MenuIconSvg>
  )
}

function MenuReplyIcon() {
  return (
    <MenuIconSvg>
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </MenuIconSvg>
  )
}

function MenuCopyIcon() {
  return (
    <MenuIconSvg>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </MenuIconSvg>
  )
}

function MenuPinIcon() {
  return (
    <MenuIconSvg>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14l-1.5-3V6a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v8L5 17z" />
    </MenuIconSvg>
  )
}

function MenuForwardIcon() {
  return (
    <MenuIconSvg>
      <polyline points="15 14 20 9 15 4" />
      <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
    </MenuIconSvg>
  )
}

function MenuEditIcon() {
  return (
    <MenuIconSvg>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </MenuIconSvg>
  )
}

function MenuTrashIcon() {
  return (
    <MenuIconSvg>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </MenuIconSvg>
  )
}

/// Hide-here-only: an eye that is off, because the action's whole meaning is
/// "I stop seeing this" — the ⊘ it replaces read as "forbidden".
function MenuHideIcon() {
  return (
    <MenuIconSvg>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </MenuIconSvg>
  )
}

/// Arrow leaving a box — "open link" goes somewhere else.
function MenuLinkIcon() {
  return (
    <MenuIconSvg>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </MenuIconSvg>
  )
}

/// Down into the tray — the download that used to fire on the tap itself.
function MenuDownloadIcon() {
  return (
    <MenuIconSvg>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </MenuIconSvg>
  )
}

/// A flag — reporting the message to the island's operators.
function MenuFlagIcon() {
  return (
    <MenuIconSvg>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </MenuIconSvg>
  )
}

/// Roughly the tallest this menu gets (seven rows plus padding). Used to
/// decide which side of the bubble it opens on.
const MENU_ROOM_PX = 215
/// The reaction strip is one row of faces, so it needs far less.
const PICKER_ROOM_PX = 130

/// How much room a panel hanging off `el` actually has, in each direction.
///
/// ⚠⚠ Neither edge is the window's. The thread runs the full height of the
/// column and the two bars float OVER it — and they float over anything inside
/// it too, because a raised `<li>` still sits below them in the parent stacking
/// context. So a menu with 260px of window under it is drawn BEHIND the
/// composer and looks sliced off. That is what the founder screenshotted.
///
/// The usable floor is therefore the composer's top edge, and the usable
/// ceiling is the header's bottom edge. Both heights are already published as
/// CSS variables by the ResizeObserver that measures them.
function roomAround(el: HTMLElement | null | undefined): { below: number; above: number } {
  if (!el) return { below: 0, above: 0 }
  const pane = el.closest('main')
  const root = pane?.parentElement ?? null
  const cs = root ? getComputedStyle(root) : null
  const px = (name: string) => (cs ? parseFloat(cs.getPropertyValue(name)) || 0 : 0)
  const paneRect = pane ? pane.getBoundingClientRect() : null
  const floor = (paneRect ? paneRect.bottom : window.innerHeight) - px('--rcq-composer-h')
  const ceiling = (paneRect ? paneRect.top : 0) + px('--rcq-topbars-h')
  const rect = el.getBoundingClientRect()
  return { below: floor - rect.bottom, above: rect.top - ceiling }
}

/// Which way a panel of `need` pixels should open, and how tall it may be.
/// When neither side fits it takes the roomier one and scrolls inside itself —
/// a short scrollable menu beats a tall clipped one.
function placeMenu(el: HTMLElement | null | undefined, need: number): { up: boolean; max: number } {
  const { below, above } = roomAround(el)
  const up = below < need && above > below
  const room = Math.max(120, Math.floor((up ? above : below) - 8))
  return { up, max: Math.min(need, room) }
}

/// The menu itself. `align` follows the bubble (own messages are right-aligned,
/// so their menu hangs from the right edge); `up` flips it above the bubble
/// when there is no room below.
function ActionMenu({ align, up, max, children }: { align: 'start' | 'end'; up: boolean; max: number; children: ReactNode }) {
  return (
    <motion.div
      key="msg-actions"
      data-chat-menu
      initial={{ opacity: 0, scale: 0.96, y: up ? 4 : -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: up ? 4 : -4 }}
      transition={{ duration: 0.13, ease: 'easeOut' }}
      style={{
        transformOrigin: `${up ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}`,
        maxHeight: max,
      }}
      className={`absolute z-30 min-w-[7.5rem] overflow-y-auto no-scrollbar rounded-lg bg-surface py-0.5 shadow-xl ring-1 ring-line/50 ${
        align === 'end' ? 'right-0' : 'left-0'
      } ${up ? 'bottom-full mb-1' : 'top-full mt-1'}`}
    >
      {children}
    </motion.div>
  )
}

/// The handle that opens a bubble's menu when the bubble's own tap is already
/// spoken for.
///
/// A photo opens, a video plays, an invite card joins. All
/// of that is right, and all of it left the menu reachable only by right-click
/// or long-press, which is a gesture you either already know about or never
/// find: "непонятно как взаимодействовать с контентом (фото итд), я жму на него
/// и оно просто открывается, где же контекстное меню?" (founder, 21.08). The
/// press gestures are untouched; this is the same menu with something to aim at.
///
/// Two tones, because there are two kinds of thing underneath. `chrome` sits on
/// one of our own surfaces (a join card, a placeholder) and is a bare glyph: no fill,
/// no ring, nothing but the grey the rest of the secondary UI is drawn in. Note
/// `fg-secondary` and not `fg-dim`, which is the quieter of the two and what a
/// timestamp uses: against a light incoming bubble that one lands near 2:1,
/// and a handle whose entire job is to be noticed cannot be the faintest thing
/// on the bubble.
/// `over` sits on somebody's photograph, where a bare glyph is a coin toss
/// between a white sky and a night shot, so it gets a neutral dark disc and a
/// white mark. The contrast then comes from the button itself and depends on
/// neither the picture nor the theme. Literal black/white on purpose, not the
/// `ink-black` token: that one flips to near-white in the dark theme, which is
/// right for type and wrong for a scrim (a white mark on a white disc).
function BubbleMenuButton({
  tone,
  label,
  open,
  onOpen,
}: {
  tone: 'over' | 'chrome'
  label: string
  /// The menu for this row is up: hold the handle visible, or it vanishes the
  /// moment the pointer leaves the bubble for the menu it just opened.
  open: boolean
  onOpen: (anchor: HTMLElement) => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-open={open ? 'true' : undefined}
      // The bubble underneath is timing a long press. A press on THIS is
      // already the menu gesture, so it must not arm that timer as well and
      // toggle the menu straight back shut 450ms later.
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => {
        // Without this the click carries on into the photo and the lightbox
        // comes up underneath the menu.
        e.stopPropagation()
        e.preventDefault()
        const el = e.currentTarget
        // Anchor on the bubble, not on this 28px disc: placeMenu measures the
        // room BELOW its anchor, and the disc sits at the top of a picture that
        // can be sixteen rem tall. Measured from here, a menu that does not fit
        // would still be told to open downwards.
        onOpen((el.closest('[data-chat-menu]') as HTMLElement | null) ?? el)
      }}
      className={`rcq-bubble-menu absolute top-1.5 right-1.5 z-10 h-7 w-7 rounded-full flex items-center justify-center ${
        tone === 'over'
          ? 'bg-black/55 text-white hover:bg-black/75'
          : 'text-fg-secondary hover:text-fg-primary'
      }`}
    >
      <MoreIcon />
    </button>
  )
}

function MoreIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="19" cy="12" r="1.9" />
    </svg>
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

/// The island has it. A single tick — the peer has said nothing yet.
function TickMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden>
      <path d="M4 12.5l5 5L20 7" />
    </svg>
  )
}

/// Two ticks: a device of theirs has it ('delivered') — and on a green tint,
/// they have SEEN it ('read'). Fed by the peer's receipts (#636/#637); rows
/// from before receipts existed simply stay at one tick.
function DoubleTickMark() {
  return (
    <svg width="17" height="15" viewBox="0 0 28 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12.5l5 5L18 7" />
      <path d="M12.5 16l2 1.5L25 7" />
    </svg>
  )
}

/// The delivery ladder after the composer let go: sent -> delivered -> read.
/// 'sending' and 'failed' keep their own inline markup (clock / retry row).
function DeliveryMarks({ state }: { state: OutgoingRow['state'] }) {
  if (state === 'sent') return <TickMark />
  if (state === 'delivered') return <span className="text-accent"><DoubleTickMark /></span>
  if (state === 'read') {
    return (
      <span className="rounded bg-accent/25 px-0.5 text-accent">
        <DoubleTickMark />
      </span>
    )
  }
  return null
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

/// Placeholder bubble for a message this build does not render as itself.
///
/// Two different situations, one shape, because to the reader they are the same
/// thing, "there is a message here and you cannot see it here":
///   • a media kind the web still cannot draw (voice), which the phones can:
///     "open in the app".
///   • a kind that was REMOVED, which nothing will ever draw again. Polls
///     (founder item 14a) are the first. ⚠ This branch is why the poll kind was
///     not simply deleted: an old peer on an old build can still send one, and
///     a message that silently disappears is worse than one that says what it
///     was. Whatever else is cut later belongs here too.
function MediaPlaceholder({ mediaKind }: { mediaKind?: string }) {
  const { t } = useI18n()
  const retired = mediaKind === 'poll'
  const icon =
    mediaKind === 'video' ? '🎬' :
    mediaKind === 'voice' ? '🎤' :
    mediaKind === 'location' ? '📍' :
    retired ? '📊' : '📎'
  const label = mediaKind ? t(`chat.media.kind.${mediaKind}`) : t('chat.media.kind.file')
  // `pr-9` leaves the top-right corner to the ⋯ handle: this bubble is sized to
  // a two-word label, so without the gap the handle would sit on top of it.
  return (
    <div className="rounded-lg py-2 pl-3 pr-9 bg-bubble-other rcq-selectable">
      <div className="text-sm">{icon} {label}</div>
      <div className="text-[0.625rem] text-fg-dim">
        {t(retired ? 'chat.media.retired' : 'chat.media.in_app_only')}
      </div>
    </div>
  )
}

/// Group pinned announcement (#4 — web showed no pin at all). Collapsed to a
/// single truncated line; tapping expands it into a FIXED-height scrollable box
/// (#5 — a long pin must not push the whole chat down / become unscrollable).
/// One-line collapsed preview. Links are KEPT: stripping them meant a pin
/// like "Запуск своего релея: <ссылка>" showed no trace of the link until
/// expanded (megalist B9, founder). The bar truncates, which is all the
/// protection a long URL needs.
function pinPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/// The pinned message: a one-line bar under the header, and the whole text in
/// a bounded dialog when you tap it.
///
/// It used to unfold in place, `max-h-96` hanging off the bar. On a desktop
/// that root is 17.5px, so those 24rem were 420px before the font-size knob and
/// 546px at its largest step, in a column up to 955px wide — a slab covering
/// most of the conversation, which is the "открывается на весь экран" in the
/// report. A dialog capped at `80vh` cannot outgrow the window whatever the
/// text size, and it is the same surface every other overlay in the app uses.
function PinnedBanner({ text, group, expanded, onToggle, linksAllowed = true }: { text: string; group: RCQGroup; expanded: boolean; onToggle: () => void; linksAllowed?: boolean }) {
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
          {/* A pin made only of invite links strips to nothing, and the bar
              then read as an icon and a chevron with a blank between them. */}
          <div className="flex-1 min-w-0 truncate text-[0.8125rem] text-fg-secondary">
            {pinPreview(text) || t('chat.pin.title')}
          </div>
          <span className="text-fg-dim text-xs shrink-0">›</span>
        </button>
      </div>
      {/* ⚠ Through a portal, and this is not decoration. `.rcq-floating-bar`
          carries `backdrop-filter`, and per Filter Effects a backdrop-filtered
          element becomes the CONTAINING BLOCK for `position: fixed`
          descendants — so a `fixed inset-0` child of this 39px bar is a 39px
          strip, and the panel hangs off it instead of covering the window.
          Measured: the overlay came out 1100x39, and the card's top landed 140
          to 421px ABOVE the viewport with its close button out of reach. The
          same trap waits for anything fixed added to the composer or the
          search strip, which use the same class. */}
      {createPortal(
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="pin-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onToggle}
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-md sm:items-center"
          >
            <motion.div
              initial={{ y: 16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 16, opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md max-h-[80vh] flex flex-col rounded-t-xl sm:rounded-xl bg-surface shadow-lg overflow-hidden"
            >
              <header className="flex items-center justify-between gap-2 px-4 py-3">
                <div className="flex items-center gap-2 min-w-0">
                  <PinIcon />
                  <span className="truncate text-sm font-semibold">{t('chat.pin.title')}</span>
                </div>
                <button
                  type="button"
                  onClick={onToggle}
                  aria-label={t('common.close')}
                  className="text-fg-secondary hover:text-fg-primary px-1"
                >
                  ✕
                </button>
              </header>
              <div className="flex-1 overflow-y-auto px-4 pb-4 text-[0.8125rem] text-fg-secondary">
                <PinnedRichText text={text} group={group} linksAllowed={linksAllowed} />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body,
      )}
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

/// Two people — "hand this group to someone" in the attach menu.
function GroupInviteIcon() {
  return (
    <svg className="text-fg-secondary shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

/// A clock: the disappearing-message timer, in the attach menu and beside any
/// message that carries one. Same vocabulary as iOS (`Image(systemName:
/// "clock")` in `MessageRow.metaRow`), so a thread with a timer on it reads the
/// same on a phone and on a desktop.
function ClockIcon({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`shrink-0 ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  )
}

/// The clock that sits in a message's meta line while that message is on its
/// way out, with what is left of it printed beside it and repeated as the
/// tooltip.
///
/// ⚠ Wall-clock time is the one thing no prop can carry. The rows are memoised
/// (see the note above them) and every other input has a carrier (text, edits,
/// receipts, reactions, deletion), so a bubble painted once went on printing
/// "24h" for a whole day and then disappeared without warning. The tick lives
/// HERE, in the leaf, where it repaints the clock and nothing else: the
/// memoised bubble around it never re-renders, which is exactly the work item
/// 30b paid for. Coarse on purpose, `SWEEP_INTERVAL_MS`: that is also how long
/// a row can outlive its deadline, so a finer clock would print a precision the
/// sweeper does not have.
function ExpiryMark({ expiresAt, t }: { expiresAt: number; t: Translate }) {
  const [, retick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => retick((n) => n + 1), SWEEP_INTERVAL_MS)
    return () => clearInterval(iv)
  }, [expiresAt])
  const left = remainingLabel(expiresAt)
  return (
    <span
      className="inline-flex items-center gap-0.5 text-fg-dim"
      title={t('chat.ttl.remaining', { time: left })}
      aria-label={t('chat.ttl.remaining', { time: left })}
    >
      <ClockIcon size={10} />
      <span className="tabular-nums">{left}</span>
    </span>
  )
}

/// Renders the pinned announcement the way the native apps do (#pin-native):
/// group-invite links become join CARDS, #UIN mentions become clickable nicks,
/// plain URLs become clickable links, everything else is plain text. Whitespace
/// preserved so multi-line pins keep their shape.
function PinnedRichText({ text, group, linksAllowed = true }: { text: string; group: RCQGroup; linksAllowed?: boolean }) {
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
      const inv = linksAllowed ? parseGroupInvite(m[1]) : null
      if (inv != null) {
        // Slim row, not the message-bubble card: a pin often IS a list of
        // invites, and three cards with their own Join buttons were the "too
        // big" half of the report. Same shape the phones use here.
        nodes.push(<div key={key++} className="my-1.5"><GroupJoinCard groupId={inv.id} host={inv.host} compact /></div>)
      } else {
        pushText(m[0])
      }
    } else if (m[2]) {
      // Links-off rooms keep even the pin's URLs literal — one rule, no
      // side door through the banner.
      if (linksAllowed) {
        nodes.push(
          <a key={key++} href={m[2]} target="_blank" rel="noreferrer" className="text-accent hover:underline break-all">{m[2]}</a>,
        )
      } else {
        pushText(m[2])
      }
    } else if (m[3]) {
      const uin = Number(m[3])
      const nick = contactAlias(uin) ?? group.members.find((x) => x.uin === uin)?.nickname
      nodes.push(
        <Link key={key++} to={`/profile/${uin}`} className="text-accent hover:text-accent-dim transition-colors">{nick ?? `#${uin}`}</Link>,
      )
    }
  }
  pushText(text.slice(last))
  return <div className="whitespace-pre-wrap break-words">{nodes}</div>
}

/// Direction arrow for a call row: down-left for incoming, up-right for
/// outgoing, red when nobody picked up. Same vocabulary the phones use.
function CallLogIcon({ missed, outgoing }: { missed: boolean; outgoing: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={missed ? 'text-red-500' : 'text-fg-dim'}
    >
      {outgoing ? (
        <>
          <line x1="7" y1="17" x2="17" y2="7" />
          <polyline points="9 7 17 7 17 15" />
        </>
      ) : (
        <>
          <line x1="17" y1="7" x2="7" y2="17" />
          <polyline points="15 17 7 17 7 9" />
        </>
      )}
    </svg>
  )
}


/// The chat-header subtitle for an offline 1:1 peer (megalist B1): crossfades
/// between `#uin` and the humanised last-seen every few seconds, the port of
/// the iOS `peerSubtitle`. Both children stay mounted in one grid cell so the
/// line's box never changes size mid-swap and the nickname above holds still.
function AltSubtitle({ uin, lastSeen }: { uin: number; lastSeen: string }) {
  const [alt, setAlt] = useState(false)
  useEffect(() => {
    const id = setInterval(() => setAlt((v) => !v), 4000)
    return () => clearInterval(id)
  }, [])
  return (
    <span className="grid">
      <span
        className="col-start-1 row-start-1 transition-opacity duration-500"
        style={{ opacity: alt ? 0 : 1 }}
      >
        #{uin}
      </span>
      <span
        className="col-start-1 row-start-1 truncate transition-opacity duration-500"
        style={{ opacity: alt ? 1 : 0 }}
      >
        {lastSeen}
      </span>
    </span>
  )
}


function SearchGlyph({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-fg-secondary flex-none">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}


function MicGlyph() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-fg-secondary">
      <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  )
}
