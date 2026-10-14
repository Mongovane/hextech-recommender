import { champIcon, DD } from './resg.js';
// arammeta 备用数据源（MIT 开源，台服 LCU 众包真实对局，每日更新）
// https://arammeta.com/api/tier-list.json — 英雄胜率 + 分稀有度海克斯胜率统计
// 仅在 RESG 失败时启用；海克斯名/图标用本站 RESG 元数据（简体），数字走 arammeta

const AM = 'https://arammeta.com/api/tier-list.json';
const AM_ICON = 'https://arammeta.com/';
let mem = null;

export async function fetchArammeta(ctx) {
  if (mem) return mem;
  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const key = new Request('https://am-cache.local/tier-list');
  const hit = cache ? await cache.match(key).catch(() => null) : null;
  if (hit) {
    mem = await hit.json();
    return mem;
  }
  const r = await fetch(AM, {
    headers: { 'User-Agent': 'hextech-recommender/0.3' },
    cf: { cacheTtl: 21600 },
  });
  if (!r.ok) throw new Error(`arammeta ${r.status}`);
  const data = await r.json();
  mem = data;
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));
    if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => {}));
    else await put.catch(() => {});
  }
  return data;
}

// 单英雄详情：含胜率出装（items/singleItems/boots/spells）
export async function fetchArammetaDetail(numericId, ctx) {
  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const key = new Request(`https://am-cache.local/champ-${numericId}`);
  const hit = cache ? await cache.match(key).catch(() => null) : null;
  if (hit) return hit.json();
  const r = await fetch(`${AM.replace('/api/tier-list.json', '')}/api/champions/${numericId}.json`, {
    headers: { 'User-Agent': 'hextech-recommender/0.3' },
    cf: { cacheTtl: 21600 },
  });
  if (!r.ok) throw new Error(`arammeta detail ${r.status}`);
  const data = await r.json();
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));
    if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => {}));
    else await put.catch(() => {});
  }
  return data;
}

// 出装胜率数据 → 本站形状（id 直通 Data Dragon；名称优先简体官方字典）
export function arammetaBuilds(detail, ddDict) {
  const itemName = (id, fallback) => ddDict?.[String(id)]?.name || fallback || `装备#${id}`;
  const itemIcon = (id) => `${DD}/img/item/${id}.png`;
  const itemDesc = (id) => ddDict?.[String(id)]?.desc || null;
  const itemPrice = (id) => ddDict?.[String(id)]?.price ?? null;
  const slimCombo = (c) => ({
    name: (c.items || []).map((it) => itemName(it.id, null)).filter(Boolean).join(' + ') || c.name_zh,
    items: (c.items || []).map((it) => ({ id: it.id, name: itemName(it.id, null), icon: itemIcon(it.id), desc: itemDesc(it.id), price: itemPrice(it.id) })),
    wr: c.wr ?? null, games: c.g ?? 0, lift: c.lift ?? null,
  });
  const slimSingle = (s) => ({
    id: +s.slug || null, name: itemName(s.slug, s.name_zh), icon: itemIcon(s.slug), desc: itemDesc(s.slug), price: itemPrice(s.slug),
    wr: s.wr ?? null, games: s.g ?? 0,
  });
  const items = detail?.items || {};
  const singles = detail?.singleItems || {};
  const boots = detail?.boots || {};
  const spells = detail?.spells || {};
  return {
    combos: (items.top || []).slice(0, 3).map(slimCombo),
    badCombos: (items.bot || []).slice(0, 3).map(slimCombo),
    singles: (singles.top || []).slice(0, 8).map(slimSingle),
    boots: (() => {
      const rawB = (boots.top || []).map(slimSingle);
      const stdB = rawB.filter(x => !String(x.name || '').includes('暴食'));
      const listB = stdB.length ? stdB : rawB;
      const maxG = Math.max(1, ...listB.map(x => x.games || 0));
      const mainB = listB.filter(x => (x.games || 0) >= maxG * 0.2);
      const poolB = mainB.length ? mainB : listB;
      poolB.sort((a, b) => (b.games || 0) - (a.games || 0));
      return poolB.slice(0, 3);
    })(),
    spells: (spells.top || []).slice(0, 2).map((s) => {
      const SMAP = {
        '閃現': ['闪现', 'SummonerFlash.png'], '闪现': ['闪现', 'SummonerFlash.png'], 'Flash': ['闪现', 'SummonerFlash.png'],
        '鬼步': ['疾跑', 'SummonerHaste.png'], '疾跑': ['疾跑', 'SummonerHaste.png'], '幽灵疾步': ['疾跑', 'SummonerHaste.png'], '幽靈疾步': ['疾跑', 'SummonerHaste.png'], 'Ghost': ['疾跑', 'SummonerHaste.png'],
        '標記': ['标记', 'SummonerSnowball.png'], '标记': ['标记', 'SummonerSnowball.png'], '雪球': ['标记', 'SummonerSnowball.png'], 'Mark': ['标记', 'SummonerSnowball.png'],
        '點燃': ['点燃', 'SummonerDot.png'], '点燃': ['点燃', 'SummonerDot.png'], '引燃': ['点燃', 'SummonerDot.png'], 'Ignite': ['点燃', 'SummonerDot.png'],
        '治療': ['治疗', 'SummonerHeal.png'], '治癒': ['治疗', 'SummonerHeal.png'], '治愈': ['治疗', 'SummonerHeal.png'], '治疗': ['治疗', 'SummonerHeal.png'], '治疗术': ['治疗', 'SummonerHeal.png'], '治療術': ['治疗', 'SummonerHeal.png'], 'Heal': ['治疗', 'SummonerHeal.png'],
        '虛弱': ['虚弱', 'SummonerExhaust.png'], '虚弱': ['虚弱', 'SummonerExhaust.png'], 'Exhaust': ['虚弱', 'SummonerExhaust.png'],
        '屏障': ['屏障', 'SummonerBarrier.png'], '光盾': ['屏障', 'SummonerBarrier.png'], 'Barrier': ['屏障', 'SummonerBarrier.png'],
        '傳送': ['传送', 'SummonerTeleport.png'], '传送': ['传送', 'SummonerTeleport.png'], 'Teleport': ['传送', 'SummonerTeleport.png'],
        '懲戒': ['惩戒', 'SummonerSmite.png'], '惩戒': ['惩戒', 'SummonerSmite.png'], 'Smite': ['惩戒', 'SummonerSmite.png'],
        '淨化': ['净化', 'SummonerBoost.png'], '净化': ['净化', 'SummonerBoost.png'], 'Cleanse': ['净化', 'SummonerBoost.png'],
        '清晰': ['清晰', 'SummonerMana.png'], '清晰術': ['清晰', 'SummonerMana.png'], '清晰术': ['清晰', 'SummonerMana.png'], 'Clarity': ['清晰', 'SummonerMana.png']
      };
      const parts = String(s.name_zh || '').split('+').map(p => p.trim()).filter(Boolean);
      const names = [], icons = [];
      for (const p of parts) {
        const hit = SMAP[p];
        names.push(hit ? hit[0] : p);
        if (hit) icons.push(`${DD}/img/spell/${hit[1]}`);
      }
      return { name: names.join(' + ') || s.name_zh, icon: icons.length === 1 ? icons[0] : '', icons, wr: s.wr ?? null, games: s.g ?? 0 };
    }),
  };
}

