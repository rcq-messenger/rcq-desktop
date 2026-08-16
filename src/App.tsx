import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom'
import { I18nProvider } from './lib/i18n-context'
import { IdentityProvider, useIdentity } from './lib/identity-context'
import { ThemeProvider } from './lib/theme-context'
import { WSProvider } from './lib/ws'
import { MessageReceiver } from './lib/message-receiver'
import { MessageToasts } from './components/MessageToasts'
import { CallProvider } from './lib/call'
import { RoomsProvider } from './lib/rooms'
import AudioRooms from './pages/AudioRooms'
import { ToastProvider } from './lib/toast'
import { CallOverlay } from './components/CallOverlay'
import { Login } from './pages/Login'
import { Contacts } from './pages/Contacts'
import { Chat } from './pages/Chat'
import { Settings } from './pages/Settings'
import { PendingRequests } from './pages/PendingRequests'
import { AddContact } from './pages/AddContact'
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
            <RoomsProvider>
            <ToastProvider>
            <MessageReceiver />
            <Router>
            <MessageToasts />
            {/* Above every route: a call has to survive navigation, and the
                incoming sheet has to appear wherever the user happens to be. */}
            <CallOverlay />
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
            </ToastProvider>
            </RoomsProvider>
            </CallProvider>
          </WSProvider>
        </IdentityProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
