import Sidebar from './Sidebar';
import Breadcrumbs from './Breadcrumbs';
import GlobalSearch from './GlobalSearch';

export default function Layout({ children }) {
  return (
    <div className="min-h-screen flex" style={{ background: '#f4f6fb' }}>
      <div className="bg-mesh" />
      <Sidebar />
      <main className="flex-1 min-h-screen overflow-y-auto relative" style={{ marginLeft: '220px', zIndex: 1 }}>
        {/* Above every page, so the way back and the way anywhere else are in the same place
            whichever tool is open. Raised above the page so the search results sit over it.
            The path takes what room there is and the search keeps a usable width; when the window
            is too narrow for both on one line, the search moves underneath rather than squeezing
            the path into a column of single letters. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-8 pt-5 -mb-3 relative" style={{ zIndex: 20 }}>
          <div className="min-w-0" style={{ flex: '1 1 260px' }}>
            <Breadcrumbs />
          </div>
          <div className="flex justify-end" style={{ flex: '0 1 340px', minWidth: 240 }}>
            <GlobalSearch />
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
