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

const TILL = 'https://console-api.rcq.app'

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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response
  try {
    r = await fetch(`${TILL}${path}`, init)
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
  prices(): Promise<TillPrices> {
    return call<TillPrices>('/v1/uin/prices')
  },

  /// Reserve a number and quote an exact amount for it.
  ///
  /// ⚠ The amount is exact to the last digit on purpose: it is what tells this
  /// payment from every other one. Rounding it, or sending it twice, is the
  /// one way to pay and not be recognised.
  createInvoice(uin: number, chain: string): Promise<UinInvoice> {
    return call<UinInvoice>('/v1/uin/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uin, chain }),
    })
  },

  invoice(id: string): Promise<UinInvoice> {
    return call<UinInvoice>(`/v1/uin/invoice/${encodeURIComponent(id)}`)
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
}

export function rememberInvoice(inv: UinInvoice): void {
  try {
    const all = listInvoices().filter((i) => i.id !== inv.id)
    all.unshift({ id: inv.id, uin: inv.uin, chain: inv.chain, created_at: Date.now() })
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
