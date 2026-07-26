// providers/blacklist.js — merged into focus-guard
// This file is intentionally empty — blacklist functionality is now
// fully integrated into providers/focus-guard.js (see SERP filter section).
// Kept as a re-export shim so any external references do not break at import time.

export async function init() {}
export const handlers = {};
export async function isBlocked() { return false; }
