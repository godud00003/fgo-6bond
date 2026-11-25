// 클리어 가능한 전열 조합을 찾고, 그 위에서 인연 포인트 총합이 최대가 되는 파티·예장을 고른다.
import { simulateBest } from './sim.ts';
import type { ActorCfg, BondCE, QuestData, Rel, Servant, SimResult } from './types.ts';

export interface PoolEntry { svt: Servant; npLv: number; skillLv: number; atk: number; weight: number; bond15?: boolean }
export interface CEStock { ce: BondCE; count: number; mlb: boolean }
export interface Settings {
  maxTurns: number; costCap: number; roll: number; startNp: number;
  friendCe: { no: number; mlb: boolean } | null; topN: number;
  /** 찻주전자 배수(1 = 미사용). 최종 인연 포인트에 곱해진다. */
  teapot: number;
}
export interface Member { svt: Servant; friend: boolean; role: 'dealer' | 'support' | 'filler'; bond: number; counted: boolean }
export interface PartyResult {
  turns: number; front: Member[]; back: Member[]; ces: { ce: BondCE; mlb: boolean }[];
  friendCe: BondCE | null; total: number; cost: number; sim: SimResult;
}
export interface SearchOutput { results: PartyResult[]; simulated: number; feasible: number; bestFail: { names: string[]; sim: SimResult } | null }

/** 주회 서포터로 쓰이는 서번트(도감 번호) */
export const SUPPORT_NOS = [284, 314, 316, 215, 357, 37, 150, 353, 62, 241, 307, 90, 34, 79, 249];

interface Core { own: PoolEntry[]; friend: Servant | null; roles: Map<number, 'dealer' | 'support'>; sim: SimResult }

const condMatch = (cond: number[][], traits: number[]) => !cond.length || cond.some((g) => g.every((t) => traits.includes(t)));

