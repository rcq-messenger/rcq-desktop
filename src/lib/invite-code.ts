/// What somebody actually pasted into a field that asks for an access code.
///
/// ⚠⚠ THE APPS HAND OUT A LINK AND THEN ASK FOR A CODE. The invite sheet shows
/// `rcq://server/<host>?invite=<code>` with a "copy the link" button, and the
/// join field is labelled "access code" and takes nothing but the code itself.
/// The island then answers "already used, expired, or meant for another
/// island", which is three wrong guesses at once. It cost us the first person a
/// paying resident ever invited (#1034): he pasted exactly what the app gave
/// him.
///
/// Same rule as Android's `data/InviteCode.kt`, deliberately: two doors into
/// one island should not disagree about what a code is.
const MAX = 512

/// The code inside `input`, or the trimmed input when there is no link in it.
/// Null for nothing usable, so a caller can keep its button disabled.
export function inviteCodeOf(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim().slice(0, MAX)
  if (!raw) return null
  const marker = raw.toLowerCase().indexOf('invite=')
  // ⚠ Only the wrappers a paste carries, never "any punctuation": an
  // operator's own code may legitimately start with one, a quote cannot.
  const body = (marker >= 0 ? raw.slice(marker + 'invite='.length) : raw).replace(/^["'([{<«]+/, '')
  // A query parameter ends at the next separator; a pasted line may also carry
  // whitespace or a quote from wherever it was copied.
  const cut = body.search(/[&#\s"'<]/)
  const code = (cut >= 0 ? body.slice(0, cut) : body).replace(/[.,)\]};:]+$/, '')
  if (!code) return null
  try {
    return decodeURIComponent(code) || null
  } catch {
    return code
  }
}

/// True when the input carries a link rather than a bare code, so a screen can
/// say so instead of silently changing what somebody typed.
export function looksLikeInviteLink(input: string | null | undefined): boolean {
  const raw = (input ?? '').trim().toLowerCase()
  return raw.includes('invite=') || raw.startsWith('rcq://') ||
    raw.startsWith('http://') || raw.startsWith('https://')
}
