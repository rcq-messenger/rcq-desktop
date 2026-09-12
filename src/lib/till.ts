// The till: the only part of RCQ that knows what money is.
//
// It is deliberately NOT the island. The island holds the numbers and has no
// wallet, no price list and no way to be paid; this service watches the
// operator's own wallets through public block explorers and, when a transfer
// lands, signs a document saying "number N was paid for". The buyer carries
// that document from one to the other. Neither half ever learns the other's:
// the till never sees an account or a token, the island never sees a chain, an
// amount or an address.
//
// ⚠ No credentials of any kind go here, and none come back that are worth
// anything to anyone but the buyer. The invoice id IS the secret - whoever
// holds it can read the voucher - so it is kept in this browser and nowhere
// else, and the page stores it the moment an invoice is created rather than
// when the payment lands: an invoice you cannot find again is money you cannot
// account for.

/// The checkout compiled in, used only when an island does not name its own.
///
/// ⚠⚠ It serves ONE island — ours. Paying it for a number on somebody else's
/// island puts real money where the number is not, and there is no way back.
/// So every call takes the address from the quote (`checkout_url`) when there
/// is one, and this constant is the flagship's own address, kept for islands
/// too old to send the field.
const BUILT_IN_TILL = 'https://console-api.rcq.app'

function base(checkoutUrl?: string | null): string {
  const named = (checkoutUrl ?? '').trim().replace(/\/+$/, '')
  return named || BUILT_IN_TILL
}

export interface TillPrices {
  prices_cents: Record<string, number>
  chains: { id: string; label: string; confirmations: number }[]
}

export interface UinInvoice {
  id: string
  uin: number
  chain: string
  chain_label: string
  address: string
  amount: string
  usd: number
  confirmations: number
  expires_at: number
  status: 'pending' | 'expired' | 'paid' | 'late'
  paid_at?: number | null
  voucher?: string | null
}

export class TillError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

/// What entry to an island costs and which chains its till takes for it.
/// `price_cents: 0` is "not on sale": no island answering the till, or no
/// price set by its operator.
export interface EntryQuote {
  host: string
  price_cents: number
  chains: { id: string; label: string; confirmations: number }[]
}

/// An invoice for ENTRY (residency) rather than a number. Same shape as
/// `UinInvoice` minus the number plus the island it is for; the voucher it
/// ends in is redeemed at registration or, for an account already here, at
/// `POST /residency/redeem`.
export interface EntryInvoice {
  id: string
  host: string
  chain: string
  chain_label: string
  address: string
  amount: string
  usd: number
  confirmations: number
  expires_at: number
  status: 'pending' | 'expired' | 'paid' | 'late'
  paid_at?: number | null
  voucher?: string | null
}

/// The till for ENTRY, and only the one the island named. ⚠⚠ NO FALLBACK,
/// unlike `base()` above: numbers needed the built-in for islands too old to
/// name a till, and it took a header (`X-RCQ-Checkout`) to keep that from
/// sending a self-hoster's customer to pay us. Entry was born after islands
/// could name their till, so an island that names none simply sells nothing
/// in the app, and a caller with an empty address gets a refusal here rather
/// than an invoice from the wrong till.
function entryBase(tillUrl: string): string {
  const named = (tillUrl ?? '').trim().replace(/\/+$/, '')
  if (!/^https:\/\//i.test(named)) throw new TillError('no_till')
  return named
}

async function call<T>(path: string, init?: RequestInit, checkoutUrl?: string | null): Promise<T> {
  let r: Response
  try {
    r = await fetch(`${base(checkoutUrl)}${path}`, init)
  } catch {
    // A blocked or unreachable till is a different problem from a refused
    // sale, and saying so is the difference between "try again" and "this
    // number is gone".
    throw new TillError('till_unreachable')
  }
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new TillError(String((body as { error?: string })?.error ?? `http_${r.status}`))
  return body as T
}

export const Till = {
  prices(checkoutUrl?: string | null): Promise<TillPrices> {
    return call<TillPrices>('/v1/uin/prices', undefined, checkoutUrl)
  },

  /// Reserve a number and quote an exact amount for it.
  ///
  /// ⚠ The amount is exact to the last digit on purpose: it is what tells this
  /// payment from every other one. Rounding it, or sending it twice, is the
  /// one way to pay and not be recognised.
  createInvoice(uin: number, chain: string, checkoutUrl?: string | null): Promise<UinInvoice> {
    return call<UinInvoice>('/v1/uin/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uin, chain }),
    }, checkoutUrl)
  },

  /// ⚠ Takes the same address the invoice was created against. An invoice id
  /// only exists at the till that issued it; asking a different one returns a
  /// confident "no such invoice" for a payment that is really in flight.
  invoice(id: string, checkoutUrl?: string | null): Promise<UinInvoice> {
    return call<UinInvoice>(`/v1/uin/invoice/${encodeURIComponent(id)}`, undefined, checkoutUrl)
  },

  // ── entry (residency), at the island's OWN till and nowhere else ──

  /// The price the ISLAND publishes and the chains its operator takes; the
  /// till asks the island, signed, and keeps the answer a minute.
  entryQuote(host: string, tillUrl: string): Promise<EntryQuote> {
    return call<EntryQuote>(`/v1/entry/quote?host=${encodeURIComponent(host)}`, undefined, entryBase(tillUrl))
  },

  /// Write an invoice for entry to `host`. The address on it is the island
  /// operator's wallet, handed to the till per invoice by the island itself.
  createEntryInvoice(host: string, chain: string, tillUrl: string): Promise<EntryInvoice> {
    return call<EntryInvoice>('/v1/entry/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host, chain }),
    }, entryBase(tillUrl))
  },

  entryInvoice(id: string, tillUrl: string): Promise<EntryInvoice> {
    return call<EntryInvoice>(`/v1/entry/invoice/${encodeURIComponent(id)}`, undefined, entryBase(tillUrl))
  },
}

