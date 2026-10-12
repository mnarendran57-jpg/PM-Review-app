import { Link, useLocation } from 'react-router-dom';
import { ChevronRightIcon } from '@heroicons/react/20/solid';
import { selectedOrg, selectedProgram } from '../api';
import { useProject } from '../context/ProjectContext';

// Where the user is, as the path they took to get there: organization, program, project, tool.
//
// Every step but the last is a link to that level, so going from a tool back to the program is one
// click rather than three presses of Back. The last step is where they are standing, so it is
// shown and not linked.
//
// The steps are named after what was chosen, not after the page that lists the choices: clicking
// the organization's name opens its programs, and clicking the program's name opens its projects.
// That is the same thing the user did on the way in, which is what makes it read as a way back.

const TOOL_LABELS = {
  'shared-documents': 'Shared Documents',
  'proposal-intake': 'Proposal Intake',
  'pco-review': 'Change Order Review',
  'invoice-review': 'Invoice Review',
  'progress-report': 'Progress Report',
  'precon-review': 'Pre-Construction Review',
  've-analyzer': 'VE Analyzer',
  'cmar-pay-app-audit': 'Pay App Reviewer 3',
  'submittal-log': 'Submittal Log',
  'rfi-log': 'RFI Log',
  'meeting-actions': 'Meeting Actions',
};

// Pages that belong to the organization rather than to a program or a project.
const ORG_PAGES = {
  '/coaster-ai': 'Coaster AI',
  '/team': 'Team',
  '/settings': 'Settings',
  '/contact': 'Contact Us',
};

function trailFor(pathname, ctx) {
  const org = selectedOrg.get();
  const program = selectedProgram.get();
  // The path starts at the organization that was chosen, not at the page it was chosen from. Every
  // user lands on the organization list when they sign in, so naming it would put a step at the
  // front of every path that nobody took a decision to reach.
  const steps = org ? [{ label: org.name, to: '/programs' }] : [];
  if (pathname === '/programs') return steps;

  if (ORG_PAGES[pathname]) return [...steps, { label: ORG_PAGES[pathname] }];

  if (pathname === '/projects') {
    return program ? [...steps, { label: program.name, to: '/projects' }] : steps;
  }

  const match = pathname.match(/^\/project\/([^/]+)(?:\/([^/]+))?/);
  if (!match) return steps;

  // A project reached by a link or a bookmark may sit in a different program from the one last
  // chosen. The project's own program is the true one, so it is named here — and chosen on the
  // way out, so that the list the link opens is the list this project is actually in.
  const project = ctx?.project;
  const ownProgram = project?.program_id
    ? { id: project.program_id, name: project.program || program?.name }
    : program;
  if (ownProgram?.name) {
    steps.push({
      label: ownProgram.name,
      to: '/projects',
      onClick: () => selectedProgram.set({ id: ownProgram.id, name: ownProgram.name }),
    });
  }

  steps.push({ label: project?.project_name || '…', to: `/project/${match[1]}` });
  if (match[2]) steps.push({ label: TOOL_LABELS[match[2]] || match[2] });
  return steps;
}

export default function Breadcrumbs({ className = '' }) {
  const { pathname } = useLocation();
  const ctx = useProject();
  const steps = trailFor(pathname, ctx);
  if (steps.length === 0) return null;

  return (
    <nav aria-label="You are here" className={`flex items-center flex-wrap gap-1 text-[13px] ${className}`}>
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        return (
          <span key={`${i}-${step.label}`} className="flex items-center gap-1 min-w-0">
            {i > 0 && <ChevronRightIcon className="w-4 h-4 text-gray-300 flex-shrink-0" />}
            {last || !step.to ? (
              <span aria-current="page" className="font-semibold text-gray-900 truncate max-w-[280px] px-1.5 py-1">
                {step.label}
              </span>
            ) : (
              <Link
                to={step.to}
                onClick={step.onClick}
                className="font-medium text-gray-500 hover:underline underline-offset-4 px-1.5 py-1 truncate max-w-[220px]"
              >
                {step.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
