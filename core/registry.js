'use strict';

import { getCounts } from './usage.js';

const _providerRE = /^(webrtc:|fg:|ua:|bl:|proxy:|ws:|tab:|vault:|ai:)/;
const providers   = new Map();

export const register   = (id, fn) => providers.set(id, fn);
export const unregister = (id)     => providers.delete(id);

const score = (item, ql) => {
  const t = (item.title || '').toLowerCase();
  const u = (item.url   || '').toLowerCase();
  const d = (item.desc  || '').toLowerCase();
  if (t === ql)         return 200;
  if (t.startsWith(ql)) return 100;
  if (t.includes(ql))   return  40;
  if (u.includes(ql))   return  20;
  if (d.includes(ql))   return   5;
  return 0;
};

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);

export const query = async (text) => {
  const [settled, usageCounts] = await Promise.all([
    Promise.allSettled(
      [...providers.values()].map(p => withTimeout(p(text), 800))
    ),
    getCounts(),
  ]);

  const flat = settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  if (!text) {
    const isAction = a => a.type === 'action' || _providerRE.test(a.id || '');
    const actions  = flat.filter(isAction);
    const rest     = flat.filter(a => !isAction(a));
    actions.sort((a, b) => (usageCounts[b.id] || 0) - (usageCounts[a.id] || 0));
    return [...actions, ...rest];
  }

  const ql = text.toLowerCase();
  return flat
    .map(item => {
      const textScore  = score(item, ql);
      const usageBoost = Math.min((usageCounts[item.id] || 0) * 2, 50);
      return { item, s: textScore + usageBoost };
    })
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(({ item }) => item);
};
