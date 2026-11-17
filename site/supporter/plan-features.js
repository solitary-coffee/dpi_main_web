// Single source of truth for paid-plan feature flags.
// Imported by the Worker (worker/supporter-billing.js, supporter-geo.js, supporter.js,
// supporter-snapshot.js) and by the dashboard (site/supporter/app.js), so the server
// checks and the client UI can never drift apart. Keep this file dependency-free.
export const ACTIVE_PLAN_STATUSES = Object.freeze(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
// Admin-issued custom contracts never grant access while past_due/unpaid.
const CUSTOM_ACTIVE_STATUSES = Object.freeze(['active', 'trialing']);

export const FEATURE_NAMES = Object.freeze([
 'rainfallThreshold',   // rain-radar: 1h rainfall threshold condition (Plus+)
 'prefectureScope',     // prefecture-level geographic scope (Plus+)
 'municipalityScope',   // municipality-level geographic scope (Pro+)
 'strictMunicipality',  // municipality-only text extraction (Pro+)
 'imageDelivery',       // image rule types: hires-radar / tsunami-map / weather-map (Plus+)
 'hiresRadarThreshold', // hires-radar: deliver when rainfall >= threshold (Pro+)
 'tsunamiEnlarged',     // tsunami-map: enlarged images of the announced regions (Pro+)
 'weatherMunicipality', // weather-map: prefecture / municipality selection and detail (Pro+)
]);

const featureSet = enabled => Object.freeze(Object.fromEntries(FEATURE_NAMES.map(name => [name, enabled.includes(name)])));

export const NO_FEATURES = featureSet([]);
export const PLAN_FEATURES = Object.freeze({
 supporter: NO_FEATURES,
 plus: featureSet(['rainfallThreshold', 'prefectureScope', 'imageDelivery']),
 pro: featureSet(FEATURE_NAMES),
 // Geographic scope of a custom plan is decided per contract by the administrator
 // (municipalityBranching / contentExtraction); image features match Pro.
 custom: featureSet(['rainfallThreshold', 'imageDelivery', 'hiresRadarThreshold', 'tsunamiEnlarged', 'weatherMunicipality']),
});

function isCustom(item) {
 return item?.managedCustom === true || item?.planId === 'custom';
}

// Features granted by one subscription summary, or null when it grants nothing.
export function subscriptionFeatures(item) {
 if (!item || item.recognizedPlan === false || !ACTIVE_PLAN_STATUSES.includes(item.status)) return null;
 if (isCustom(item)) {
  if (!CUSTOM_ACTIVE_STATUSES.includes(item.status) || (item.managedCustom !== true && item.recognizedPlan !== true)) return null;
  const branching = !!item.municipalityBranching;
  return {...PLAN_FEATURES.custom, prefectureScope: branching, municipalityScope: branching, strictMunicipality: !!item.contentExtraction};
 }
 return PLAN_FEATURES[item.planId] || null;
}

// Union of the features of every active subscription of one account.
export function planFeatures(subscriptions = []) {
 const result = {...NO_FEATURES};
 for (const item of Array.isArray(subscriptions) ? subscriptions : []) {
  const features = subscriptionFeatures(item);
  if (!features) continue;
  for (const name of FEATURE_NAMES) if (features[name] === true) result[name] = true;
 }
 return result;
}

export function hasFeature(features, name) {
 return features?.[name] === true;
}

// Best plan tier for image rules ("plus" | "pro" | "custom"), or '' when the account
// has no image delivery (Basic or nothing active). Sent to the home server as `tier`.
export function imageTier(subscriptions = []) {
 const rank = {plus: 1, pro: 2, custom: 3};
 let best = '';
 for (const item of Array.isArray(subscriptions) ? subscriptions : []) {
  const features = subscriptionFeatures(item);
  if (!features?.imageDelivery) continue;
  const tier = isCustom(item) ? 'custom' : item.planId;
  if (rank[tier] && (!best || rank[tier] > rank[best])) best = tier;
 }
 return best;
}
