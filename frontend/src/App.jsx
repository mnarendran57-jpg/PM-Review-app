import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import ProjectWorkspace from './pages/ProjectWorkspace';
import OrgSelect from './pages/OrgSelect';
import ProgramSelect from './pages/ProgramSelect';
import Team from './pages/Team';
import Settings from './pages/Settings';
import Contact from './pages/Contact';
import Login from './pages/Login';
import InviteAccept from './pages/InviteAccept';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import { authApi, selectedOrg, selectedProgram } from './api';

// The hierarchy is always Organization -> Program -> Project, so navigation mirrors it:
//   sign in -> /organizations -> /programs -> /projects -> /project/:id/* (the tools)
// A user account belongs to no organization; which one they are in is chosen here and
// travels with every request.

function RequireAuth({ children }) {
  if (!authApi.isLoggedIn()) return <Navigate to="/login" replace />;
  return children;
}

// Each level is meaningless without the one above it, so send the user back to whichever
// choice is missing rather than rendering an empty screen.
function RequireOrg({ children }) {
  if (!selectedOrg.get()) return <Navigate to="/organizations" replace />;
  return children;
}

function RequireProgram({ children }) {
  if (!selectedOrg.get()) return <Navigate to="/organizations" replace />;
  if (!selectedProgram.get()) return <Navigate to="/programs" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Public: an invitee has no account yet, so this must sit outside RequireAuth. */}
      <Route path="/invite/:token" element={<InviteAccept />} />
      {/* Public for the same reason — someone locked out cannot sign in to get here. */}
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password/:token" element={<ResetPassword />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Routes>
              <Route path="/" element={<Navigate to="/organizations" replace />} />
              <Route path="/home" element={<Navigate to="/organizations" replace />} />
              <Route path="/clients" element={<Navigate to="/organizations" replace />} />
              <Route path="/organizations" element={<OrgSelect />} />
              <Route path="/programs" element={<RequireOrg><ProgramSelect /></RequireOrg>} />
              <Route path="/projects" element={<RequireProgram><Layout><Home /></Layout></RequireProgram>} />
              <Route path="/team" element={<RequireOrg><Layout><Team /></Layout></RequireOrg>} />
              <Route path="/settings" element={<RequireOrg><Layout><Settings /></Layout></RequireOrg>} />
              <Route path="/contact" element={<Layout><Contact /></Layout>} />
              <Route path="/project/:projectId/*" element={<RequireOrg><ProjectWorkspace /></RequireOrg>} />
            </Routes>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
