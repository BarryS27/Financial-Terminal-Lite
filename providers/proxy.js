// providers/proxy.js — Captain Proxy Manager

import { register } from '../core/registry.js';
import { get, set } from '../core/storage.js';
import { expose } from '../core/bus.js';

const KEY_PROFILES = 'c.proxy.profiles';
const KEY_ACTIVE   = 'c.proxy.active';

const BUILTINS = [
  { name: 'direct', type: 'direct', color: '#55bb55', builtin: true, desc: 'Connect directly, no proxy' },
  { name: 'system', type: 'system', color: '#888888', builtin: true, desc: 'Use system proxy settings'  },
];

const loadCustom = () => get(KEY_PROFILES).then(v => v || []);
const saveCustom = ps => set(KEY_PROFILES, ps);
const loadActive = () => get(KEY_ACTIVE).then(v => v || 'system');

async function allProfiles() { return [...BUILTINS, ...await loadCustom()]; }
async function findProfile(name) { return (await allProfiles()).find(p => p.name === name) ?? null; }

function pacStr(p) {
  if (!p || p.type === 'direct' || p.type === 'system') return 'DIRECT';
  if (p.type !== 'fixed') return 'DIRECT';
  const { protocol: pr, host, port } = p;
  if (pr === 'socks5') return `SOCKS5 ${host}:${port}`;
  if (pr === 'socks4') return `SOCKS ${host}:${port}`;
  return `PROXY ${host}:${port}`;
}

async function buildPAC(profile) {
  const all = await allProfiles();
  const resolve = name => all.find(p => p.name === name);
  const lines = (profile.rules || []).map(r => {
    const s = JSON.stringify(pacStr(resolve(r.profile)));
    const pat = JSON.stringify(r.pattern || '');
    switch (r.condType) {
      case 'domain':     return `  if(host===${pat}||host.endsWith('.'+${pat}))return ${s};`;
      case 'wildcard':   return `  if(shExpMatch(host,${pat})||shExpMatch(url,${pat}))return ${s};`;
      case 'urlwildcard':return `  if(shExpMatch(url,${pat}))return ${s};`;
      case 'regex': {
        // FIX: validate regex before embedding; fall back to no-op on invalid pattern.
        const m   = (r.pattern || '').match(/^\/(.+)\/([gimsuy]*)$/);
        const raw = m ? m[1] : r.pattern || '';
        const flg = (m ? m[2] : '').replace(/[^gimsuy]/g, ''); // strip invalid flags
        try { new RegExp(raw, flg); } catch { return '  /* invalid regex — skipped */'; }
        const src = JSON.stringify(raw);
        const fg  = JSON.stringify(flg);
        return `  if(new RegExp(${src},${fg}).test(url))return ${s};`;
      }
      default: return '';
    }
  }).filter(Boolean);
  const fallback = JSON.stringify(pacStr(resolve(profile.defaultProfile)));
  return `/* Captain proxy — auto-generated */\nfunction FindProxyForURL(url,host){\n${lines.join('\n')}\n  return ${fallback};\n}`;
}

async function apply(name) {
  const p = await findProfile(name);
  if (!p) throw new Error(`Unknown proxy profile: "${name}"`);
  await set(KEY_ACTIVE, name);
  if (p.type === 'system')  { chrome.proxy.settings.clear({ scope: 'regular' }); return; }
  if (p.type === 'direct')  { chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }); return; }
  if (p.type === 'fixed') {
    const scheme = p.protocol === 'socks5' ? 'socks5' : p.protocol === 'socks4' ? 'socks4' : p.protocol;
    chrome.proxy.settings.set({ value: { mode: 'fixed_servers', rules: {
      singleProxy: { scheme, host: p.host, port: Number(p.port) },
      bypassList: p.bypass || [],
    }}, scope: 'regular' });
    return;
  }
  if (p.type === 'pac') {
    const pacScript = p.pacUrl ? { url: p.pacUrl } : { data: p.pacData || 'function FindProxyForURL(){return"DIRECT";}' };
    chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript }, scope: 'regular' });
    return;
  }
  if (p.type === 'switch') {
    const data = await buildPAC(p);
    chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data } }, scope: 'regular' });
  }
}

