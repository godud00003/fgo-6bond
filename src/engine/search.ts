// 클리어 가능한 전열 조합을 찾고, 그 위에서 인연 포인트 총합이 최대가 되는 파티·예장을 고른다.
import { simulateBest } from './sim.ts';
import type { ActorCfg, BondCE, QuestData, Rel, Servant, SimResult, Skill } from './types.ts';

export interface PoolEntry {
  svt: Servant; npLv: number; skillLv: number; atk: number; weight: number; bond15?: boolean;
  /** 스킬별 레벨, 서번트별 시작 NP(없으면 공통 설정) */
  skillLvs?: number[]; startNp?: number;
}
export interface CEStock { ce: BondCE; count: number; mlb: boolean; /** 보유한 예장의 실제 ATK(없으면 최대 레벨 기준) */ atk?: number }
export interface Settings {
  maxTurns: number; costCap: number; roll: number; startNp: number;
  friendCe: { no: number; mlb: boolean } | null; topN: number;
  /** 찻주전자 배수(1 = 미사용). 최종 인연 포인트에 곱해진다. */
  teapot: number;
  /** 출전 서번트 전원이 레벨 1이 되는 퀘스트(프렌드 포함). 풀의 ATK는 호출하는 쪽에서 이미 레벨 1로 넣는다. */
  lv1?: boolean;
  /** 마술예장 스킬(없으면 미사용) */
  mc?: Skill[] | null;
  /** 보구를 쓰지 않은 턴에 평타로 얻는다고 가정하는 NP (10000 = 100%) */
  cardNp?: number;
  /** 프렌드로 내 파티에 있는 것과 같은 서번트를 빌리는 편성을 허용한다(기본 허용) */
  allowDup?: boolean;
  /** 반드시 내 파티에 포함할 서번트(도감 번호). 딜러·서포터가 아니면 인연용 자리에 넣는다. */
  must?: number[];
}
export interface Member { svt: Servant; friend: boolean; role: 'dealer' | 'support' | 'filler'; bond: number; counted: boolean }
export interface PartyResult {
  turns: number; front: Member[]; back: Member[]; ces: { ce: BondCE; mlb: boolean }[];
  friendCe: BondCE | null; total: number; cost: number; sim: SimResult;
  /** 이 예장을 표시된 딜러에게 끼워야 클리어된다(예장 ATK가 필요한 편성) */
  atkCe?: { ce: BondCE; atk: number; dealer: string };
}
export interface SearchOutput {
  results: PartyResult[]; simulated: number; feasible: number; bestFail: { names: string[]; sim: SimResult } | null;
  /** 필수 포함 서번트 때문에 결과가 없을 때의 안내 */
  note?: string;
}

/** 주회 서포터로 쓰이는 서번트(도감 번호) */
export const SUPPORT_NOS = [284, 314, 316, 215, 357, 37, 150, 353, 62, 241, 307, 90, 34, 79, 249];

interface Core { own: PoolEntry[]; friend: Servant | null; friendRole?: 'dealer' | 'support'; roles: Map<number, 'dealer' | 'support'>; sim: SimResult }

const condMatch = (cond: number[][], traits: number[]) => !cond.length || cond.some((g) => g.every((t) => traits.includes(t)));

