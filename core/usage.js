// core/usage.js — Command usage frequency tracker
// Stores hit counts in chrome.storage.local under 'c.usage.counts'
// Used by registry.js to boost frequently-used items in sort order

const KEY = 'c.usage.counts';

export async function recordUse(id) {
  if (!id) return;
  const r = await chrome.storage.local.get(KEY);
  const counts = r[KEY] || {};
  counts[id] = (counts[id] || 0) + 1;
  await chrome.storage.local.set({ [KEY]: counts });
}

export async function getCounts() {
  const r = await chrome.storage.local.get(KEY);
  return r[KEY] || {};
}
