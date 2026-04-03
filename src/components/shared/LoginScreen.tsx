import { useState } from 'react'
import { BRAND } from '../../config/brand'

interface LoginScreenProps {
  onLogin: () => Promise<void>
}

export default function LoginScreen({ onLogin }: LoginScreenProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async () => {
    setIsLoading(true)
    setError('')
    try {
      await onLogin()
    } catch (err) {
      setError('Login gagal. Silakan coba lagi.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-purple-50 p-4">
      <div className="w-full max-w-md">

        {/* Card */}
        <div className="bg-white rounded-[32px] shadow-2xl shadow-indigo-100 border border-gray-100 p-10 text-center">

          {/* Logo */}
          <div className="w-20 h-20 bg-indigo-600 rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-xl shadow-indigo-200">
            <span className="text-4xl font-black text-white">{BRAND.logo}</span>
          </div>

          {/* Brand name */}
          <h1 className="text-3xl font-black text-gray-900 tracking-tight">
            {BRAND.name}
          </h1>
          <p className="text-gray-400 font-medium mt-1 mb-8">
            {BRAND.tagline} — Point of Sale
          </p>

          {/* Divider */}
          <div className="w-16 h-1 bg-indigo-600 rounded-full mx-auto mb-8" />

          {/* Login button */}
          <button
            onClick={handleLogin}
            disabled={isLoading}
            className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl shadow-lg shadow-indigo-100 transition-all active:scale-[0.98] flex items-center justify-center gap-3"
          >
            {isLoading ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Masuk...</span>
              </>
            ) : (
              <>
                {/* Google Icon */}
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                  <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                <span>Masuk dengan Google</span>
              </>
            )}
          </button>

          {/* Error message */}
          {error && (
            <p className="mt-4 text-sm text-red-500 font-medium">{error}</p>
          )}

          {/* Footer note */}
          <p className="mt-8 text-xs text-gray-300 font-medium">
            Hanya akun yang terdaftar yang dapat masuk
          </p>

        </div>

        {/* Bottom label */}
        <p className="text-center text-xs text-gray-300 font-medium mt-6">
          {BRAND.name} POS v1.0 · Powered by Mandalika
        </p>

      </div>
    </div>
  )
}