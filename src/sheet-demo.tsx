// TEMPORARY visual harness for the share-group sheet and its entry point. Not
// wired into the app; delete after screenshotting.
//
// It used to stub the poll endpoints too. Polls were cut on 2026-08-23 (founder
// item 14a) and `Api.createPoll` / `loadPoll` / `votePoll` no longer exist, so
// those three stubs went with them.

import ReactDOM from 'react-dom/client'
import './index.css'
import { Api, type RCQGroup } from './lib/api'
import App from './App'

const params = new URLSearchParams(location.search)
if (params.get('theme')) localStorage.setItem('rcq.web.chat.theme', params.get('theme')!)
if (params.get('lang')) localStorage.setItem('rcq.web.language', params.get('lang')!)

// Nothing in this harness may touch a real island.
const realFetch = window.fetch.bind(window)
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith('/') || url.includes('localhost')) return realFetch(input, init)
  return Promise.reject(new Error('offline demo'))
}
class DeadWS {
  onopen: unknown = null
  onclose: unknown = null
  onerror: unknown = null
  onmessage: unknown = null
  readyState = 3
  close() {}
  send() {}
  addEventListener() {}
  removeEventListener() {}
}
;(window as unknown as { WebSocket: unknown }).WebSocket = DeadWS

const zero = btoa(String.fromCharCode(...new Uint8Array(32)))
localStorage.setItem(
  'rcq.web.identity.v1',
  JSON.stringify({
    uin: 4242,
    jwt: 'demo',
    apiBase: 'https://api.rcq.app',
    identityPriv: zero,
    identityPub: zero,
    signingPriv: zero,
    signingPub: zero,
  }),
)

const demoGroup = {
  id: 7,
  name: 'RCQ core',
  owner_uin: 4242,
  member_count: 3,
  members: [
    { uin: 4242, nickname: 'me', status: 'online' },
    { uin: 51, nickname: 'sergvn', status: 'offline' },
    { uin: 88, nickname: 'anton', status: 'away' },
  ],
} as unknown as RCQGroup
const demoGroups: RCQGroup[] = [
  demoGroup,
  { id: 9, name: 'Островитяне', owner_uin: 5, members: [], member_count: 3 },
  { id: 11, name: 'Пятничный клуб настольных игр', owner_uin: 5, members: [], member_count: 41 },
] as unknown as RCQGroup[]

Api.groups = async () => demoGroups
Api.groupInfo = async () => demoGroup
Api.contacts = async () => []
Api.myInfo = (async () => ({ uin: 4242, nickname: 'me', status: 'online' })) as unknown as typeof Api.myInfo

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