// /api/champions 形状
export function arammetaChampions(data) {
  const out = [];
  for (const [id, c] of Object.entries(data?.champs || {})) {
    out.push({
      id: +id, name: c.name_zh || c.name_en, title: c.name_zh || c.name_en || '', alias: c.alias || null,
      wr: c.wr ?? null, tm: c.g ?? 0, tier: null,
      icon: champIcon(c.alias, null),
    });
  }
  return out;
}

// /api/champion-detail 形状（augIds 取全局池，augWr 优先单英雄、缺省用全局）
export function arammetaChampionDetail(data, numericId) {
  const c = data?.champs?.[String(numericId)];
  if (!c) return null;
  const augMeta = data.augs || {};
  const tops = [];
  for (const k of ['kPrismatic', 'kGold', 'kSilver']) {
    for (const t of (c.top?.[k] || [])) tops.push({ id: t.id, wr: t.wr, g: t.g, rarity: k });
  }
  tops.sort((a, b) => b.wr - a.wr);
  const seen = new Set(tops.map((t) => t.id));
  const augWr = tops.map((t) => [t.id, t.wr, t.g]);
  for (const [id, a] of Object.entries(augMeta)) {
    if (!seen.has(+id) && a.wr != null) augWr.push([+id, a.wr, a.g ?? 0]);
  }
  const topAugments = tops.slice(0, 8).map((t) => {
    const m = augMeta[String(t.id)] || {};
    return {
      id: t.id,
      name: m.name_zh || m.name_en || `海克斯#${t.id}`,
      wr: t.wr, tm: t.g,
      icon: m.icon ? AM_ICON + m.icon : null,
    };
  });
  return {
    version: data.patch_prefix || '16.20',
    champion: {
      id: +numericId, name: c.name_zh || c.name_en, title: '', alias: c.alias || null,
      wr: c.wr ?? null, tm: c.g ?? 0, tier: null,
      icon: champIcon(c.alias, null),
    },
    buffs: [],
    topAugments,
    augIds: Object.keys(augMeta).map(Number),
    augWr,
    source: 'arammeta-backup',
  };
}
