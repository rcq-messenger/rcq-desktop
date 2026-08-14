/// Whether calls must ride the relay, and why the default is on.
///
/// ⚠ WebRTC opens its own sockets, outside everything else this app routes. A
/// direct call therefore hands the other side your real address before a word
/// is spoken, and no privacy setting elsewhere can prevent it. Relaying costs
/// bandwidth and a little latency; being findable costs more.
///
/// ★ It became a SETTING because it was previously forced, silently: the web
/// and desktop clients demanded relay-only whenever a relay could be reached,
/// with no way to trade the address for a better line. The phones have had the
/// choice since 0.108 and this is the same one, worded the same way.
///
/// Device-local (not per account, not on the island): it is a property of the
/// machine you are calling from.
const KEY = 'rcq.call.alwaysRelay'

export function alwaysRelay(): boolean {
  // Default ON, so a fresh browser is private before anyone touches settings.
  return localStorage.getItem(KEY) !== '0'
}

export function setAlwaysRelay(on: boolean): void {
  localStorage.setItem(KEY, on ? '1' : '0')
}
