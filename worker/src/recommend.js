import { buildCandidateContextData, buildState, buildJevBody, buildConflictBody, extractPick, effWr, getBalanceTone } from './core.js';
import { resgFetch, findByQuery, latestVersion, ico, champIcon } from './resg.js';
// 推荐：jev 决策 + 本地降级 + 英雄详情


export const JEV = 'https://api.typesafe.ai/v1/systemone';
export async function jevCall(env, body) {
  const jr = await fetch(JEV, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!jr.ok) throw new Error(`jev ${jr.status}`);
  return jr.json();
}

export async function recommend({ champion, augments, version, picked = [], mode }, env) {
  const v = version ?? (await latestVersion());
  const [champs, augs] = await Promise.all([resgFetch(`/versions/${v}/champions.js`), resgFetch(`/versions/${v}/augments.js`)]);
  const champEnt = findByQuery(champs.items, champion, ['name', 'title', 'alias']);
  if (!champEnt) throw new Error(`找不到英雄：${champion}`);
  const seen = new Set();
  const augEnts = augments.map((q) => {
    const a = findByQuery(augs.items, q, ['name']);
    if (!a) throw new Error(`找不到海克斯：${q}`);
    return a;
  }).filter((a) => !seen.has(a.id) && seen.add(a.id));
  const pickedNames = [...new Set(picked.map(String).map((s) => s.trim()).filter(Boolean))]
    .map((q) => findByQuery(augs.items, q, ['name'])?.name).filter(Boolean);
  const detail = await resgFetch(`/versions/${v}/champions/${champEnt.id}.js`);
  const { champion: ch, buffs, rows } = buildCandidateContextData(detail, augs, augEnts.map((a) => a.id));
  const state = buildState(v, ch, buffs, rows, pickedNames);

  const rankedLocal = rows
    .map((r) => ({ name: r.name, champWr: r.champWr, champTm: r.champTm, globalWr: r.globalWr, score: null, _e: effWr(r) }))
    .sort((a, b) => b._e - a._e)
    .map(({ _e, ...r }) => ({ ...r, eff: _e }));
  const local = (extra = {}) => ({ version: v, pick: rankedLocal[0].name, confidence: null, source: 'local-fallback', conflictProb: null, ranking: rankedLocal, usage: null, ...extra });

  // mode=wr（纯胜率）或未配置 jev：不调用 jev，直接按修正胜率排序
  if (mode === 'wr' || !env.TYPESAFE_API_KEY) return local({ source: 'win-rate', degraded: mode === 'wr' ? null : 'no-key' });

  let jevData;
  try { jevData = await jevCall(env, buildJevBody({ state, rows })); }
  catch (e) { return local({ source: 'win-rate', degraded: 'jev-error', jevError: String(e.message || e) }); }
  const { pick, confidence, distribution, ranking, usage } = extractPick(jevData, rows.length);

  // 冲突检测：只对选中的那个问一次；失败不影响主结果
  let conflictProb = null;
  const pickedRow = rows.find((r) => r.name === pick);
  if (pickedRow) {
    try { conflictProb = (await jevCall(env, buildConflictBody({ state, row: pickedRow })))?.answers?.no_conflict?.noul ?? null; } catch {}
  }

  const ranked = rows
    .map((r, i) => ({ name: r.name, champWr: r.champWr, champTm: r.champTm, globalWr: r.globalWr, score: ranking[i]?.score ?? null, eff: effWr(r) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  // 三选一置信度天然偏低，阈值放宽到 0.4
  const ok = pick && (confidence === null || confidence >= 0.4) && (conflictProb === null || conflictProb < 0.5);
  return {
    version: v, pick: ok ? pick : rankedLocal[0].name, confidence, distribution, conflictProb,
    source: ok ? 'jev' : 'win-rate', degraded: ok ? null : ((conflictProb ?? 0) >= 0.5 ? 'conflict' : 'low-confidence'),
    ranking: ok ? ranked : rankedLocal, usage,
  };
}

export async function championDetail(query, version) {
  const v = version ?? (await latestVersion());
  const [champs, augs] = await Promise.all([resgFetch(`/versions/${v}/champions.js`), resgFetch(`/versions/${v}/augments.js`)]);
  const champEnt = findByQuery(champs.items, query, ['name', 'title', 'alias']);
  if (!champEnt) throw new Error(`找不到英雄：${query}`);
  const detail = await resgFetch(`/versions/${v}/champions/${champEnt.id}.js`);
  const { champion, bb = {}, ra = [] } = detail;
  const buffs = Object.entries(bb).map(([label, value]) => ({ label, value, tone: getBalanceTone(label, value) }));
  const augById = new Map(augs.items.map((a) => [a.id, a]));
  const topAugments = ra.slice().sort((a, b) => b[2] - a[2]).slice(0, 5).map((r) => {
    const a = augById.get(r[0]);
    return { id: r[0], name: a?.name ?? `海克斯#${r[0]}`, wr: r[4] / 1e4, tm: r[2], icon: ico(a?.ip) };
  });
  // augIds：该英雄有对局数据的海克斯 id，前端据此过滤
  return { version: v, champion: { ...champion, icon: champIcon(champion.alias ?? champEnt.alias, ico(champion.ip ?? champEnt.ip)) }, buffs, topAugments, augIds: ra.map((r) => r[0]), augWr: ra.map((r) => [r[0], r[4] / 1e4, r[2]]) };
}
