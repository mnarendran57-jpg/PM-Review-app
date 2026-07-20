import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import ProjectWorkspace from './pages/ProjectWorkspace';
import Settings from './pages/Settings';
import Contact from './pages/Contact';
import Login from './pages/Login';
import { authApi } from './api';

// The app is organized around projects. The home page (/projects) is a gallery of
// projects; opening one drops into /project/:projectId/* where the individual tools
// live (see ProjectWorkspace). Settings and Contact are global sample pages.

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
            <Routes>
              <Route path="/" element={<Navigate to="/projects" replace />} />
              <Route path="/home" element={<Navigate to="/projects" replace />} />
              <Route path="/projects" element={<Layout><Home /></Layout>} />
              <Route path="/settings" element={<Layout><Settings /></Layout>} />
              <Route path="/contact" element={<Layout><Contact /></Layout>} />
              <Route path="/project/:projectId/*" element={<ProjectWorkspace />} />
            </Routes>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
