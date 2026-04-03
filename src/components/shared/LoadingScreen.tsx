import { BRAND } from '../../config/brand'

export default function LoadingScreen() {
  return (
    <div className="h-screen flex flex-col items-center justify-center bg-gray-50 gap-6">

      {/* Logo */}
      <div className="w-20 h-20 bg-indigo-600 rounded-3xl flex items-center justify-center shadow-xl shadow-indigo-200">
        <span className="text-4xl font-black text-white">{BRAND.logo}</span>
      </div>

      {/* Spinner */}
      <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />

      {/* Text */}
      <p className="text-sm font-bold text-gray-400 uppercase tracking-widest">
        Memuat {BRAND.name}...
      </p>

    </div>
  )
}