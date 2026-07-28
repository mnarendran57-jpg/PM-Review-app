import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import ProjectWorkspace from './pages/ProjectWorkspace';
import ClientSelect from './pages/ClientSelect';
import Settings from './pages/Settings';
import Contact from './pages/Contact';
import Login from './pages/Login';
import { authApi, selectedClient } from './api';

// The app is sold to PM firms, so it is organised firm -> client -> project:
//   sign in -> /clients (pick who you're working for) -> /projects (their projects)
//   -> /project/:projectId/* (the tools for one project, see ProjectWorkspace).
// Settings and Contact are firm-level pages.

function RequireAuth({ children }) {
  if (!authApi.isLoggedIn()) return <Navigate to="/login" replace />;
  return children;
}

// Pages below the client picker are meaningless without a client chosen — send the user
// back to choose one (e.g. after a fresh sign-in, or if they cleared the selection).
function RequireClient({ children }) {
  if (!selectedClient.get()) return <Navigate to="/clients" replace />;
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
            <Routes>
              <Route path="/" element={<Navigate to="/clients" replace />} />
              <Route path="/home" element={<Navigate to="/clients" replace />} />
              <Route path="/clients" element={<ClientSelect />} />
              <Route path="/projects" element={<RequireClient><Layout><Home /></Layout></RequireClient>} />
              <Route path="/settings" element={<Layout><Settings /></Layout>} />
              <Route path="/contact" element={<Layout><Contact /></Layout>} />
              <Route path="/project/:projectId/*" element={<RequireClient><ProjectWorkspace /></RequireClient>} />
            </Routes>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
