// Blocking somebody who is not on this island.
//
// The roster carries a `blocked` flag and the island honours it for contact
// requests and group adds, but a MESSAGE arrives sealed: the island cannot see
// who sent it, so only the receiving client can drop it (see receive.ts). That
// works for peers on our own island, whose rows we have.
//
// It does not work for a cross-island peer. There is no roster row for them,
// so there is nothing to carry a flag, and `/block 500` on a person who lives
// on another island did nothing at all: the command reported success (the
// island happily stored a flag on a row that no incoming message consults) and
// their messages kept arriving. This file is the missing half — a local list,
// keyed by uin AND host, consulted on ingest.
//
// ⚠ Local by design, not by omission. Their island has no reason to believe
// us, ours has no say over theirs, and the block is only ever enforced where
// the key is. That also means it does not follow you to another device: the
// phones keep their own list, and syncing it would put "who I refuse to hear
// from" into the vault, which is precisely the shape of metadata this project
// spends its time removing.

import { readState, writeState } from './state'

type Blocked = Record<string, { at: string }>

function fileFor(myUin: number): string {
  return `blocked-cross-${myUin}.json`
}

function key(uin: number, host: string): string {
  return `${uin}@${host.toLowerCase()}`
}

function load(myUin: number): Blocked {
  try {
    const text = readState(fileFor(myUin))
    return text ? (JSON.parse(text) as Blocked) : {}
  } catch (e) {
    if (e instanceof Error && /sealed/.test(e.message)) throw e
    return {}
  }
}

export function isCrossBlocked(myUin: number, uin: number, host: string | undefined): boolean {
  if (!host) return false
  return key(uin, host) in load(myUin)
}

/// Returns false when nothing changed (already in that state), so the command
/// can say so rather than claiming an action it did not take.
export function setCrossBlocked(myUin: number, uin: number, host: string, on: boolean): boolean {
  const all = load(myUin)
  const k = key(uin, host)
  if (on === k in all) return false
  if (on) all[k] = { at: new Date().toISOString() }
  else delete all[k]
  writeState(fileFor(myUin), JSON.stringify(all, null, 1))
  return true
}

/// Everyone this account refuses to hear from off-island, for `rcq contacts`
/// and for the block listing.
export function crossBlockedList(myUin: number): Array<{ uin: number; host: string; at: string }> {
  return Object.entries(load(myUin)).flatMap(([k, v]) => {
    const at = k.lastIndexOf('@')
    const uin = Number(k.slice(0, at))
    const host = k.slice(at + 1)
    return Number.isInteger(uin) && host ? [{ uin, host, at: v.at }] : []
  })
}