export function search(
  pool: PoolEntry[], all: Servant[], stock: CEStock[], quest: QuestData, rel: Rel, st: Settings,
  onProgress?: (done: number, total: number) => void,
): SearchOutput {
  const byNo = new Map(pool.map((p) => [p.svt.no, p]));
  const allByNo = new Map(all.map((s) => [s.no, s]));
  const cfg = (p: PoolEntry, role: 'dealer' | 'support'): ActorCfg =>
    ({ svt: p.svt, npLv: p.npLv, skillLv: p.skillLv, atk: p.atk, startNp: st.startNp, role });
  const friendCfg = (s: Servant): ActorCfg =>
    ({ svt: s, npLv: 1, skillLv: 10, atk: s.atk.max + 1000, startNp: st.startNp, role: 'support', friend: true });

  const dealers = pool.filter((p) => p.svt.np?.dmg);
  const supports = SUPPORT_NOS.filter((n) => allByNo.has(n));
  // 서포터 조합: 없음, 1명, 2명(같은 서번트 2명 포함)
  const combos: number[][] = [[]];
  for (const a of supports) combos.push([a]);
  for (let i = 0; i < supports.length; i++) for (let j = i; j < supports.length; j++) combos.push([supports[i], supports[j]]);

  const cores: Core[] = [];
  let simulated = 0;
  let bestFail: SearchOutput['bestFail'] = null;
  const noteFail = (names: string[], sim: SimResult) => { if (!bestFail || sim.killed > bestFail.sim.killed) bestFail = { names, sim }; };
  const total = dealers.length * combos.length;
  let done = 0;

  /** 서포터 조합에서 누가 프렌드 자리를 쓰는지에 따른 변형들 */
  const variants = (combo: number[], exclude: number[]): { own: PoolEntry[]; friend: Servant | null }[] => {
    const out: { own: PoolEntry[]; friend: Servant | null }[] = [];
    const ownOk = (n: number) => byNo.has(n) && !exclude.includes(n);
    if (combo.length === 0) return [{ own: [], friend: null }];
    if (combo.length === 1) {
      out.push({ own: [], friend: allByNo.get(combo[0])! });
      if (ownOk(combo[0])) out.push({ own: [byNo.get(combo[0])!], friend: null });
      return out;
    }
    const [a, b] = combo;
    if (a === b) { if (ownOk(a)) out.push({ own: [byNo.get(a)!], friend: allByNo.get(a)! }); return out; }
    if (ownOk(a)) out.push({ own: [byNo.get(a)!], friend: allByNo.get(b)! });
    if (ownOk(b)) out.push({ own: [byNo.get(b)!], friend: allByNo.get(a)! });
    if (ownOk(a) && ownOk(b)) out.push({ own: [byNo.get(a)!, byNo.get(b)!], friend: null });
    return out;
  };

  const tryCores = (ds: PoolEntry[], combo: number[]): boolean => {
    const dNos = ds.map((d) => d.svt.no);
    const vs = variants(combo, dNos);
    if (!vs.length) return false;
    // 전투 결과는 누가 프렌드든 같다고 보고(프렌드는 풀스펙 가정) 한 번만 시뮬레이션
    const v0 = vs[vs.length - 1];
    const front = [...ds.map((d) => cfg(d, 'dealer')), ...v0.own.map((p) => cfg(p, 'support')), ...(v0.friend ? [friendCfg(v0.friend)] : [])];
    const sim = simulateBest(front, quest, rel, st.maxTurns, st.roll);
    simulated++;
    if (!sim.cleared) { noteFail(front.map((f) => f.svt.name), sim); return false; }
    for (const v of vs) {
      const roles = new Map<number, 'dealer' | 'support'>();
      for (const d of ds) roles.set(d.svt.no, 'dealer');
      for (const p of v.own) roles.set(p.svt.no, 'support');
      cores.push({ own: [...ds, ...v.own], friend: v.friend, roles, sim });
    }
    return true;
  };

  for (const d of dealers) {
    const okSingles = new Set<number>();
    let solo = false;
    for (const combo of combos) {
      done++;
      if (solo || combo.includes(d.svt.no)) continue;
      if (combo.some((n) => okSingles.has(n))) continue; // 더 작은 조합으로 이미 클리어 가능
      if (tryCores([d], combo)) {
        if (combo.length === 0) solo = true;
        else if (combo.length === 1) okSingles.add(combo[0]);
      }
    }
    onProgress?.(done, total);
  }

  // 딜러 1명으로 안 되면 딜러 2~3명 조합을 시도
  if (!cores.length && dealers.length > 1) {
    const solo = dealers.map((d) => ({ d, sim: simulateBest([cfg(d, 'dealer')], quest, rel, st.maxTurns, st.roll) }));
    const dmg = (s: SimResult) => s.log.reduce((n, t) => n + t.nps.reduce((m, x) => m + x.hits.reduce((k, h) => k + Math.min(h.dmg, h.hp), 0), 0), 0);
    const top = solo.map((x) => ({ d: x.d, score: dmg(x.sim) })).sort((a, b) => b.score - a.score).slice(0, 14).map((x) => x.d);
    const single = combos.filter((c) => c.length <= 1);
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
      for (const c of single) if (tryCores([top[i], top[j]], c) && c.length === 0) break;
    }
    if (!cores.length) {
      const t3 = top.slice(0, 9);
      for (let i = 0; i < t3.length; i++) for (let j = i + 1; j < t3.length; j++) for (let k = j + 1; k < t3.length; k++) tryCores([t3[i], t3[j], t3[k]], []);
    }
  }

  const results = optimizeBond(cores, pool, stock, quest, st);
  return { results, simulated, feasible: cores.length, bestFail: cores.length ? null : bestFail };
}

// ---------------------------------------------------------------- 인연 포인트 최적화

// 한국 서버 게임 상수(Atlas NiceConstant): STARTING_MEMBER_FRIENDSHIP_RATE 1200, MAX_FRIEND_SHIP_UP_RATIO 3000
/** 전열에 선 내 서번트 본인에게 붙는 보너스(‰) */
export const FRONT_OWN = 200;
/** 프렌드 서포트가 전열에 서면 파티 전원에게 붙는 보너스(‰) */
export const FRONT_FRIEND = 40;
/** 인연 15인 내 서번트 1기마다 파티 전원에게 붙는 보너스(‰). 예장 %와 합산된다. */
export const BOND15 = 250;
/** 예장·이벤트 % 합의 상한(‰) */
export const PCT_CAP = 3000;
// 5기 편성의 평균 전열 보너스(내 서번트 3기 전열 = 프렌드 포함 2기 전열 = 12%). 조건 없는 예장을 고를 때의 근사치.
const AVG_FRONT = 1.12;

/** 인연 포인트 = 내림(내림(기본치 × (1 + 전열 보너스)) × (1 + % 합)) + 고정치. 찻주전자 배수는 이 값에 곱한다. */
export function bondFor(base: number, front: number, pct: number, flat: number): number {
  const b = Math.floor((base * (1000 + front)) / 1000);
  return Math.floor((b * (1000 + Math.min(pct, PCT_CAP))) / 1000) + flat;
}

