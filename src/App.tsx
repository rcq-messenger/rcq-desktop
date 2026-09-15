import { useEffect } from 'react'
import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom'
import { I18nProvider } from './lib/i18n-context'
import { IdentityProvider, useIdentity } from './lib/identity-context'
import { ThemeProvider } from './lib/theme-context'
import { WSProvider } from './lib/ws'
import { MessageReceiver } from './lib/message-receiver'
import { MessageToasts } from './components/MessageToasts'
import { IslandTrustBanner } from './components/IslandTrust'
import { CallProvider } from './lib/call'
import { RoomsProvider } from './lib/rooms'
import AudioRooms from './pages/AudioRooms'
import { Sites } from './pages/Sites'
import { ToastProvider } from './lib/toast'
import { PinGate } from './lib/pin-gate'
import { CallOverlay } from './components/CallOverlay'
import { AccountMovedNotice } from './components/AccountMoved'
import { RotatedElsewhereNotice } from './components/RotatedElsewhere'
import { Login } from './pages/Login'
import { Contacts } from './pages/Contacts'
import { Chat } from './pages/Chat'
import { Settings } from './pages/Settings'
import { PendingRequests } from './pages/PendingRequests'
import { AddContact } from './pages/AddContact'
import { ContactLink } from './pages/ContactLink'
import { ReferralLink } from './pages/ReferralLink'
import { Profile } from './pages/Profile'
import { GroupInfo } from './pages/GroupInfo'
import { HowItWorks } from './pages/HowItWorks'
import { BrowserStorage } from './pages/BrowserStorage'
import { JoinGroup } from './pages/JoinGroup'
import { Diagnostics } from './pages/Diagnostics'
import { MyReports } from './pages/MyReports'
import { Privacy } from './pages/Privacy'
import { Market } from './pages/Market'
import { defaultHome } from './lib/routing'
import { forgetReturnTo, peekReturnTo, rememberReturnTo } from './lib/login-return'

function Authed({ children }: { children: JSX.Element }) {
  const { identity } = useIdentity()
  const { pathname, search } = useLocation()
  const signedIn = identity != null
  const here = pathname + search
  // ⚠ A shared contact link reaches this gate as `/add?q=…` (ContactLink), and
  // a logged-out visitor used to be bounced to "/" with the errand forgotten:
  // after signing in they landed on an empty contact list. The note only takes
  // the app's own contact screens (login-return.ts), so every other guarded
  // page still lands at home, and the hash (a guest card) is never part of it.
  // ⚠ Primitive deps only: `identity` is a fresh object on every token refresh.
  useEffect(() => {
    if (!signedIn) rememberReturnTo(here)
  }, [signedIn, here])
  if (!signedIn) return <Navigate to="/" replace />
  return children
}

function RootEntry() {
  const { identity } = useIdentity()
  // Read in render, forgotten in the effect: under StrictMode the render runs
  // twice, and a read that also deleted would hand the second one nothing.
  const returnTo = identity ? peekReturnTo() : null
  useEffect(() => {
    if (returnTo) forgetReturnTo()
  }, [returnTo])
  if (identity) return <Navigate to={returnTo ?? defaultHome()} replace />
  return <Login />
}

