// The order of a burn from the settings screen (spec 2026-09-15, F2), as a
// small controller the screen drives and the offline test can run.
//
// The sequence: the copies on other islands (burn-cascade.ts `runRemote`),
// then, if any island failed, a decision by the person (try again, burn
// anyway, cancel), then the account at home with one retry, then the local
// wipe. Everything that touches the network, a store or the page is a hook, so
// cli/test/burn-cascade.mjs proves the order itself: the keys and stores are
// still there when the home delete starts, a home failure wipes nothing, our
// own `account_burned` during the home delete does not sign out, and the
// same-key accounts go with the wipe.
//
// ⚠⚠ The module flags in burn-cascade.ts live exactly as long as this flow.
// They pause the drains, the pending poll and new guest registrations, and one
// of them silences `account_burned`. A flag left on after the screen is gone
// would keep all of that stopped until a reload, so every way out of the flow
// clears them: cancel, a failed home delete, and `detach` (the screen
// unmounting) whenever no delete is still in flight.

import {
  burnResultOk,
  setBurning,
  setDeletingHome,
  type BurnTarget,
  type IslandBurnResult,
} from './burn-cascade'

export type BurnStage = 'idle' | 'working' | 'failures' | 'home' | 'done'
export type BurnRows = Array<[string, IslandBurnResult]>

/// How one home delete ended. `retryable` for what a second try can fix (the
/// network, a 5xx, a 429); a refusal says the same thing twice.
export type HomeDeleteAnswer = { ok: true } | { ok: false; retryable: boolean }

export interface BurnFlowPlan<K> {
  targets: BurnTarget<K>[]
  siblings: Array<{ uin: number }>
}

export interface BurnFlowHooks<K> {
  runRemote(targets: BurnTarget<K>[]): Promise<Map<string, IslandBurnResult>>
  /// `DELETE /auth/account` at home. May throw; a throw counts as retryable.
  deleteHome(): Promise<HomeDeleteAnswer>
  /// The local wipe and sign-out, with the same-key accounts dropped first.
  /// Called once, and only after the home delete succeeded.
  finish(siblingUins: number[], rows: BurnRows): void
  /// The account stays, and these islands no longer hold a copy of it
  /// (confirmed deletion, or none there): forget them locally, so a later
  /// join registers a fresh copy and the home record stops naming a dead
  /// backup.
  forgetCopies(hosts: string[]): void
  onChange(stage: BurnStage, rows: BurnRows): void
  /// The person cancelled, or left the screen at the failure list.
  /// `deletedHosts` are the islands that confirmed a deletion.
  onCancelled?(deletedHosts: string[]): void
  onHomeFailed?(remoteDeleted: boolean): void
}

export interface BurnFlow {
  start(): Promise<void>
  retry(): Promise<void>
  anyway(): Promise<void>
  cancel(): void
  /// The screen is gone. Ends the flow now if nothing is in flight; a remote
  /// phase still running ends at its failure list; a home delete in flight
  /// finishes on its own (a reload, or flags off on failure).
  detach(): void
  stage(): BurnStage
  rows(): BurnRows
}

const HOME_ATTEMPTS = 2

export function createBurnFlow<K>(plan: BurnFlowPlan<K>, hooks: BurnFlowHooks<K>): BurnFlow {
  let stage: BurnStage = 'idle'
  let rows: BurnRows = []
  let detached = false
  let over = false

  const set = (s: BurnStage, r: BurnRows = rows) => {
    stage = s
    rows = r
    hooks.onChange(stage, rows)
  }
  const goneHosts = () => rows.filter(([, r]) => burnResultOk(r)).map(([h]) => h)
  const confirmedHosts = () => rows.filter(([, r]) => r.kind === 'confirmed').map(([h]) => h)

  const end = () => {
    over = true
    setBurning(false)
    const gone = goneHosts()
    if (gone.length > 0) hooks.forgetCopies(gone)
    set('idle', [])
  }

  const stopAtFailures = () => {
    const deleted = confirmedHosts()
    end()
    hooks.onCancelled?.(deleted)
  }

  const afterRemote = async () => {
    if (over) return
    if (rows.some(([, r]) => !burnResultOk(r))) {
      if (detached) {
        stopAtFailures()
        return
      }
      set('failures')
      return
    }
    await home()
  }

  const home = async () => {
    set('home')
    setDeletingHome(true)
    let ok = false
    for (let attempt = 0; attempt < HOME_ATTEMPTS && !ok; attempt++) {
      let ans: HomeDeleteAnswer
      try {
        ans = await hooks.deleteHome()
      } catch {
        ans = { ok: false, retryable: true }
      }
      if (ans.ok) ok = true
      else if (!ans.retryable) break
    }
    if (!ok) {
      setDeletingHome(false)
      const remoteDeleted = confirmedHosts().length > 0
      end()
      hooks.onHomeFailed?.(remoteDeleted)
      return
    }
    set('done')
    hooks.finish(
      plan.siblings.map((s) => s.uin),
      rows,
    )
  }

  return {
    async start() {
      if (stage !== 'idle' || over) return
      setBurning(true)
      if (plan.targets.length === 0) {
        await home()
        return
      }
      set('working', plan.targets.map((t): [string, IslandBurnResult] => [t.host, { kind: 'not_tried' }]))
      const got = await hooks.runRemote(plan.targets)
      rows = plan.targets.map((t): [string, IslandBurnResult] => [t.host, got.get(t.host) ?? { kind: 'not_tried' }])
      await afterRemote()
    },
    async retry() {
      if (stage !== 'failures' || over) return
      const failedHosts = new Set(rows.filter(([, r]) => !burnResultOk(r)).map(([h]) => h))
      set('working')
      const again = await hooks.runRemote(plan.targets.filter((t) => failedHosts.has(t.host)))
      rows = rows.map(([h, r]): [string, IslandBurnResult] => [h, again.get(h) ?? r])
      await afterRemote()
    },
    async anyway() {
      if (stage !== 'failures' || over) return
      await home()
    },
    cancel() {
      if (stage !== 'failures' || over) return
      stopAtFailures()
    },
    detach() {
      detached = true
      if (over) return
      if (stage === 'failures') stopAtFailures()
      else if (stage === 'idle') setBurning(false)
    },
    stage: () => stage,
    rows: () => rows,
  }
}
