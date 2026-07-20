import { useState, useEffect, useCallback } from 'react';
import { useParams, Routes, Route } from 'react-router-dom';
import Layout from '../components/Layout';
import { ProjectContext } from '../context/ProjectContext';
import { projectsApi } from '../api';
import ProjectHome from './ProjectHome';
import ProposalIntake from './ProposalIntake';
import PayAppReview from './PayAppReview';
import PcoReview from './PcoReview';
import InvoiceReview from './InvoiceReview';
import PreconReview from './PreconReview';

// Everything under /project/:projectId lives here. The project is fetched once and
// handed to every tool through ProjectContext, so no tool re-asks which project it
// is working on.
export default function ProjectWorkspace() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [notFound, setNotFound] = useState(false);

  const reload = useCallback(() => {
    projectsApi.get(projectId)
      .then(p => { setProject(p); setNotFound(false); })
      .catch(() => setNotFound(true));
  }, [projectId]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <ProjectContext.Provider value={{ project, projectId, reload }}>
      <Layout>
        {notFound ? (
          <div className="p-8 text-gray-500">This project could not be found.</div>
        ) : (
          <Routes>
            <Route index element={<ProjectHome />} />
            <Route path="proposal-intake" element={<ProposalIntake />} />
            <Route path="pay-app-review" element={<PayAppReview />} />
            <Route path="pco-review" element={<PcoReview />} />
            <Route path="invoice-review" element={<InvoiceReview />} />
            <Route path="precon-review" element={<PreconReview />} />
          </Routes>
        )}
      </Layout>
    </ProjectContext.Provider>
  );
}
