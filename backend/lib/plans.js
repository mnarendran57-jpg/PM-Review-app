const db = require('../database');

// What Coaster sells. Keys match both the API mount path (/api/pay-app-review) and the
// frontend tool slug, so a feature key is the single name for a tool everywhere.
const FEATURES = [
  { key: 'pay-app-review', label: 'Pay App Review' },
  { key: 'invoice-review', label: 'Invoice Review' },
  { key: 'pco-review', label: 'Change Order Review' },
  { key: 'progress-report', label: 'Progress Report' },
  { key: 'precon-review', label: 'Pre-Construction Review' },
  { key: 'proposal-intake', label: 'Proposal Intake' },
  { key: 'submittal-log', label: 'Submittal Log' },
  { key: 'rfi-log', label: 'RFI Log' },
];

const FEATURE_KEYS = FEATURES.map(f => f.key);

// The published tiers. Edit these to change what a plan includes — every customer on that
// plan follows immediately, with no per-customer work.
const PLANS = [
  {
    key: 'lite',
    name: 'Coaster Lite',
    blurb: 'The two reviews most firms start with.',
    features: ['pay-app-review', 'invoice-review'],
  },
  {
    key: 'standard',
    name: 'Standard',
    blurb: 'Adds change orders, progress reporting and the submittal and RFI logs.',
    features: [
      'pay-app-review', 'invoice-review', 'pco-review', 'progress-report',
      'submittal-log', 'rfi-log',
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    blurb: 'Everything, including pre-construction review.',
    features: FEATURE_KEYS,
  },
  {
    key: 'custom',
    name: 'Custom',
    blurb: 'Hand-picked features for a negotiated deal.',
    features: [], // whatever is ticked on the organization itself
  },
];

const PLAN_KEYS = PLANS.map(p => p.key);
const planByKey = key => PLANS.find(p => p.key === key) || null;

// A customer's live feature set. `custom` reads the per-organization list; every other plan
// reads its tier, so changing a tier's contents updates all its customers at once. An
// organization with no plan recorded keeps everything — existing customers must never lose
// access because a pricing model was introduced after they signed up.
function featuresForOrg(orgId) {
  const org = db.prepare(`SELECT plan, plan_features FROM organizations WHERE id=?`).get(orgId);
  if (!org || !org.plan) return FEATURE_KEYS;

  if (org.plan === 'custom') {
    try {
      const chosen = JSON.parse(org.plan_features || '[]');
      return Array.isArray(chosen) ? chosen.filter(k => FEATURE_KEYS.includes(k)) : [];
    } catch {
      return [];
    }
  }
  return planByKey(org.plan)?.features ?? FEATURE_KEYS;
}

const orgHasFeature = (orgId, featureKey) => featuresForOrg(orgId).includes(featureKey);

// Gate for a tool's router. Answers 403 rather than 404: the customer is entitled to know the
// tool exists and that their plan is what is in the way — that message is the upgrade prompt.
function requireFeature(featureKey) {
  return (req, res, next) => {
    if (!req.orgId) return next();               // requireOrg reports the missing organization
    if (orgHasFeature(req.orgId, featureKey)) return next();
    const feature = FEATURES.find(f => f.key === featureKey);
    return res.status(403).json({
      error: `${feature?.label || 'This tool'} is not included in your organization's Coaster plan. `
        + 'Contact Coaster to add it.',
      feature: featureKey,
      upgradeRequired: true,
    });
  };
}

module.exports = {
  FEATURES, FEATURE_KEYS, PLANS, PLAN_KEYS, planByKey,
  featuresForOrg, orgHasFeature, requireFeature,
};
