import { useState, useEffect } from 'react';
import { adminApi, selectedOrg } from '../api';

const CACHE_KEY = 'pm_review_plan_features';

// The last known answer, kept per organization so a reload doesn't briefly show tools the
// customer hasn't bought and then snatch them away. The server enforces the plan regardless —
// this only decides what to render.
function cached(orgId) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    return Array.isArray(all[orgId]) ? all[orgId] : null;
  } catch {
    return null;
  }
}

function remember(orgId, features) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[orgId] = features;
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* a full or disabled store is not worth failing over */ }
}

// Which tools the active organization's Coaster plan includes. `null` means "not known yet" —
// callers should show everything rather than flash an empty menu, since the server is the one
// that actually enforces this.
export function usePlanFeatures() {
  const orgId = selectedOrg.get()?.id ?? null;
  const [features, setFeatures] = useState(() => (orgId ? cached(orgId) : null));
  const [planName, setPlanName] = useState(null);

  useEffect(() => {
    if (!orgId) { setFeatures(null); return; }
    let cancelled = false;
    adminApi.myPlan()
      .then(({ features: list, planName: name }) => {
        if (cancelled) return;
        setFeatures(list);
        setPlanName(name);
        remember(orgId, list);
      })
      .catch(() => { /* keep the cached answer; the server still enforces the real one */ });
    return () => { cancelled = true; };
  }, [orgId]);

  return {
    features,
    planName,
    // Unknown plan renders everything: better to show a tool the server will refuse than to
    // hide one the customer is paying for.
    has: key => features == null || features.includes(key),
  };
}