interface UniItem { ce: BondCE; mlb: boolean; cost: number; g: number; pct: number; flat: number }
interface Node { item: UniItem; prev: Node | null; pct: number; flat: number }

function optimizeBond(cores: Core[], pool: PoolEntry[], stock: CEStock[], quest: QuestData, st: Settings): PartyResult[] {
  if (!cores.length) return [];
  const base = quest.bond;
  const cap = st.costCap;
  const SLOTS = 5;
  const pctOf = (s: CEStock) => s.ce.val[s.mlb ? 1 : 0];

  // 프렌드 예장: 슬롯·코스트를 쓰지 않고 효과만 더해진다
  const fStock = st.friendCe ? stock.find((s) => s.ce.no === st.friendCe!.no) : undefined;
  const fCe = fStock?.ce ?? null;
  const fMlb = st.friendCe?.mlb ? 1 : 0;
  const fPct = fCe && fCe.kind === 'pct' ? (fCe.sup ? fCe.sup[fMlb] : fCe.val[fMlb]) : 0;
  const fFlat = fCe && fCe.kind === 'flat' ? fCe.val[fMlb] : 0;
  const friendPctFor = (traits: number[]) => (fCe && fCe.kind === 'pct' && condMatch(fCe.cond, traits) ? fPct : 0);

  // 조건부 예장은 조건별로 묶는다(영령봉마 7종은 같은 조건)
  interface CondType { cond: number[][]; copies: { ce: BondCE; mlb: boolean; pct: number; cost: number }[] }
  const condTypes: CondType[] = [];
  const uni: UniItem[] = [];
  for (const s of stock) {
    if (s.count <= 0) continue;
    const n = Math.min(s.count, SLOTS);
    if (s.ce.kind === 'pct' && s.ce.cond.length) {
      const key = JSON.stringify(s.ce.cond);
      let t = condTypes.find((x) => JSON.stringify(x.cond) === key);
      if (!t) condTypes.push((t = { cond: s.ce.cond, copies: [] }));
      for (let i = 0; i < n; i++) t.copies.push({ ce: s.ce, mlb: s.mlb, pct: pctOf(s), cost: s.ce.cost });
    } else {
      const isFlat = s.ce.kind === 'flat';
      const g = isFlat ? pctOf(s) : (base * AVG_FRONT * pctOf(s)) / 1000;
      for (let i = 0; i < n; i++) uni.push({ ce: s.ce, mlb: s.mlb, cost: s.ce.cost, g, pct: isFlat ? 0 : pctOf(s), flat: isFlat ? pctOf(s) : 0 });
    }
  }
  for (const t of condTypes) t.copies.sort((a, b) => b.pct - a.pct || a.cost - b.cost);

  // 조건 없는 예장: 슬롯 j개, 코스트 c 이하에서 얻는 서번트 1기당 최대 이득
  const dp: number[][] = [], pick: (Node | null)[][] = [];
  for (let j = 0; j <= SLOTS; j++) { dp.push(new Array(cap + 1).fill(j === 0 ? 0 : -1)); pick.push(new Array(cap + 1).fill(null)); }
  for (const it of uni) {
    for (let j = SLOTS; j >= 1; j--) for (let c = cap; c >= it.cost; c--) {
      const prev = dp[j - 1][c - it.cost];
      if (prev >= 0 && prev + it.g > dp[j][c]) {
        const pn = pick[j - 1][c - it.cost];
        dp[j][c] = prev + it.g;
        pick[j][c] = { item: it, prev: pn, pct: (pn?.pct ?? 0) + it.pct, flat: (pn?.flat ?? 0) + it.flat };
      }
    }
  }
  const uniBest = (r: number, budget: number): { g: number; node: Node | null } => {
    let g = 0, node: Node | null = null;
    for (let j = 1; j <= r; j++) for (let c = 0; c <= Math.min(budget, cap); c++) if (dp[j][c] > g) { g = dp[j][c]; node = pick[j][c]; }
    return { g, node };
  };
  const uniCache = new Map<number, { g: number; node: Node | null }>();
  const uniGet = (r: number, budget: number) => {
    const k = r * 1000 + budget;
    let v = uniCache.get(k);
    if (!v) uniCache.set(k, (v = uniBest(r, budget)));
    return v;
  };

  const match = pool.map((p) => condTypes.map((t) => condMatch(t.cond, p.svt.traits)));
  const idx = new Map(pool.map((p, i) => [p.svt.no, i]));
  const is15 = pool.map((p) => (p.bond15 ? 1 : 0));
  const fCond = pool.map((p) => friendPctFor(p.svt.traits));
  const fUniPct = fCe && fCe.kind === 'pct' && !fCe.cond.length ? fPct : 0;

  // 코어는 보유 멤버 구성이 같으면 턴 수가 적은 것만 남긴다
  const uniq = new Map<string, Core>();
  for (const c of cores) {
    const k = c.own.map((p) => p.svt.no).sort((a, b) => a - b).join(',');
    const cur = uniq.get(k);
    if (!cur || c.sim.turns < cur.sim.turns) uniq.set(k, c);
  }
  const coreList = [...uniq.values()].sort((a, b) => a.own.length - b.own.length || a.sim.turns - b.sim.turns).slice(0, 600);

  interface Best { value: number; core: Core; vec: number[]; fillers: number[]; uni: Node | null }
  const bests = new Map<Core, Best>();

  // 전열 자리 우선순위: 인연을 받는 서번트 먼저, 그중 조건부 %가 높은 순
  const frontKey = (i: number, condPct: number[]) => pool[i].weight * (10000 + condPct[i]);

  // 조건부 예장 장수 벡터 열거
  const vec = new Array(condTypes.length).fill(0);
  const costs = [...new Set(pool.filter((p) => p.weight > 0).map((p) => p.svt.cost))].sort((a, b) => a - b);
  const evalVec = () => {
    const used = vec.reduce((a, b) => a + b, 0);
    let cc = 0;
    const typePct = condTypes.map((t, i) => { let s = 0; for (let k = 0; k < vec[i]; k++) { s += t.copies[k].pct; cc += t.copies[k].cost; } return s; });
    if (cc > cap) return;
    const condPct = pool.map((_, i) => { let s = fCe && fCe.cond.length ? fCond[i] : 0; for (let t = 0; t < condTypes.length; t++) if (match[i][t]) s += typePct[t]; return s; });
    // 코스트별 후보(조건 일치율 높은 순) + 인연이 필요 없는 저코스트 서번트
    const classes: number[][] = costs.map((c) =>
      pool.map((_, i) => i).filter((i) => pool[i].weight > 0 && pool[i].svt.cost === c).sort((a, b) => condPct[b] - condPct[a]).slice(0, 9));
    const zero = pool.map((_, i) => i).filter((i) => pool[i].weight <= 0).sort((a, b) => is15[b] - is15[a] || pool[a].svt.cost - pool[b].svt.cost).slice(0, 9);
    if (zero.length) classes.push(zero);
    const r = SLOTS - used;

    for (const core of coreList) {
      const ownIdx = core.own.map((p) => idx.get(p.svt.no)!);
      const free = Math.min(SLOTS - ownIdx.length, pool.length - ownIdx.length);
      // 전열 보너스: 코어(딜러·서포터)는 항상 전열, 남는 전열 자리는 인연을 가장 많이 받는 서번트에게 준다
      const allFront = core.friend ? FRONT_FRIEND : 0;
      const frontFree = Math.max(0, 3 - (core.friend ? 1 : 0) - ownIdx.length);
      const coreMul = (1000 + FRONT_OWN + allFront) / 1000, backMul = (1000 + allFront) / 1000;
      // a = Σ 가중치×전열배율, c = Σ 가중치×전열배율×조건부%
      let costM = cc, wM = 0, aM = 0, cM = 0, n15M = 0;
      for (const i of ownIdx) {
        const w = pool[i].weight;
        n15M += is15[i];
        costM += pool[i].svt.cost; wM += w; aM += w * coreMul; cM += w * coreMul * condPct[i];
      }
      if (costM > cap) continue;
      const chosen: number[] = [];
      const rec = (ci: number, left: number, cost: number) => {
        if (left === 0) {
          const u = uniGet(r, cap - cost);
          const order = frontFree ? chosen.slice().sort((x, y) => frontKey(y, condPct) - frontKey(x, condPct)) : chosen;
          let w = wM, a = aM, c = cM, n15 = n15M;
          order.forEach((i, k) => {
            n15 += is15[i];
            const wi = pool[i].weight, mul = k < frontFree ? coreMul : backMul;
            w += wi; a += wi * mul; c += wi * mul * condPct[i];
          });
          const uPct = (u.node?.pct ?? 0) + fUniPct + BOND15 * n15, uFlat = (u.node?.flat ?? 0) + fFlat;
          const value = base * (a * (1 + uPct / 1000) + c / 1000) + w * uFlat;
          const cur = bests.get(core);
          if (!cur || value > cur.value) bests.set(core, { value, core, vec: vec.slice(), fillers: chosen.slice(), uni: u.node });
          return;
        }
        if (ci >= classes.length) return;
        rec(ci + 1, left, cost);
        let c2 = cost, taken = 0;
        for (const i of classes[ci]) {
          if (ownIdx.includes(i)) continue;
          c2 += pool[i].svt.cost;
          if (c2 > cap) break;
          chosen.push(i); taken++;
          if (taken <= left) rec(ci + 1, left - taken, c2);
          if (taken >= left) break;
        }
        chosen.length -= taken;
      };
      rec(0, free, costM);
    }
  };
  const enumVec = (t: number, slots: number) => {
    if (t === condTypes.length) { evalVec(); return; }
    for (let n = 0; n <= Math.min(slots, condTypes[t].copies.length); n++) { vec[t] = n; enumVec(t + 1, slots - n); }
    vec[t] = 0;
  };
  enumVec(0, SLOTS);

  // 정확한 수치(내림 포함)로 다시 계산해 결과를 만든다
  const out: PartyResult[] = [];
  for (const b of bests.values()) {
    const ces: { ce: BondCE; mlb: boolean }[] = [];
    b.vec.forEach((n, t) => { for (let k = 0; k < n; k++) ces.push({ ce: condTypes[t].copies[k].ce, mlb: condTypes[t].copies[k].mlb }); });
    for (let n = b.uni; n; n = n.prev) ces.push({ ce: n.item.ce, mlb: n.item.mlb });
    const n15 = b.core.own.filter((p) => p.bond15).length + b.fillers.filter((i) => pool[i].bond15).length;
    let flat = fFlat, uPct = fUniPct + BOND15 * n15;
    for (const c of ces) {
      const v = c.ce.val[c.mlb ? 1 : 0];
      if (c.ce.kind === 'flat') flat += v; else if (!c.ce.cond.length) uPct += v;
    }
    const pctFor = (traits: number[]) => {
      let p = uPct + (fCe && fCe.cond.length ? friendPctFor(traits) : 0);
      for (const c of ces) if (c.ce.kind === 'pct' && c.ce.cond.length && condMatch(c.ce.cond, traits)) p += c.ce.val[c.mlb ? 1 : 0];
      return p;
    };
    const allFront = b.core.friend ? FRONT_FRIEND : 0;
    const mk = (p: PoolEntry, role: Member['role'], inFront: boolean): Member => ({
      svt: p.svt, friend: false, role, counted: p.weight > 0,
      bond: bondFor(base, allFront + (inFront ? FRONT_OWN : 0), pctFor(p.svt.traits), flat) * st.teapot,
    });
    const coreMembers = b.core.own.map((p) => mk(p, b.core.roles.get(p.svt.no) ?? 'filler', true));
    const friend: Member | null = b.core.friend ? { svt: b.core.friend, friend: true, role: 'support', bond: 0, counted: false } : null;
    const front: Member[] = [...coreMembers, ...(friend ? [friend] : [])];
    const back: Member[] = [];
    const frontFree = Math.max(0, 3 - front.length);
    const fillers = b.fillers.map((i) => pool[i])
      .sort((x, y) => y.weight * (10000 + pctFor(y.svt.traits)) - x.weight * (10000 + pctFor(x.svt.traits)))
      .map((p, k) => mk(p, 'filler', k < frontFree));
    fillers.forEach((f, k) => (k < frontFree ? front : back).push(f));
    if (!friend) back.push({ svt: null as unknown as Servant, friend: true, role: 'filler', bond: 0, counted: false });
    const own = [...coreMembers, ...fillers];
    out.push({
      turns: b.core.sim.turns, front, back, ces, friendCe: fCe, sim: b.core.sim,
      total: own.reduce((s, m) => s + (m.counted ? m.bond : 0), 0),
      cost: own.reduce((s, m) => s + m.svt.cost, 0) + ces.reduce((s, c) => s + c.ce.cost, 0),
    });
  }
  out.sort((a, b) => b.total - a.total || a.turns - b.turns || a.cost - b.cost);
  // 멤버 구성이 완전히 같은 결과는 하나만
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = [...r.front, ...r.back].filter((m) => m.svt).map((m) => m.svt.no + (m.friend ? 'f' : '')).sort().join(',') + '|' + r.ces.map((c) => c.ce.no).sort().join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, st.topN);
}
