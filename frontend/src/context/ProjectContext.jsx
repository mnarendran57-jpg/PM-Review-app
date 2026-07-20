import { createContext, useContext } from 'react';

// Provided by ProjectWorkspace whenever the user is working inside a specific
// project. Tools read this instead of asking the user to pick a project — the
// project (and its shared documents, like the contract) is chosen once on the
// home page and inherited everywhere below /project/:projectId.
export const ProjectContext = createContext(null);

// Returns { project, projectId, reload } when inside a project workspace, or
// null on the global pages (home, settings, contact).
export const useProject = () => useContext(ProjectContext);
