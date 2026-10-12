import Sidebar from './Sidebar';
import Breadcrumbs from './Breadcrumbs';

export default function Layout({ children }) {
  return (
    <div className="min-h-screen flex" style={{ background: '#f4f6fb' }}>
      <div className="bg-mesh" />
      <Sidebar />
      <main className="flex-1 min-h-screen overflow-y-auto relative" style={{ marginLeft: '220px', zIndex: 1 }}>
        {/* Above every page, so the way back is in the same place whichever tool is open. */}
        <Breadcrumbs className="px-8 pt-5 -mb-3" />
        {children}
      </main>
    </div>
  );
}
