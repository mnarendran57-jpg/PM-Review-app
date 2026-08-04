import { useState, useEffect } from 'react';
import { BuildingOffice2Icon } from '@heroicons/react/24/outline';
import { orgsApi, selectedOrg } from '../api';

// Team and Settings both act on exactly one organization. Without this, changing which one
// meant leaving the page, going back to the picker and coming in again — the reason
// managing people across several organizations was tedious. Hidden when there is nothing
// to switch between.
export default function OrgSwitcher({ adminOnly = false }) {
  const [orgs, setOrgs] = useState([]);
  const current = selectedOrg.get();

  useEffect(() => {
    orgsApi.mine()
      .then(list => setOrgs(adminOnly ? (list || []).filter(o => o.is_admin) : (list || [])))
      .catch(() => setOrgs([]));
  }, [adminOnly]);

  if (orgs.length < 2) return null;

  const pick = id => {
    const org = orgs.find(o => String(o.id) === String(id));
    if (!org || org.id === current?.id) return;
    // Selecting also clears the chosen program, which belongs to the old organization.
    selectedOrg.set({ id: org.id, name: org.name, is_admin: !!org.is_admin });
    // Reload rather than refetch: the selected organization is read from storage wherever
    // it is needed, including the sidebar, which is outside this page's render. Refreshing
    // only the page's own data left the sidebar naming the previous organization.
    window.location.reload();
  };

  return (
    <div className="flex items-center gap-2">
      <BuildingOffice2Icon className="w-4 h-4 text-gray-400 flex-shrink-0" />
      <select
        className="input py-1.5 text-sm font-medium"
        style={{ width: 'auto', minWidth: '180px' }}
        value={current?.id ?? ''}
        onChange={e => pick(e.target.value)}
      >
        {!current && <option value="">Choose an organization…</option>}
        {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );
}