export function search(
  pool: PoolEntry[], all: Servant[], stock: CEStock[], quest: QuestData, rel: Rel, st: Settings,
  onProgress?: (done: number, total: number) => void,
): SearchOutput {
  const byNo = new Map(pool.map((p) => [p.svt.no, p]));
  const allByNo = new Map(all.map((s) => [s.no, s]));
  const cfg = (p: PoolEntry, role: 'dealer' | 'support', plusAtk = 0): ActorCfg =>
    ({ svt: p.svt, npLv: p.npLv, skillLv: p.skillLv, skillLvs: p.skillLvs, atk: p.atk + plusAtk, startNp: p.startNp ?? st.startNp, role });
  // 예장 ATK: 보유한 인연 예장 중 ATK가 가장 높은 것을 주 딜러에게 끼운다고 본다.
  // 예장 없이도 클리어되는 편성은 그대로 두고, 안 되는 편성만 이 예장을 낀 조건으로 다시 계산한다.
  const ceAtkOf = (s: CEStock) => s.atk ?? s.ce.atk;
  const atkStock = stock.filter((s) => s.count > 0 && ceAtkOf(s) > 0)
    .sort((a, b) => ceAtkOf(b) - ceAtkOf(a) || b.ce.val[b.mlb ? 1 : 0] - a.ce.val[a.mlb ? 1 : 0])[0] ?? null;
  const plusAtk = atkStock ? ceAtkOf(atkStock) : 0;
  const coresAtk: Core[] = [];
  const friendCfg = (s: Servant, role: 'dealer' | 'support' = 'support'): ActorCfg =>
    ({ svt: s, npLv: 1, skillLv: 10, atk: (st.lv1 ? s.atk[1] : s.atk.max) + 1000, startNp: st.startNp, role, friend: true });
  const extra = { mc: st.mc, cardNp: st.cardNp };
  const allowDup = st.allowDup !== false;
  const sim1 = (front: ActorCfg[]) => simulateBest(front, quest, rel, st.maxTurns, st.roll, extra);

  const dealers = pool.filter((p) => p.svt.np?.dmg);
  const supports = SUPPORT_NOS.filter((n) => allByNo.has(n));
  // 서포터 조합: 없음, 1명, 2명(같은 서번트 2명 포함)
  const combos: number[][] = [[]];
  for (const a of supports) combos.push([a]);
  for (let i = 0; i < supports.length; i++) for (let j = i; j < supports.length; j++) combos.push([supports[i], supports[j]]);

  const cores: Core[] = [];
  let simulated = 0;
  let bestFail: SearchOutput['bestFail'] = null;
  const noteFail = (names: string[], sim: SimResult) => { if (!bestFail || sim.broken > bestFail.sim.broken) bestFail = { names, sim }; };
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
    if (a === b) { if (allowDup && ownOk(a)) out.push({ own: [byNo.get(a)!], friend: allByNo.get(a)! }); return out; }
    if (ownOk(a)) out.push({ own: [byNo.get(a)!], friend: allByNo.get(b)! });
    if (ownOk(b)) out.push({ own: [byNo.get(b)!], friend: allByNo.get(a)! });
    if (ownOk(a) && ownOk(b)) out.push({ own: [byNo.get(a)!, byNo.get(b)!], friend: null });
    return out;
  };

  /** 반환: 0 = 실패, 1 = 그대로 클리어, 2 = 예장 ATK를 더해야 클리어 */
  const tryCores = (ds: PoolEntry[], combo: number[]): number => {
    const dNos = ds.map((d) => d.svt.no);
    const vs = variants(combo, dNos);
    if (!vs.length) return 0;
    // 전투 결과는 누가 프렌드든 같다고 보고(프렌드는 풀스펙 가정) 한 번만 시뮬레이션
    const v0 = vs[vs.length - 1];
    const mkFront = (plus: number) => [...ds.map((d, i) => cfg(d, 'dealer', i === 0 ? plus : 0)), ...v0.own.map((p) => cfg(p, 'support')), ...(v0.friend ? [friendCfg(v0.friend)] : [])];
    let sim = sim1(mkFront(0));
    simulated++;
    let target = cores;
    if (!sim.cleared && plusAtk) { sim = sim1(mkFront(plusAtk)); simulated++; target = coresAtk; }
    if (!sim.cleared) { noteFail(mkFront(0).map((f) => f.svt.name), sim); return 0; }
    for (const v of vs) {
      const roles = new Map<number, 'dealer' | 'support'>();
      for (const d of ds) roles.set(d.svt.no, 'dealer');
      for (const p of v.own) roles.set(p.svt.no, 'support');
      target.push({ own: [...ds, ...v.own], friend: v.friend, roles, sim });
    }
    return target === cores ? 1 : 2;
  };

  /** 프렌드로 같은 딜러를 빌려 보구를 번갈아 쓰는 편성(프렌드 보구 레벨은 1로 가정) */
  const tryFriendDealer = (d: PoolEntry, sup: PoolEntry | null, supRole: 'dealer' | 'support' = 'support'): boolean => {
    if (!allowDup) return false;
    const mkFront = (plus: number) => [cfg(d, 'dealer', plus), friendCfg(d.svt, 'dealer'), ...(sup ? [cfg(sup, supRole)] : [])];
    let sim = sim1(mkFront(0));
    simulated++;
    let target = cores;
    if (!sim.cleared && plusAtk) { sim = sim1(mkFront(plusAtk)); simulated++; target = coresAtk; }
    if (!sim.cleared) { noteFail(mkFront(0).map((f) => f.svt.name), sim); return false; }
    const roles = new Map<number, 'dealer' | 'support'>([[d.svt.no, 'dealer']]);
    if (sup) roles.set(sup.svt.no, supRole);
    target.push({ own: sup ? [d, sup] : [d], friend: d.svt, friendRole: 'dealer', roles, sim });
    return true;
  };

  let plain = 0; // 딜러 1기 + 서포터 편성으로 클리어된 수
  for (const d of dealers) {
    const okSingles = new Set<number>();
    let solo = false;
    for (const combo of combos) {
      done++;
      if (solo || combo.includes(d.svt.no)) continue;
      if (combo.some((n) => okSingles.has(n))) continue; // 더 작은 조합으로 이미 클리어 가능
      const got = tryCores([d], combo);
      if (got) {
        if (got === 1) plain++;
        if (combo.length === 0) solo = true;
        else if (combo.length === 1) okSingles.add(combo[0]);
      }
    }
    if (!solo && !tryFriendDealer(d, null)) {
      for (const n of supports) if (n !== d.svt.no && byNo.has(n)) tryFriendDealer(d, byNo.get(n)!);
    }
    onProgress?.(done, total);
  }

  // 딜러 1명으로 안 되면 딜러 2~3명 조합을 시도
  if (!plain && dealers.length > 1) {
    const solo = dealers.map((d) => ({ d, sim: sim1([cfg(d, 'dealer')]) }));
    const dmg = (s: SimResult) => s.log.reduce((n, t) => n + t.nps.reduce((m, x) => m + x.hits.reduce((k, h) => k + Math.min(h.dmg, h.hp), 0), 0), 0);
    const top = solo.map((x) => ({ d: x.d, score: dmg(x.sim) })).sort((a, b) => b.score - a.score).slice(0, 14).map((x) => x.d);
    // 마지막 웨이브(보스) 담당 후보: 보구를 바로 쓸 수 있다고 치고 마지막 웨이브에 준 대미지가 큰 딜러.
    // 위 순위는 광역 딜러에 치우치므로, 단일 보스를 맡을 딜러를 따로 뽑아 합친다.
    const lastQuest: QuestData = { ...quest, waves: [quest.waves[quest.waves.length - 1]], waveCalls: undefined };
    const finishers = dealers
      .map((d) => ({ d, score: dmg(simulateBest([{ ...cfg(d, 'dealer'), startNp: 10000 }], lastQuest, rel, 1, st.roll, extra)) }))
      .sort((a, b) => b.score - a.score).slice(0, 8).map((x) => x.d);
    for (const d of finishers) if (!top.includes(d)) top.push(d);
    const single = combos.filter((c) => c.length <= 1);
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
      for (const c of single) if (tryCores([top[i], top[j]], c) && c.length === 0) break;
    }
    // 같은 딜러 2기(내 것 + 프렌드)에 다른 딜러 1기를 더한 편성
    for (const d of top) for (const d2 of top) if (d2 !== d) tryFriendDealer(d, d2, 'dealer');
    // 내 딜러 3기
    const t3 = top.slice(0, 12);
    for (let i = 0; i < t3.length; i++) for (let j = i + 1; j < t3.length; j++) for (let k = j + 1; k < t3.length; k++) tryCores([t3[i], t3[j], t3[k]], []);
  }

  // 예장 ATK가 필요한 편성은 그 예장을 반드시 포함하는 조건으로 인연을 따로 최적화한다
  const all2 = [...optimizeBond(cores, pool, stock, quest, st, null), ...(atkStock ? optimizeBond(coresAtk, pool, stock, quest, st, atkStock) : [])];
  all2.sort((a, b) => b.total - a.total || a.turns - b.turns || Number(!!a.atkCe) - Number(!!b.atkCe) || a.cost - b.cost);
  // 멤버 구성이 완전히 같은 결과는 하나만
  const seen = new Set<string>();
  const results = all2.filter((r) => {
    const k = [...r.front, ...r.back].filter((m) => m.svt).map((m) => m.svt.no + (m.friend ? 'f' : '')).sort().join(',') + '|' + r.ces.map((c) => c.ce.no).sort().join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, st.topN);
  const feasible = cores.length + coresAtk.length;
  let note: string | undefined;
  if (st.must?.length && feasible && !results.length) {
    const missing = st.must.filter((no) => !byNo.has(no)).map((no) => allByNo.get(no)?.name ?? `#${no}`);
    note = missing.length
      ? `필수 포함 서번트가 서번트 풀에 없습니다: ${missing.join(', ')}. 보유 서번트만 쓰는 중이라면 "내 서번트"에 등록되어 있는지 확인하세요.`
      : '클리어되는 조합은 있지만, 필수 포함 서번트를 모두 넣으면 자리(내 서번트 5기)나 코스트가 모자랍니다.';
  }
  return { results, simulated, feasible, bestFail: feasible ? null : bestFail, note };
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

/** forced: 반드시 포함할 예장(주 딜러에게 끼우는 ATK 예장). 예장 칸 하나와 코스트를 미리 차지한다. */
function optimizeBond(cores: Core[], pool: PoolEntry[], stock: CEStock[], quest: QuestData, st: Settings, forced: CEStock | null): PartyResult[] {
  if (!cores.length) return [];
  const base = quest.bond;
  const cap = st.costCap - (forced ? forced.ce.cost : 0);
  if (cap < 0) return [];
  const SLOTS = 5;                       // 내 서번트 자리
  const CE_SLOTS = 5 - (forced ? 1 : 0); // 자유롭게 고를 수 있는 예장 칸
  const pctOf = (s: CEStock) => s.ce.val[s.mlb ? 1 : 0];
  const xVal = forced ? pctOf(forced) : 0;
  const xCondFor = (traits: number[]) => (forced && forced.ce.kind === 'pct' && forced.ce.cond.length && condMatch(forced.ce.cond, traits) ? xVal : 0);
  const xUni = forced && forced.ce.kind === 'pct' && !forced.ce.cond.length ? xVal : 0;
  const xFlat = forced && forced.ce.kind === 'flat' ? xVal : 0;

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
    const have = s.count - (forced && s.ce.no === forced.ce.no ? 1 : 0);
    if (have <= 0) continue;
    const n = Math.min(have, CE_SLOTS);
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
  for (let j = 0; j <= CE_SLOTS; j++) { dp.push(new Array(cap + 1).fill(j === 0 ? 0 : -1)); pick.push(new Array(cap + 1).fill(null)); }
  for (const it of uni) {
    for (let j = CE_SLOTS; j >= 1; j--) for (let c = cap; c >= it.cost; c--) {
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
  // 필수 포함 서번트: 풀에 없는 서번트가 하나라도 있으면 만족하는 편성이 없다
  const mustIdx: number[] = [];
  for (const no of st.must ?? []) { const i = idx.get(no); if (i === undefined) return []; mustIdx.push(i); }
  const is15 = pool.map((p) => (p.bond15 ? 1 : 0));
  // 슬롯을 쓰지 않고 더해지는 효과: 프렌드 예장 + 반드시 포함하는 예장
  const extraCondFor = (traits: number[]) => (fCe && fCe.cond.length ? friendPctFor(traits) : 0) + xCondFor(traits);
  const fCond = pool.map((p) => extraCondFor(p.svt.traits));
  const fUniPct = (fCe && fCe.kind === 'pct' && !fCe.cond.length ? fPct : 0) + xUni;
  const extraFlat = fFlat + xFlat;

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
    const condPct = pool.map((_, i) => { let s = fCond[i]; for (let t = 0; t < condTypes.length; t++) if (match[i][t]) s += typePct[t]; return s; });
    // 코스트별 후보(조건 일치율 높은 순) + 인연이 필요 없는 저코스트 서번트
    const classes: number[][] = costs.map((c) =>
      pool.map((_, i) => i).filter((i) => pool[i].weight > 0 && pool[i].svt.cost === c).sort((a, b) => condPct[b] - condPct[a]).slice(0, 9));
    const zero = pool.map((_, i) => i).filter((i) => pool[i].weight <= 0).sort((a, b) => is15[b] - is15[a] || pool[a].svt.cost - pool[b].svt.cost).slice(0, 9);
    if (zero.length) classes.push(zero);
    const r = CE_SLOTS - used;
    if (r < 0) return;

    for (const core of coreList) {
      const ownIdx = core.own.map((p) => idx.get(p.svt.no)!);
      // 필수 포함 서번트 중 코어에 없는 서번트는 인연용 자리를 미리 차지한다
      const pre = mustIdx.filter((i) => !ownIdx.includes(i));
      const free = Math.min(SLOTS - ownIdx.length, pool.length - ownIdx.length) - pre.length;
      if (free < 0) continue;
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
      for (const i of pre) costM += pool[i].svt.cost;
      if (costM > cap) continue;
      const chosen: number[] = pre.slice();
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
          const uPct = (u.node?.pct ?? 0) + fUniPct + BOND15 * n15, uFlat = (u.node?.flat ?? 0) + extraFlat;
          const value = base * (a * (1 + uPct / 1000) + c / 1000) + w * uFlat;
          const cur = bests.get(core);
          if (!cur || value > cur.value) bests.set(core, { value, core, vec: vec.slice(), fillers: chosen.slice(), uni: u.node });
          return;
        }
        if (ci >= classes.length) return;
        rec(ci + 1, left, cost);
        let c2 = cost, taken = 0;
        for (const i of classes[ci]) {
          if (ownIdx.includes(i) || pre.includes(i)) continue;
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
  enumVec(0, CE_SLOTS);

  // 정확한 수치(내림 포함)로 다시 계산해 결과를 만든다
  const out: PartyResult[] = [];
  for (const b of bests.values()) {
    const ces: { ce: BondCE; mlb: boolean }[] = [];
    b.vec.forEach((n, t) => { for (let k = 0; k < n; k++) ces.push({ ce: condTypes[t].copies[k].ce, mlb: condTypes[t].copies[k].mlb }); });
    for (let n = b.uni; n; n = n.prev) ces.push({ ce: n.item.ce, mlb: n.item.mlb });
    const n15 = b.core.own.filter((p) => p.bond15).length + b.fillers.filter((i) => pool[i].bond15).length;
    let flat = extraFlat, uPct = fUniPct + BOND15 * n15;
    for (const c of ces) {
      const v = c.ce.val[c.mlb ? 1 : 0];
      if (c.ce.kind === 'flat') flat += v; else if (!c.ce.cond.length) uPct += v;
    }
    const pctFor = (traits: number[]) => {
      let p = uPct + extraCondFor(traits);
      for (const c of ces) if (c.ce.kind === 'pct' && c.ce.cond.length && condMatch(c.ce.cond, traits)) p += c.ce.val[c.mlb ? 1 : 0];
      return p;
    };
    const allFront = b.core.friend ? FRONT_FRIEND : 0;
    const mk = (p: PoolEntry, role: Member['role'], inFront: boolean): Member => ({
      svt: p.svt, friend: false, role, counted: p.weight > 0,
      bond: bondFor(base, allFront + (inFront ? FRONT_OWN : 0), pctFor(p.svt.traits), flat) * st.teapot,
    });
    const coreMembers = b.core.own.map((p) => mk(p, b.core.roles.get(p.svt.no) ?? 'filler', true));
    const friend: Member | null = b.core.friend ? { svt: b.core.friend, friend: true, role: b.core.friendRole ?? 'support', bond: 0, counted: false } : null;
    const front: Member[] = [...coreMembers, ...(friend ? [friend] : [])];
    const back: Member[] = [];
    const frontFree = Math.max(0, 3 - front.length);
    const fillers = b.fillers.map((i) => pool[i])
      .sort((x, y) => y.weight * (10000 + pctFor(y.svt.traits)) - x.weight * (10000 + pctFor(x.svt.traits)))
      .map((p, k) => mk(p, 'filler', k < frontFree));
    fillers.forEach((f, k) => (k < frontFree ? front : back).push(f));
    if (!friend) back.push({ svt: null as unknown as Servant, friend: true, role: 'filler', bond: 0, counted: false });
    const own = [...coreMembers, ...fillers];
    // 반드시 포함하는 예장은 효과를 위에서 이미 더했으므로 목록에만 추가한다
    const allCes = forced ? [{ ce: forced.ce, mlb: forced.mlb }, ...ces] : ces;
    out.push({
      turns: b.core.sim.turns, front, back, ces: allCes, friendCe: fCe, sim: b.core.sim,
      total: own.reduce((s, m) => s + (m.counted ? m.bond : 0), 0),
      cost: own.reduce((s, m) => s + m.svt.cost, 0) + allCes.reduce((s, c) => s + c.ce.cost, 0),
      atkCe: forced ? { ce: forced.ce, atk: forced.atk ?? forced.ce.atk, dealer: b.core.own[0].svt.name } : undefined,
    });
  }
  return out;
}
