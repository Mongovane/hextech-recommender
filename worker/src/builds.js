// 出装推荐：主源 arammeta（真实胜率统计），cchappy 降为补充（陷阱海克斯/技能加点）+ 兜底
// 静态资源（图标/名称）走官方 Data Dragon CDN



const CC = 'https://test.cchappy.top/api/public/hextech-aram';

export async function ccFetch(path, ctx) {
  // 三层：cf 边缘缓存(1h) → 成功后写 Cache API 快照 → 失败时读快照兜底
  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const key = new Request('https://builds-cache.local' + path);
  try {
    const up = await fetch(CC + path, {
      headers: { 'User-Agent': 'hextech-recommender/0.3' },
      cf: { cacheTtl: 3600 },
    });
    if (!up.ok) throw new Error(`cchappy ${up.status} ${path}`);
    const data = await up.json();
    if (cache) {
      const put = cache.put(key, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));
      if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => {}));
      else await put.catch(() => {});
    }
    return { data, stale: false };
  } catch (e) {
    const hit = cache ? await cache.match(key).catch(() => null) : null;
    if (hit) return { data: await hit.json(), stale: true };
    throw e;
  }
}

const slimItem = (it) => {
  if (!it || it.id == null) return null;
  return {
    id: it.id,
    name: it.name || `装备#${it.id}`,
    price: it.price ?? null,
    desc: String(it.description || '').replace(/\s+/g, ' ').trim().slice(0, 160) || null,
    icon: `${DD}/img/item/${it.id}.png`,
    qty: it.quantity > 1 ? it.quantity : null,
  };
};
const slimList = (arr) => (arr || []).map(slimItem).filter(Boolean);

// 官方字典覆盖：名称/价格/描述/图标以 Data Dragon 为准，cchappy 只提供"出什么"
function enrichWithOfficial(items, dict) {
  if (!dict) return items;
  return items.map((it) => {
    const off = dict[String(it.id)];
    return off ? { ...it, name: off.name || it.name, price: off.price ?? it.price, desc: off.desc || it.desc, icon: off.icon || it.icon } : it;
  });
}
