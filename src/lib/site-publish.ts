// Publishing a `.rcq` site from the app.
//
// The signature is made HERE, with the account's own Ed25519 key, over a
// manifest that names every file by its hash. The island receives bytes that
// are already signed and can only refuse them, never alter them - which is the
// same shape as everything else we send it, and the reason a reader can pin a
// site's key at all (lib/sites verifies the other end of this).

import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToB64 } from './crypto'
import type { WebIdentity } from './crypto'
import { canonicalJSON } from './federation'

export interface MySite {
  name: string
  owner_uin: number
  version: number
  title: string | null
  size_bytes: number
  listed: boolean
  frozen: boolean
  updated_at: string
}

/// What the island refuses with, in the words the screen turns into a
/// sentence. `too_large` and `bad_type` carry the offending file.
export interface PublishError {
  code: string
  file?: string
  max?: number
}

export const SITE_LIMITS = {
  maxFiles: 64,
  maxFileBytes: 5 * 1024 * 1024,
  maxBundleBytes: 20 * 1024 * 1024,
  /// Everything the island will serve. No fonts (an outside font is a
  /// fingerprint), no scripts, no video (that traffic is somebody's relay).
  types: ['.html', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.txt', '.json'],
}

/// What a bundle may call its mark, in the order a client looks for it. The
/// name goes INTO the manifest, so it is covered by the owner's signature: a
/// mark is how a site is recognised in a list, and an island that could choose
/// it could dress one site up as another.
export const ICON_NAMES = ['icon.svg', 'icon.png', 'icon.webp', 'favicon.png', 'favicon.svg']

/// Which of the picked files is the site's mark, if any.
export function pickIcon(paths: string[]): string | null {
  return ICON_NAMES.find((n) => paths.includes(n)) ?? null
}

export function isAllowedFile(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot > 0 && SITE_LIMITS.types.includes(path.slice(dot).toLowerCase())
}

/// The path a file takes inside the bundle. A folder pick gives every file the
/// folder's own name in front; the site's root is what the person chose, not
/// where it happened to live on their disk, so the shared first segment goes.
export function bundlePaths(files: File[]): string[] {
  const raw = files.map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name)
  const segments = raw.map((p) => p.split('/').filter(Boolean))
  const first = segments[0]?.[0]
  const shared = segments.length > 0 && segments.every((s) => s.length > 1 && s[0] === first)
  return segments.map((s) => (shared ? s.slice(1) : s).join('/'))
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function mySites(identity: WebIdentity): Promise<MySite[]> {
  const res = await fetch(`${identity.apiBase}/sites/mine`, {
    headers: { Authorization: `Bearer ${identity.jwt}` },
  })
  if (!res.ok) return []
  return (await res.json()) as MySite[]
}

/// Is this name free on my island? "invalid" also covers the names the router
/// itself answers to, so the screen never offers one that could not open.
export async function checkName(identity: WebIdentity, name: string): Promise<'free' | 'taken' | 'invalid'> {
  const res = await fetch(`${identity.apiBase}/sites/available/${encodeURIComponent(name)}`)
  if (!res.ok) return 'invalid'
  const out = (await res.json()) as { available: boolean; reason: string | null }
  if (out.available) return 'free'
  return out.reason === 'invalid' ? 'invalid' : 'taken'
}

export async function publishSite(
  identity: WebIdentity,
  opts: { name: string; files: File[]; title?: string; listed: boolean },
): Promise<MySite> {
  const paths = bundlePaths(opts.files)
  const bodies = await Promise.all(opts.files.map(async (f) => new Uint8Array(await f.arrayBuffer())))

  const manifest: Record<string, unknown> = {
    v: 1,
    name: opts.name,
    // The island decides the version - it is the one holding the previous one.
    // Ours is a claim it will overwrite, and the signature covers whatever it
    // ends up serving because the whole manifest is stored verbatim.
    version: 1,
    key: bytesToB64(identity.signingPub),
    files: Object.fromEntries(paths.map((p, i) => [p, hex(sha256(bodies[i]))])),
  }
  if (opts.title?.trim()) manifest.title = opts.title.trim()
  const icon = pickIcon(paths)
  if (icon) manifest.icon = icon
  const sig = ed25519.sign(new TextEncoder().encode(canonicalJSON(manifest)), identity.signingPriv)

  const form = new FormData()
  form.append('manifest', canonicalJSON({ ...manifest, sig: bytesToB64(sig) }))
  form.append('owner_key', bytesToB64(identity.signingPub))
  if (opts.title?.trim()) form.append('title', opts.title.trim())
  form.append('listed', opts.listed ? 'true' : 'false')
  paths.forEach((p, i) => {
    // The path is the FILENAME part of the multipart field: that is what the
    // island writes into the bundle, and what the manifest hashed.
    form.append('files', new Blob([bodies[i] as unknown as BlobPart]), p)
  })

  const res = await fetch(`${identity.apiBase}/sites/${encodeURIComponent(opts.name)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${identity.jwt}` },
    body: form,
  })
  if (!res.ok) {
    let detail: PublishError = { code: 'failed' }
    try {
      const body = (await res.json()) as { detail?: PublishError | string }
      if (body.detail && typeof body.detail === 'object') detail = body.detail
    } catch { /* a proxy error page, not ours */ }
    throw Object.assign(new Error(detail.code), detail)
  }
  return (await res.json()) as MySite
}

export async function deleteSite(identity: WebIdentity, name: string): Promise<boolean> {
  const res = await fetch(`${identity.apiBase}/sites/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${identity.jwt}` },
  })
  return res.ok
}
