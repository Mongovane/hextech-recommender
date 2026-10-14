import { cleanDesc } from './core.js';
import { DD } from './resg.js';
// 官方 Data Dragon 装备字典：名称/价格/描述/图标以官方为准
// item.json 约 700KB，精简后经 Cache API + 内存缓存，只拉一次


let memDict = null;

export async function getItemDict(ctx) {
  if (memDict) return memDict;
  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const key = new Request('https://dd-cache.local/items-' + DD.split('/cdn/')[1].split('/')[0]);
  const hit = cache ? await cache.match(key).catch(() => null) : null;
  if (hit) {
    memDict = await hit.json();
    return memDict;
  }
  const r = await fetch(`${DD}/data/zh_CN/item.json`, { cf: { cacheTtl: 86400 } });
  if (!r.ok) throw new Error(`ddragon item.json ${r.status}`);
  const raw = (await r.json()).data || {};
  const dict = {};
  for (const [id, it] of Object.entries(raw)) {
    dict[id] = {
      name: it.name || null,
      price: it.gold?.total ?? null,
      desc: cleanDesc(it.description || '').slice(0, 260) || null,
      icon: `${DD}/img/item/${id}.png`,
    };
  }
  memDict = dict;
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(dict), { headers: { 'content-type': 'application/json' } }));
    if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => {}));
    else await put.catch(() => {});
  }
  return dict;
}