export default function App() {
  // Provider order: Theme is outermost (applies a class on <html>
  // before children paint), then I18n, then Identity (auth gate),
  // then WS which reads identity to open the socket, then Router.
  // Theme → I18n → Identity → WS → Router.
  return (
    <ThemeProvider>
      <I18nProvider>
        {/* Above the identity provider on purpose: while the desktop app is
            locked there is no account in the page at all — not a hidden one,
            not one behind a route guard. Nothing below this line runs until
            the PIN is typed. In a browser it renders its children and stops. */}
        {/* Above the gate, not under it: the lock screen has notices of its
            own now (a wrong PIN, a cool-down), and until this moved they had
            nowhere to go but inline text that shoved the input around on every
            attempt. Nothing else changes — the provider is a context and a
            host, it knows nothing about an account. */}
        <ToastProvider>
        <PinGate>
        <IdentityProvider>
          <WSProvider>
            <CallProvider>
            <RoomsProvider>
            <MessageReceiver />
            <Router>
            <MessageToasts />
            {/* Above every route, the login screen included: a certificate
                that changed, or a typed fingerprint the store disagrees with,
                is refused before there is an account (fingerprint design §5).
                Draws nothing off the desktop. */}
            <IslandTrustBanner />
            {/* Above every route: a call has to survive navigation, and the
                incoming sheet has to appear wherever the user happens to be. */}
            <CallOverlay />
            {/* Above every route as well, and drawing nothing almost always:
                it appears only when this account moved to another number and
                this window could not follow it. Every request is answering 401
                by then, so there is no screen underneath it left to use. */}
            <AccountMovedNotice />
            {/* Same placement and the same reason: the keys were changed on
                another device, and under the old ones nothing here answers. */}
            <RotatedElsewhereNotice />
            <Routes>
              <Route path="/" element={<RootEntry />} />
              {/* ⚠ A SHARED CONTACT LINK, which this app could not open at all.
                  `https://rcq.app/u/<uin>?h=…#c=<card>` is what every client
                  builds and what a person pastes, and the chat app had no route
                  for it: the marketing site caught the path and offered to open
                  an app, which on desktop IS this app. The guest card in the
                  fragment therefore reached the phones and never the web. */}
              <Route path="/u/:uin" element={<ContactLink />} />
              {/* A referral, `https://rcq.app/r/<uin>`. Not behind Authed: a
                  logged-out visitor is exactly who it is for, and the inviter
                  has to be noted before the login screen can use it. */}
              <Route path="/r/:uin" element={<ReferralLink />} />
              <Route
                path="/contacts"
                element={
                  <Authed>
                    <Contacts />
                  </Authed>
                }
              />
              <Route
                path="/sites"
                element={
                  <Authed>
                    <Sites />
                  </Authed>
                }
              />
              <Route
                path="/rooms"
                element={
                  <Authed>
                    <AudioRooms />
                  </Authed>
                }
              />
              <Route
                path="/chat/:uin"
                element={
                  <Authed>
                    <Chat />
                  </Authed>
                }
              />
              <Route
                path="/chat/g/:groupId"
                element={
                  <Authed>
                    <Chat />
                  </Authed>
                }
              />
              <Route
                path="/groups/:groupId"
                element={
                  <Authed>
                    <GroupInfo />
                  </Authed>
                }
              />
              <Route
                path="/g/:groupId"
                element={
                  <Authed>
                    <JoinGroup />
                  </Authed>
                }
              />
              <Route
                path="/profile"
                element={
                  <Authed>
                    <Profile />
                  </Authed>
                }
              />
              <Route
                path="/profile/:uin"
                element={
                  <Authed>
                    <Profile />
                  </Authed>
                }
              />
              <Route
                path="/add"
                element={
                  <Authed>
                    <AddContact />
                  </Authed>
                }
              />
              <Route
                path="/pending"
                element={
                  <Authed>
                    <PendingRequests />
                  </Authed>
                }
              />
              <Route
                path="/how"
                element={
                  <Authed>
                    <HowItWorks />
                  </Authed>
                }
              />
              <Route
                path="/storage"
                element={
                  <Authed>
                    <BrowserStorage />
                  </Authed>
                }
              />
              <Route
                path="/settings"
                element={
                  <Authed>
                    <Settings />
                  </Authed>
                }
              />
              <Route
                path="/privacy"
                element={
                  <Authed>
                    <Privacy />
                  </Authed>
                }
              />
              <Route
                path="/diagnostics"
                element={
                  <Authed>
                    <Diagnostics />
                  </Authed>
                }
              />
              <Route
                path="/reports"
                element={
                  <Authed>
                    <MyReports />
                  </Authed>
                }
              />
              {/* The market is a screen of this app, not a separate site.
                  It used to live only on market.rcq.app, which meant every
                  entry point into it was a link OFF the client: on the desktop
                  that carried the whole window away, and in a browser it
                  created a second origin with its own copy of the signed-in
                  identity that a sign-out here could not reach. */}
              <Route
                path="/market"
                element={
                  <Authed>
                    <Market />
                  </Authed>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Router>
            </RoomsProvider>
            </CallProvider>
          </WSProvider>
        </IdentityProvider>
        </PinGate>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
