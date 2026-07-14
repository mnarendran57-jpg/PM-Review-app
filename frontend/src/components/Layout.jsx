import Sidebar from './Sidebar';

export default function Layout({ children }) {
  return (
    <div className="min-h-screen flex" style={{ background: '#f4f6fb' }}>
      <div className="bg-mesh" />
      <Sidebar />
      <main className="flex-1 min-h-screen overflow-y-auto relative" style={{ marginLeft: '220px', zIndex: 1 }}>
        {children}
      </main>
    </div>
  );
}
