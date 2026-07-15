import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import ProposalIntake from './pages/ProposalIntake';
import PayAppReview from './pages/PayAppReview';
import PcoReview from './pages/PcoReview';
import PreconReview from './pages/PreconReview';
import Login from './pages/Login';
import { authApi } from './api';

// Other pages (Projects, DocumentReview, RFITracker, SubmittalTracker, Finance, Settings)
// are intentionally left unrouted — only Proposal Intake, Pay App Review, and
// Pre-Construction Document Review are live for now. The files remain in src/pages for
// reuse later; re-add their imports/routes here to revive them.

function RequireAuth({ children }) {
  if (!authApi.isLoggedIn()) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route path="/" element={<Navigate to="/home" replace />} />
                <Route path="/home" element={<Home />} />
                <Route path="/proposal-intake" element={<ProposalIntake />} />
                <Route path="/pay-app-review" element={<PayAppReview />} />
                <Route path="/pco-review" element={<PcoReview />} />
                <Route path="/precon-review" element={<PreconReview />} />
              </Routes>
            </Layout>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
