import { Navigate, Route, HashRouter, Routes } from "react-router-dom";
import { BudgetProvider, useBudget } from "./context/BudgetContext";
import Layout from "./components/Layout";
import Onboarding from "./pages/Onboarding";
import Dashboard from "./pages/Dashboard";
import Income from "./pages/Income";
import Expenses from "./pages/Expenses";
import Debt from "./pages/Debt";
import Savings from "./pages/Savings";
import Summary from "./pages/Summary";

function RequireOnboarding({ children }) {
  const { state } = useBudget();
  if (!state.onboarded) return <Navigate to="/onboarding" replace />;
  return children;
}

function OnboardingGate() {
  const { state } = useBudget();
  if (state.onboarded) return <Navigate to="/" replace />;
  return <Onboarding />;
}

function App() {
  return (
    <BudgetProvider>
      <HashRouter>
        <Routes>
          <Route path="/onboarding" element={<OnboardingGate />} />
          <Route
            element={
              <RequireOnboarding>
                <Layout />
              </RequireOnboarding>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/income" element={<Income />} />
            <Route path="/expenses" element={<Expenses />} />
            <Route path="/debt" element={<Debt />} />
            <Route path="/savings" element={<Savings />} />
            <Route path="/summary" element={<Summary />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </BudgetProvider>
  );
}

export default App
