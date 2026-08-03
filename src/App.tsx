import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom'
import { I18nProvider } from './lib/i18n-context'
import { IdentityProvider, useIdentity } from './lib/identity-context'
import { ThemeProvider } from './lib/theme-context'
import { WSProvider } from './lib/ws'
import { MessageReceiver } from './lib/message-receiver'
import { MessageToasts } from './components/MessageToasts'
import { CallProvider } from './lib/call'
import { CallOverlay } from './components/CallOverlay'
import { Login } from './pages/Login'
import { Contacts } from './pages/Contacts'
import { Chat } from './pages/Chat'
import { Settings } from './pages/Settings'
import { PendingRequests } from './pages/PendingRequests'
import { AddContact } from './pages/AddContact'
import { Profile } from './pages/Profile'
import { GroupInfo } from './pages/GroupInfo'
import { JoinGroup } from './pages/JoinGroup'
import { Diagnostics } from './pages/Diagnostics'
import { Privacy } from './pages/Privacy'
import { Market } from './pages/Market'
import { defaultHome, isMarketHost } from './lib/routing'

function Authed({ children }: { children: JSX.Element }) {
  const { identity } = useIdentity()
  if (!identity) return <Navigate to="/" replace />
  return children
}

function RootEntry() {
  const { identity } = useIdentity()
  if (identity) return <Navigate to={defaultHome()} replace />
  return <Login />
}

// market.rcq.app is the UIN market ONLY, served at the root path. Logged in →
// the market; logged out → the login (which returns to '/'). No chat surface
// is reachable on this subdomain (the catch-all below sends everything to '/').
function MarketRoot() {
  const { identity } = useIdentity()
  return identity ? <Market /> : <Login />
}

export default function App() {
  // Provider order: Theme is outermost (applies a class on <html>
  // before children paint), then I18n, then Identity (auth gate),
  // then WS which reads identity to open the socket, then Router.
  // Theme → I18n → Identity → WS → Router.
  return (
    <ThemeProvider>
      <I18nProvider>
        <IdentityProvider>
          <WSProvider>
            <CallProvider>
            {/* market.rcq.app is the UIN market ONLY — no chat surface. Don't
                run the message receiver (which drains the queue + fires toasts)
                or the toast layer there, or the market shows stale "new
                message" toasts for chats the user already read elsewhere. */}
            {!isMarketHost() && <MessageReceiver />}
            <Router>
            {!isMarketHost() && <MessageToasts />}
            {/* Above every route: a call has to survive navigation, and the
                incoming sheet has to appear wherever the user happens to be. */}
            {!isMarketHost() && <CallOverlay />}
            {isMarketHost() ? (
            <Routes>
              <Route path="/" element={<MarketRoot />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            ) : (
            <Routes>
              <Route path="/" element={<RootEntry />} />
              <Route
                path="/contacts"
                element={
                  <Authed>
                    <Contacts />
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
              {/* No /market on chat.rcq.app — the market lives only on
                  market.rcq.app. The header/settings buttons link there
                  (external), and any /market path falls through to '/'. */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            )}
          </Router>
            </CallProvider>
          </WSProvider>
        </IdentityProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
