export default function LoadingScreen() {
  return (
    <div className="h-screen w-full bg-gray-50 flex overflow-hidden pointer-events-none select-none">
      {/* Left Sidebar Skeleton (hidden on mobile) */}
      <aside className="w-64 bg-white border-r border-gray-200 hidden lg:flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
          <div className="w-10 h-8 bg-gray-200 rounded flex-shrink-0 animate-pulse" />
          <div className="flex flex-col gap-1.5 flex-1">
            <div className="w-24 h-4 bg-gray-200 rounded animate-pulse" />
            <div className="w-16 h-3 bg-gray-100 rounded animate-pulse" />
          </div>
        </div>
        <div className="p-3 space-y-2 flex-1 mt-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="w-full h-12 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="p-4 border-t border-gray-100">
          <div className="w-full h-16 bg-gray-100 rounded-xl animate-pulse" />
        </div>
      </aside>

      {/* Main Area Skeleton */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Skeleton */}
        <header className="h-[60px] bg-white border-b border-gray-200 px-4 flex items-center justify-between">
          <div className="w-8 h-8 bg-gray-100 rounded-xl lg:hidden animate-pulse" />
          <div className="w-20 h-5 bg-gray-200 rounded animate-pulse hidden lg:block" />
          <div className="w-8 h-8 bg-gray-200 rounded-full animate-pulse" />
        </header>

        {/* Content Grid Skeleton */}
        <div className="flex-1 p-4 overflow-hidden flex flex-col">
          <div className="flex gap-2 mb-4">
            <div className="flex-1 h-11 bg-gray-200 rounded-xl animate-pulse" />
            <div className="w-11 h-11 bg-gray-200 rounded-xl flex-shrink-0 animate-pulse" />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 flex-1 content-start">
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="bg-white rounded-2xl overflow-hidden border border-gray-100 animate-pulse">
                <div className="w-full aspect-square bg-gray-200" />
                <div className="p-3 space-y-2">
                  <div className="h-3 bg-gray-200 rounded w-4/5" />
                  <div className="h-3 bg-gray-200 rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Right Sidebar (Cart) Skeleton (hidden on smaller screens) */}
      <aside className="w-[280px] md:w-[300px] xl:w-80 bg-white border-l border-gray-200 hidden md:flex flex-col">
        <div className="p-4 border-b border-gray-100">
          <div className="w-full h-10 bg-gray-100 rounded-xl animate-pulse" />
        </div>
        <div className="px-4 py-3 border-b border-gray-100">
          <div className="w-24 h-4 bg-gray-200 rounded animate-pulse" />
        </div>
        <div className="p-4 flex-1 space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="w-full h-[76px] bg-gray-50 rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="p-4 border-t border-gray-100 space-y-3">
          <div className="flex justify-between">
            <div className="w-16 h-3 bg-gray-200 rounded animate-pulse" />
            <div className="w-20 h-3 bg-gray-200 rounded animate-pulse" />
          </div>
          <div className="flex justify-between pt-1">
            <div className="w-16 h-4 bg-gray-300 rounded animate-pulse" />
            <div className="w-24 h-4 bg-gray-300 rounded animate-pulse" />
          </div>
          <div className="w-full h-14 bg-indigo-50 rounded-2xl mt-2 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />
          </div>
        </div>
      </aside>
    </div>
  )
}