/// Invoices this browser has opened, newest first.
///
/// Kept so a page reloaded mid-payment (or opened tomorrow) can still find the
/// voucher somebody has already paid for. Nothing here is secret to the island
/// or to the till; it is secret to whoever sits at this browser, which is why
/// it never leaves it.
const KEY = 'rcq.web.uin.invoices'

export interface StoredInvoice {
  id: string
  uin: number
  chain: string
  created_at: number
  /// ⚠⚠ WHICH till issued it. An invoice id only exists at the till that made
  /// it, so a payment resumed against a different one comes back "no such
  /// invoice" while real money is in flight. Absent on rows written before
  /// islands could name their own, and those were all ours.
  checkoutUrl?: string | null
}

export function rememberInvoice(inv: UinInvoice, checkoutUrl?: string | null): void {
  try {
    const all = listInvoices().filter((i) => i.id !== inv.id)
    all.unshift({
      id: inv.id, uin: inv.uin, chain: inv.chain, created_at: Date.now(),
      checkoutUrl: checkoutUrl ?? null,
    })
    localStorage.setItem(KEY, JSON.stringify(all.slice(0, 20)))
  } catch {
    // A browser with storage switched off can still buy a number; it just
    // cannot recover the voucher after a reload. Not a reason to refuse.
  }
}

export function listInvoices(): StoredInvoice[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? (raw as StoredInvoice[]) : []
  } catch {
    return []
  }
}

export function forgetInvoice(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(listInvoices().filter((i) => i.id !== id)))
  } catch {
    /* see rememberInvoice */
  }
}

/// Entry invoices this browser has opened, newest first: their OWN key.
///
/// ⚠ Not the number list above. The Market sweep polls every stored id
/// through the number endpoint and redeems what it finds paid as a number;
/// an entry invoice in that list would come back "no such invoice" from the
/// till and, worse, be dropped. The create form and the residency row sweep
/// this list for the island they are on.
const ENTRY_KEY = 'rcq.web.entry.invoices'

export interface StoredEntryInvoice {
  id: string
  host: string
  chain: string
  created_at: number
  /// Which till issued it: an invoice id only exists at the till that made it.
  tillUrl: string
}

export function rememberEntryInvoice(inv: EntryInvoice, tillUrl: string): void {
  try {
    const all = listEntryInvoices().filter((i) => i.id !== inv.id)
    all.unshift({ id: inv.id, host: inv.host, chain: inv.chain, created_at: Date.now(), tillUrl })
    localStorage.setItem(ENTRY_KEY, JSON.stringify(all.slice(0, 20)))
  } catch {
    /* see rememberInvoice */
  }
}

export function listEntryInvoices(): StoredEntryInvoice[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ENTRY_KEY) || '[]')
    return Array.isArray(raw) ? (raw as StoredEntryInvoice[]) : []
  } catch {
    return []
  }
}

export function forgetEntryInvoice(id: string): void {
  try {
    localStorage.setItem(ENTRY_KEY, JSON.stringify(listEntryInvoices().filter((i) => i.id !== id)))
  } catch {
    /* see rememberInvoice */
  }
}
