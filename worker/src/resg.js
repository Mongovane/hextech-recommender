// RESG 数据层：fetch（cf 边缘缓存）+ 查询 + 图标 URL
import { parseModule } from './core.js';
export const RESG = 'https://resg.top/api/v1';
// ---------------- Worker ----------------
// caches.default 在 workers.dev 域名下不生效，改用 fetch 的 cf 缓存；versions 列表短缓存以便及时发现新版本
export async function resgFetch(path) {
  const ttl = path === '/versions.js' ? 600 : 86400;
  const up = await fetch(RESG + path, {
    headers: { 'User-Agent': 'resg-jev-worker/0.2' },
    cf: { cacheEverything: true, cacheTtl: ttl },
  });
  if (!up.ok) throw new Error(`RESG ${up.status} ${path}`);
  return parseModule(await up.text());
}

export const ico = (p) => (p ? 'https://resg.top' + p : null);
// 官方 Data Dragon（静态资源优先走官方）
export const DD_VER = '16.19.1';
export const DD = `https://ddragon.leagueoflegends.com/cdn/${DD_VER}`;
export const champIcon = (alias, fallback) => (alias ? `${DD}/img/champion/${alias}.png` : fallback);
export function findByQuery(items, q, fields) {
  const s = String(q).trim().toLowerCase();
  return items.find((it) => String(it.id) === s || fields.some((f) => String(it[f] ?? '').toLowerCase() === s));
}
export async function latestVersion() { return (await resgFetch('/versions.js'))[0].version; }