async function paletteItems(q) {
  const lq     = (q || '').toLowerCase();
  const active = await loadActive();
  const all    = await allProfiles();
  const items  = [];
  if (!lq || 'proxy settings'.includes(lq))
    items.push({ id: 'proxy:open-options', title: 'Proxy: Open settings', desc: 'Manage proxy profiles', emoji: '🔀', type: 'action' });
  for (const p of all) {
    const label = `${p.name} (${p.type})`;
    if (lq && !label.toLowerCase().includes(lq)) continue;
    items.push({ id: `proxy:switch:${encodeURIComponent(p.name)}`, title: `Proxy → ${p.name}`,
      desc: p.desc || label, emoji: active === p.name ? '🟢' : '🔀', type: 'action' });
  }
  return items;
}

const NEW_PROFILE_DEFAULTS = { color: '#99ccee', type: 'fixed', protocol: 'http', host: '', port: 8080, bypass: ['localhost', '127.0.0.1'] };

async function createProfile(name, profile) {
  const ps = await loadCustom();
  if (BUILTINS.some(b => b.name === name) || ps.some(p => p.name === name)) return { ok: false, error: 'Name already exists' };
  const p = { name, ...NEW_PROFILE_DEFAULTS, ...profile };
  await saveCustom([...ps, p]);
  return { ok: true, profile: p };
}

async function updateProfile(name, patch) {
  if (BUILTINS.some(b => b.name === name)) return { ok: false, error: 'Built-in profiles are read-only' };
  const ps  = await loadCustom();
  const idx = ps.findIndex(p => p.name === name);
  if (idx < 0) return { ok: false, error: 'Not found' };
  const updated = { ...ps[idx], ...patch };
  await saveCustom(ps.with(idx, updated));
  if ((await loadActive()) === name) await apply(name).catch(() => {});
  return { ok: true, profile: updated };
}

async function deleteProfile(name) {
  if (BUILTINS.some(b => b.name === name)) return { ok: false, error: 'Built-in profiles are read-only' };
  const ps   = await loadCustom();
  const next = ps.filter(p => p.name !== name);
  if (next.length === ps.length) return { ok: false, error: 'Not found' };
  await saveCustom(next);
  if ((await loadActive()) === name) { await set(KEY_ACTIVE, 'system'); await apply('system').catch(() => {}); }
  return { ok: true };
}

async function previewPac(name) {
  const p = await findProfile(name);
  if (!p) return { ok: false, error: 'Not found' };
  if (p.type !== 'switch') return { ok: false, error: 'Only switch profiles generate PAC' };
  return { ok: true, data: await buildPAC(p) };
}

// Throws instead of returning {ok:false} — the expose() bus surfaces thrown
// errors to callers, unlike the message handlers below which need a result object.
const orThrow = res => { if (!res.ok) throw new Error(res.error); return res; };

export async function init() {
  register('proxy', paletteItems);
  try { await apply(await loadActive()); } catch (e) { console.warn('[Proxy] init:', e); }

  expose('proxy', {
    list: () => allProfiles(),
    active: async () => { const name = await loadActive(); return { name, profile: await findProfile(name) }; },
    switch: (name) => apply(name),
    create: async (name, profile) => orThrow(await createProfile(name, profile)).profile,
    update: async (name, patch) => orThrow(await updateProfile(name, patch)).profile,
    delete: async (name) => orThrow(await deleteProfile(name)),
    previewPac: async (name) => orThrow(await previewPac(name)).data,
  });
}

export function handleProxyAction(type) {
  if (!type?.startsWith('proxy:switch:')) return null;
  const name = decodeURIComponent(type.slice('proxy:switch:'.length));
  return () => apply(name).then(() => ({ ok: true, active: name }));
}

export const handlers = {
  'proxy:list': async () => ({ ok: true, profiles: await allProfiles() }),
  'proxy:active': async () => { const name = await loadActive(); return { ok: true, name, profile: await findProfile(name) }; },
  'proxy:switch': async msg => { await apply(msg.name); return { ok: true, active: msg.name }; },
  'proxy:create': async msg => createProfile(msg.name, msg.profile),
  'proxy:update': async msg => updateProfile(msg.name, msg.patch),
  'proxy:delete': async msg => deleteProfile(msg.name),
  'proxy:preview-pac': async msg => previewPac(msg.name),
  'proxy:open-options': async () => { chrome.tabs.create({ url: chrome.runtime.getURL('pages/options.html#proxy') }); return { ok: true }; },
};
