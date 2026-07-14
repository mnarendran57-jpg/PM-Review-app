import { NavLink, Outlet } from "react-router-dom";
import { LayoutGrid, Wallet, Receipt, CreditCard, PiggyBank, FileText } from "lucide-react";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutGrid, end: true },
  { to: "/income", label: "Income", icon: Wallet },
  { to: "/expenses", label: "Expenses", icon: Receipt },
  { to: "/debt", label: "Debt", icon: CreditCard },
  { to: "/savings", label: "Savings", icon: PiggyBank },
  { to: "/summary", label: "Summary", icon: FileText },
];

function navLinkClasses({ isActive }) {
  return `flex items-center gap-3 rounded-control px-3.5 py-2.5 text-sm font-medium transition-colors ${
    isActive ? "bg-brand-soft text-brand" : "text-ink-soft hover:bg-surface-muted hover:text-ink"
  }`;
}

function mobileNavLinkClasses({ isActive }) {
  return `flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-medium ${
    isActive ? "text-brand" : "text-ink-faint"
  }`;
}

export default function Layout() {
  return (
    <div className="min-h-full lg:flex">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-surface px-4 py-6 lg:flex lg:flex-col">
        <div className="mb-8 flex items-center gap-2 px-2">
          <span className="grid size-8 place-items-center rounded-full bg-brand text-white">
            <PiggyBank size={17} />
          </span>
          <span className="text-lg font-semibold text-ink">Clarity</span>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={navLinkClasses}>
              <Icon size={18} strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-h-full flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line bg-surface px-5 py-4 lg:hidden">
          <span className="grid size-8 place-items-center rounded-full bg-brand text-white">
            <PiggyBank size={17} />
          </span>
          <span className="text-lg font-semibold text-ink">Clarity</span>
        </header>

        <main className="flex-1 px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pb-10 lg:pt-8">
          <div className="mx-auto w-full max-w-5xl">
            <Outlet />
          </div>
        </main>

        <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-surface px-1 pb-[env(safe-area-inset-bottom)] lg:hidden">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={mobileNavLinkClasses}>
              <Icon size={20} strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
