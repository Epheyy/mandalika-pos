import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { onAuthStateChanged, signInWithPopup, signOut, GoogleAuthProvider } from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { auth, db } from './firebase'
import type { AppUser } from './types'
import  { UserRole } from './types'

// Screens
import LoadingScreen from './components/shared/LoadingScreen'
import LoginScreen from './components/shared/LoginScreen'
import CashierScreen from './components/cashier/CashierScreen'
import BackOfficeScreen from './components/backoffice/BackOfficeScreen'

// ============================================
// 🔒 Protected Route
// Redirects to login if user doesn't have
// the right role to access a page
// ============================================
function ProtectedRoute({
  children,
  allowedRoles,
  appUser,
}: {
  children: React.ReactNode
  allowedRoles: UserRole[]
  appUser: AppUser | null
}) {
  if (!appUser) return <Navigate to="/" replace />
  if (!allowedRoles.includes(appUser.role)) return <Navigate to="/" replace />
  return <>{children}</>
}

// ============================================
// 🏠 Main App
// ============================================
export default function App() {
  // isAuthReady = has Firebase finished checking login status?
  const [isAuthReady, setIsAuthReady] = useState(false)

  // appUser = the logged-in user's data from our Firestore 'users' collection
  const [appUser, setAppUser] = useState<AppUser | null>(null)

  // ── Auth State Listener ──────────────────
  // This runs once on startup and listens for login/logout events
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // User is logged in — fetch their role from Firestore
        try {
          const userRef = doc(db, 'users', firebaseUser.uid)
          const userSnap = await getDoc(userRef)

          if (userSnap.exists()) {
            // User exists in our database — load their data
            setAppUser({ id: userSnap.id, ...userSnap.data() } as AppUser)

          } else if (firebaseUser.email === 'mandalikareffy@gmail.com') {
            // ── First-time admin bootstrap ──
            // If this is YOUR email and no user doc exists yet,
            // automatically create an admin account.
            // This only runs once — the very first login.
            const adminUser: AppUser = {
              uid: firebaseUser.uid,
              displayName: firebaseUser.displayName || 'Admin',
              email: firebaseUser.email!,
              role: UserRole.ADMIN,
              permissions: [], // Admin has implicit access to everything
              photoURL: firebaseUser.photoURL || undefined,
              createdAt: new Date().toISOString(),
            }
            await setDoc(userRef, adminUser)
            setAppUser(adminUser)

          } else {
            // User is not in our database — deny access
            setAppUser(null)
            await signOut(auth)
            alert('Akun Anda belum terdaftar. Hubungi administrator.')
          }
        } catch (error) {
          console.error('Error fetching user:', error)
          setAppUser(null)
        }
      } else {
        // User is logged out
        setAppUser(null)
      }

      // Firebase has finished checking — safe to show the UI
      setIsAuthReady(true)
    })

    // Cleanup: stop listening when the app unmounts
    return () => unsubscribe()
  }, [])

  // ── Handlers ────────────────────────────

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider()
    await signInWithPopup(auth, provider)
    // onAuthStateChanged above will automatically handle what happens next
  }

  const handleLogout = async () => {
    await signOut(auth)
    setAppUser(null)
  }

  // ── Render ──────────────────────────────

  // 1. Still checking auth status — show spinner
  if (!isAuthReady) return <LoadingScreen />

  // 2. Not logged in — show login screen
  if (!appUser) return <LoginScreen onLogin={handleLogin} />

  // 3. Logged in — show the right screen based on role
  return (
    <Routes>

      {/* Cashier Route — accessible by all roles */}
      <Route
        path="/"
        element={
          <CashierScreen
            appUser={appUser}
            onLogout={handleLogout}
          />
        }
      />

      {/* Back Office Route — admin and manager only */}
      <Route
        path="/backoffice/*"
        element={
          <ProtectedRoute
            allowedRoles={[UserRole.ADMIN, UserRole.MANAGER]}
            appUser={appUser}
          >
            <BackOfficeScreen
              appUser={appUser}
              onLogout={handleLogout}
            />
          </ProtectedRoute>
        }
      />

      {/* Catch-all — redirect unknown URLs to home */}
      <Route path="*" element={<Navigate to="/" replace />} />

    </Routes>
  )
}