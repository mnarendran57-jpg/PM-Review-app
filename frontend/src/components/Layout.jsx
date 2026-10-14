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
            The search sits under the path, at the left and at full size — where it is on the
            organization and program pages — so it is in one place from the first page onwards
            rather than moving to a corner once a project is open. */}
        <div className="px-8 pt-5 -mb-3 space-y-3 relative" style={{ zIndex: 20 }}>
          <Breadcrumbs />
          <GlobalSearch wide />
        </div>
        {children}
      </main>
    </div>
  );
}
