// 클리어 가능한 전열 조합을 찾고, 그 위에서 인연 포인트 총합이 최대가 되는 파티·예장을 고른다.
import { simulateBest } from './sim.ts';
import type { ActorCfg, BondCE, ClassScore, MysticCode, QuestData, Rel, Servant, SimResult } from './types.ts';

export interface PoolEntry {
  svt: Servant; npLv: number; skillLv: number; atk: number; weight: number; bond15?: boolean;
  /** 스킬별 레벨, 서번트별 시작 NP(없으면 공통 설정) */
  skillLvs?: number[]; startNp?: number;
  /** 어펜드 스킬 5(스킬 재장전) 횟수(없으면 공통 설정) */
  reload?: number;
}
export interface CEStock { ce: BondCE; count: number; mlb: boolean; /** 보유한 예장의 실제 ATK(없으면 최대 레벨 기준) */ atk?: number }
export interface Settings {
  maxTurns: number; costCap: number; roll: number; startNp: number;
  friendCe: { no: number; mlb: boolean } | null; topN: number;
  /** 프렌드가 낀 인연 예장을 자동으로 고른다: 어떤 예장을 낀 프렌드를 빌리면 인연 합계가 가장 큰지 찾는다(최대해방 기준) */
  friendCeAuto?: boolean;
  /** 프렌드 서번트의 어펜드: 시작 NP(어펜드 2)와 스킬 재장전 횟수(어펜드 5). 없으면 startNp·reload와 같게 본다. */
  friendAppendNp?: number; friendReload?: number;
  /** 프렌드가 인연 예장 대신 시작 NP 예장을 낀 경우의 추가 시작 NP (10000 = 100%). friendCe와 함께 쓸 수 없다. */
  friendStartNp?: number;
  /** 찻주전자 배수(1 = 미사용). 최종 인연 포인트에 곱해진다. */
  teapot: number;
  /** 어펜드 스킬 5(스킬 재장전)의 기본 횟수: 등록하지 않은 서번트와 프렌드에 적용(0~3) */
  reload?: number;
  /** 출전 서번트 전원이 레벨 1이 되는 퀘스트(프렌드 포함). 풀의 ATK는 호출하는 쪽에서 이미 레벨 1로 넣는다. */
  lv1?: boolean;
  /** 마술예장(없으면 미사용). mcAuto가 있으면 무시하고 자동으로 고른다. */
  mc?: MysticCode | null;
  /** 자동 선택 후보(전체 마술예장). 예장 없이 먼저 계산하고, 안 되는 편성에만 가장 도움이 되는 예장을 쓴다. */
  mcAuto?: MysticCode[];
  /** 오더 체인지를 쓰는 편성도 찾는다(오더 체인지가 있는 마술예장일 때만) */
  orderChange?: boolean;
  /** 보구를 쓰지 않은 턴에 평타로 얻는다고 가정하는 NP (10000 = 100%) */
  cardNp?: number;
  /** 령주 1획(NP +100%)을 쓰는 편성도 찾는다. 령주 없이 되는 편성은 령주를 쓰지 않는다. */
  commandSpell?: boolean;
  /**
   * 보구 계획 탐색(기본 켬): 정해진 운용으로 안 되는 편성은 턴마다 누가 보구를 쏠지 바꿔 가며 찾는다.
   * 서포터의 보구(버프·디버프 보구 포함)와 한 턴에 보구 여러 개를 쏘는 경우가 여기에 들어간다. 끄면 빨라진다.
   */
  npPlan?: boolean;
  /** false면 NP 수급 상한으로 미리 걸러 내지 않는다(검증용) */
  prune?: boolean;
  /** 클래스 스코어(내 서번트 / 프렌드) */
  score?: ClassScore; friendScore?: ClassScore;
  /** 프렌드로 내 파티에 있는 것과 같은 서번트를 빌리는 편성을 허용한다(기본 허용) */
  allowDup?: boolean;
  /** 반드시 내 파티에 포함할 서번트(도감 번호). 딜러·서포터가 아니면 인연용 자리에 넣는다. */
  must?: number[];
}
export interface Member {
  svt: Servant; friend: boolean; role: 'dealer' | 'support' | 'filler'; bond: number; counted: boolean;
  /** 후열에서 시작해 전투 중 들어오는 교체 요원 / 오더 체인지로 내보내는 서번트 */
  sub?: boolean; swapOut?: boolean;
  /** 이 서번트에게 끼우는 예장(인연 효과는 누가 껴도 같고, ATK가 높은 예장을 딜러에게 먼저 준다). 프렌드는 프렌드가 낀 예장. */
  ce?: { ce: BondCE; mlb: boolean };
}
export interface PartyResult {
  turns: number; front: Member[]; back: Member[]; ces: { ce: BondCE; mlb: boolean }[];
  friendCe: BondCE | null; total: number; cost: number; sim: SimResult;
  /** 이 예장을 표시된 딜러에게 끼워야 클리어된다(예장 ATK가 필요한 편성) */
  atkCe?: { ce: BondCE; atk: number; dealer: string };
  /** 이 마술예장을 써야 클리어된다(없으면 예장과 무관) */
  mc?: { id: number; name: string; face?: string };
  /** 령주 1획을 써야 클리어된다 */
  cs?: boolean;
}
export interface SearchOutput {
  results: PartyResult[]; simulated: number; feasible: number; bestFail: { names: string[]; sim: SimResult } | null;
  /** 필수 포함 서번트 때문에 결과가 없을 때의 안내 */
  note?: string;
  /** 자동 선택 모드에서 고른 마술예장 이름(예장이 도움이 안 되면 null) */
  autoMc?: string | null;
  /** 프렌드 예장 자동 선택에서 고른 예장 이름(도움이 되는 예장이 없으면 null) */
  autoFriendCe?: string | null;
}

/** 주회 서포터로 쓰이는 서번트(도감 번호) */
export const SUPPORT_NOS = [284, 314, 316, 215, 357, 37, 150, 353, 62, 241, 307, 90, 34, 79, 249];

interface Core {
  own: PoolEntry[]; friend: Servant | null; friendRole?: 'dealer' | 'support'; roles: Map<number, 'dealer' | 'support'>; sim: SimResult;
  /** 클리어에 쓴 마술예장 */
  mc: MysticCode | null;
  /** 령주를 써야 클리어되는 편성인가 */
  cs?: boolean;
  /** 후열에서 시작하는 내 서번트(도감 번호), 프렌드가 후열인지, 오더 체인지로 내보내는 서번트 */
  bench: Set<number>; friendBench: boolean; swapOut?: number;
  /** 전열의 자리 순서(도감 번호, 프렌드는 'f'). 진궁의 제물처럼 위치가 의미 있는 편성이 있다. */
  seq: string[];
  /** 탐색 단위 번호: 여러 워커가 나눠 찾은 결과를 한 번에 찾았을 때와 같은 순서로 합치는 데 쓴다 */
  u: number;
}

/** 탐색을 여러 워커가 나눠 맡을 때의 몫: 탐색 단위(딜러, 딜러 쌍 등)를 번호순으로 count개 중 index번째만 맡는다 */
export interface Shard { index: number; count: number }
/** 워커 사이에 주고받는 코어: 서번트·마술예장은 번호로만 싣는다 */
interface PackedCore {
  own: number[]; friend: number | null; friendRole?: 'dealer' | 'support'; roles: [number, 'dealer' | 'support'][]; sim: SimResult;
  mc: number | null; cs?: boolean; bench: number[]; friendBench: boolean; swapOut?: number; seq: string[]; u: number;
}
/** 클리어되는 편성을 찾는 단계의 결과(한 워커의 몫) */
export interface CorePart {
  cores: PackedCore[]; coresAtk: PackedCore[]; simulated: number;
  bestFail: { names: string[]; sim: SimResult; u: number } | null;
  autoMc?: string | null;
  /** 오더 체인지를 켰지만 쓸 수 있는 마술예장이 없었다 */
  noOc: boolean;
}
const pack = (c: Core): PackedCore => ({
  own: c.own.map((p) => p.svt.no), friend: c.friend?.no ?? null, friendRole: c.friendRole, roles: [...c.roles], sim: c.sim,
  mc: c.mc?.id ?? null, cs: c.cs, bench: [...c.bench], friendBench: c.friendBench, swapOut: c.swapOut, seq: c.seq, u: c.u,
});

const condMatch = (cond: number[][], traits: number[]) => !cond.length || cond.some((g) => g.every((t) => traits.includes(t)));

/** 한 번에 전부 계산한다(워커를 나누지 않을 때). */
export function search(
  pool: PoolEntry[], all: Servant[], stock: CEStock[], quest: QuestData, rel: Rel, st: Settings,
  onProgress?: (done: number, total: number) => void,
): SearchOutput {
  return finishSearch([findCores(pool, all, stock, quest, rel, st, onProgress)], pool, all, stock, quest, st);
}

/** 보유 인연 예장 중 ATK가 가장 높은 것(주 딜러에게 끼운다고 본다) */
const ceAtkOf = (s: CEStock) => s.atk ?? s.ce.atk;
const bestAtkStock = (stock: CEStock[]) => stock.filter((s) => s.count > 0 && ceAtkOf(s) > 0)
  .sort((a, b) => ceAtkOf(b) - ceAtkOf(a) || b.ce.val[b.mlb ? 1 : 0] - a.ce.val[a.mlb ? 1 : 0])[0] ?? null;

/** 1단계: 클리어되는 편성(코어)을 찾는다. shard를 주면 그 몫만 계산한다. */
export function findCores(
  pool: PoolEntry[], all: Servant[], stock: CEStock[], quest: QuestData, rel: Rel, st: Settings,
  onProgress?: (done: number, total: number) => void, shard?: Shard,
): CorePart {
  const byNo = new Map(pool.map((p) => [p.svt.no, p]));
  const allByNo = new Map(all.map((s) => [s.no, s]));
  const cfg = (p: PoolEntry, role: 'dealer' | 'support', plusAtk = 0): ActorCfg =>
    ({ svt: p.svt, npLv: p.npLv, skillLv: p.skillLv, skillLvs: p.skillLvs, atk: p.atk + plusAtk, startNp: p.startNp ?? st.startNp, reload: p.reload ?? st.reload ?? 0, role });
  const friendCfg = (s: Servant, role: 'dealer' | 'support' = 'support'): ActorCfg =>
    ({ svt: s, npLv: 1, skillLv: 10, atk: (st.lv1 ? s.atk[1] : s.atk.max) + 1000, startNp: (st.friendAppendNp ?? st.startNp) + (st.friendStartNp ?? 0), reload: st.friendReload ?? st.reload ?? 0, role, friend: true });
  // 예장 ATK: 보유한 인연 예장 중 ATK가 가장 높은 것을 주 딜러에게 끼운다고 본다.
  // 예장 없이도 클리어되는 편성은 그대로 두고, 안 되는 편성만 이 예장을 낀 조건으로 다시 계산한다.
  const atkStock = bestAtkStock(stock);
  const plusAtk = atkStock ? ceAtkOf(atkStock) : 0;
  const allowDup = st.allowDup !== false;
  let simulated = 0;
  let useCs = false; // 지금 계산에서 령주를 쓸 수 있는가(령주 없이 안 될 때만 켠다)
  let usePlan = st.npPlan !== false; // 지금 계산에서 보구 계획 탐색을 하는가
  // score: 클리어 여부가 아니라 준 대미지로 점수를 매기는 계산. 실패하더라도 어디까지 갔는지가 필요하므로 미리 걸러 내지 않는다.
  const run = (lineup: ActorCfg[], mc: MysticCode | null, score = false) => {
    simulated++;
    return simulateBest(lineup, quest, rel, st.maxTurns, st.roll, { mc: mc?.skills, cardNp: st.cardNp, commandSpell: useCs, score: st.score, friendScore: st.friendScore, plan: usePlan, prune: score ? false : st.prune });
  };
  const dmgOf = (s: SimResult) => s.log.reduce((n, t) => n + t.nps.reduce((m, x) => m + x.hits.reduce((k, h) => k + Math.min(h.dmg, h.hp), 0), 0), 0);

  const dealers = pool.filter((p) => p.svt.np?.dmg);
  const supports = SUPPORT_NOS.filter((n) => allByNo.has(n));
  // 서포터 조합: 없음, 1명, 2명(같은 서번트 2명 포함)
  const combos: number[][] = [[]];
  for (const a of supports) combos.push([a]);
  for (let i = 0; i < supports.length; i++) for (let j = i; j < supports.length; j++) combos.push([supports[i], supports[j]]);

  // ---- 마술예장 후보
  // 지정: 그 예장만. 자동: 예장 없이 먼저 해 보고, 안 되면 이 퀘스트에서 가장 도움이 되는 예장을 쓴다.
  const hasOc = (m: MysticCode) => m.skills.some((k) => k.fn.some((f) => f.t === 'replaceMember'));
  const solo = dealers.map((d) => ({ d, sim: run([cfg(d, 'dealer')], st.mc ?? null, true) }));
  const topD = solo.map((x) => ({ d: x.d, score: dmgOf(x.sim) })).sort((a, b) => b.score - a.score).map((x) => x.d);
  let mcList: (MysticCode | null)[] = [st.mc ?? null];
  if (st.mcAuto?.length) {
    // 대표 편성(대미지 상위 딜러 × 단독·캐스토리아 2기)으로 예장마다 점수를 매긴다
    const cas = allByNo.get(284);
    const samples = topD.slice(0, 12).flatMap((d) => [[cfg(d, 'dealer')], ...(cas ? [[cfg(d, 'dealer'), friendCfg(cas), friendCfg(cas)]] : [])]);
    let best: MysticCode | null = null, bestScore = -1;
    for (const m of st.mcAuto) {
      if (!m.skills.some((k) => k.fn.some((f) => f.t !== 'replaceMember'))) continue;
      let score = 0;
      for (const lu of samples) { const r = run(lu, m, true); score += r.cleared ? 100000 - r.turns * 1000 : r.broken * 100 + dmgOf(r) / 1e6; }
      if (score > bestScore) { bestScore = score; best = m; }
    }
    // NP가 조금 모자라 못 쏘는 편성이 많으므로 NP 충전 예장도 후보에 둔다:
    // 충전량이 가장 큰 예장과, 충전에 더해 대미지 버프가 가장 좋은 예장
    const lastSv = (f: { sv: unknown }) => { const v = f.sv as { Value?: number } | { Value?: number }[]; return (Array.isArray(v) ? v[v.length - 1] : v).Value ?? 0; };
    const chargeOf = (m: MysticCode) => m.skills.reduce((n, k) => n + k.fn.reduce((x, f) => x + (f.t === 'gainNp' ? lastSv(f) : 0), 0), 0);
    const buffOf = (m: MysticCode) => m.skills.reduce((n, k) => n + k.fn.reduce((x, f) => x + (f.b?.some((b) => ['upNpdamage', 'upAtk', 'upCommandall'].includes(b.t)) ? lastSv(f) * (f.tg === 'ptAll' ? 1.5 : 1) : 0), 0), 0);
    const chargers = st.mcAuto.filter((m) => chargeOf(m) >= 1000);
    const bigCharge = chargers.slice().sort((a, b) => chargeOf(b) - chargeOf(a) || buffOf(b) - buffOf(a))[0] ?? null;
    const buffCharge = chargers.slice().sort((a, b) => buffOf(b) - buffOf(a) || chargeOf(b) - chargeOf(a))[0] ?? null;
    mcList = [null, ...new Set([best, bigCharge, buffCharge].filter((m): m is MysticCode => !!m))];
  }
  // 후보 예장의 스킬을 모두 가진 가상의 예장: '어느 예장으로도 안 된다'를 한 번에 가려내는 데 쓴다
  const superMc: MysticCode = { id: -1, name: '', skills: mcList.filter((m): m is MysticCode => !!m).flatMap((m) => m.skills) };
  // 오더 체인지: 체크했을 때만, 오더 체인지가 있는 예장으로만
  const ocMc = !st.orderChange ? null
    : st.mcAuto?.length ? (st.mcAuto.find((m) => m.id === 210 && hasOc(m)) ?? st.mcAuto.find(hasOc) ?? null)
      : st.mc && hasOc(st.mc) ? st.mc : null;

  const cores: Core[] = [];
  const coresAtk: Core[] = [];
  let bestFail: CorePart['bestFail'] = null;
  // 시뮬레이션 없이 걸러진 편성(기록이 비어 있다)은 '가장 근접한 실패'로 치지 않는다
  const noteFail = (names: string[], sim: SimResult) => { if (!sim.log.length) return; if (!bestFail || sim.broken > bestFail.sim.broken) bestFail = { names, sim, u: unit }; };
  // 탐색 단위마다 번호를 매기고, 나눠 맡을 때는 자기 몫만 계산한다
  let unit = -1;
  const mine = () => { unit++; return !shard || unit % shard.count === shard.index; };

  /** 편성의 한 자리. no는 도감 번호. */
  interface Slot {
    no: number; role: 'dealer' | 'support';
    /** 후열에서 시작 / 오더 체인지로 내보낼 자리 / 예장 ATK를 받는 주 딜러 */
    bench?: boolean; swapOut?: boolean; boost?: boolean;
    /** 프렌드 전용 자리(같은 딜러를 빌리는 경우) */
    friendOnly?: boolean;
    /** 보구도 쏘는 서포터(앞 웨이브 담당). 딜러 역할이지만 프렌드여도 된다. */
    sub?: boolean;
  }
  /** 어느 자리를 프렌드로 채울지(-1 = 프렌드 없이 전부 내 서번트). 내 서번트끼리는 겹칠 수 없다. */
  const assignments = (slots: Slot[]): number[] => {
    const out: number[] = [];
    const fixed = slots.findIndex((s) => s.friendOnly);
    for (let f = -1; f < slots.length; f++) {
      if (fixed >= 0 && f !== fixed) continue;
      if (f >= 0 && (slots[f].boost || (slots[f].role === 'dealer' && !slots[f].friendOnly && !slots[f].sub))) continue;
      const own = slots.filter((_, i) => i !== f).map((s) => s.no);
      if (own.some((n) => !byNo.has(n)) || new Set(own).size !== own.length) continue;
      if (f >= 0 && !allowDup && own.includes(slots[f].no)) continue;
      out.push(f);
    }
    return out;
  };
  /**
   * 편성 하나를 시뮬레이션해 클리어되면 코어로 등록한다.
   * 반환: 0 = 실패, 1 = 예장 ATK 없이 클리어, 2 = 예장 ATK를 더해야 클리어.
   * 전투 결과는 누가 프렌드든 같다고 보고(프렌드는 풀스펙 가정) 내 서번트가 가장 많은 배치로 한 번만 계산한다.
   */
const tryLineup = (slots: Slot[], mcs: (MysticCode | null)[]): number => {
    const as = assignments(slots);
    if (!as.length) return 0;
    /** 프렌드 자리를 f0로 놓고 계산한다. 클리어되면 조건(마술예장·예장 ATK)을 가장 덜어 낸 결과를 돌려준다. */
    const attemptBase = (f0: number): { sim: SimResult; mc: MysticCode | null; atk: boolean } | null => {
      const mk = (plus: number): ActorCfg[] => slots.map((s, i) => ({
        ...(i === f0 ? friendCfg(allByNo.get(s.no)!, s.role) : cfg(byNo.get(s.no)!, s.role, s.boost ? plus : 0)),
        bench: s.bench, swapOut: s.swapOut, main: s.boost,
      }));
      // 대부분의 편성은 실패한다. 그래서 가장 유리한 조건(예장 ATK + 후보 예장의 스킬을 전부 가진 가상의 예장)부터
      // 계산해, 그걸로도 안 되면 한 번에 포기한다.
      if (mcs.length > 1 || plusAtk) {
        const top = run(mk(plusAtk), mcs.length > 2 ? superMc : mcs[mcs.length - 1]);
        if (!top.cleared) { noteFail(mk(0).map((x) => x.svt.name), top); return null; }
      }
      // 되는 편성이면 가장 가벼운 조건부터 찾는다: 첫 예장(보통 없음)·예장 ATK 없음
      const first = run(mk(0), mcs[0]);
      if (first.cleared) return { sim: first, mc: mcs[0], atk: false };
      if (mcs.length === 1 && !plusAtk) { noteFail(mk(0).map((x) => x.svt.name), first); return null; }
      // 되는 것을 확인했으니 실제 조건을 찾는다: 마술예장만 → 예장 ATK만 → 둘 다
      for (const m of mcs.slice(1)) { const r = run(mk(0), m); if (r.cleared) return { sim: r, mc: m, atk: false }; }
      if (plusAtk) {
        const r0 = run(mk(plusAtk), mcs[0]);
        if (r0.cleared) return { sim: r0, mc: mcs[0], atk: true };
        for (const m of mcs.slice(1)) { const r = run(mk(plusAtk), m); if (r.cleared) return { sim: r, mc: m, atk: true }; }
      }
      noteFail(mk(0).map((x) => x.svt.name), first);
      return null;
    };
    // 령주는 아껴 쓴다: 령주 없이 먼저 해 보고, 안 될 때만 령주를 쓴 계산을 한다
    const attempt = (f0: number) => {
      const plain = attemptBase(f0);
      if (plain || !st.commandSpell) return plain && { ...plain, cs: false };
      useCs = true;
      const withCs = attemptBase(f0);
      useCs = false;
      return withCs && { ...withCs, cs: true };
    };
    const push = (f: number, r: { sim: SimResult; mc: MysticCode | null; atk: boolean; cs?: boolean }) => {
      const own = slots.filter((_, i) => i !== f);
      const roles = new Map<number, 'dealer' | 'support'>(own.map((s) => [s.no, s.role]));
      (r.atk ? coresAtk : cores).push({
        own: own.map((s) => byNo.get(s.no)!), friend: f >= 0 ? allByNo.get(slots[f].no)! : null,
        friendRole: f >= 0 ? slots[f].role : undefined, roles, sim: r.sim, mc: r.mc, cs: r.cs,
        bench: new Set(own.filter((s) => s.bench).map((s) => s.no)), friendBench: f >= 0 && !!slots[f].bench,
        swapOut: slots.find((s) => s.swapOut)?.no,
        seq: slots.map((s, i) => ({ s, i })).filter((x) => !x.s.bench).map((x) => (x.i === f ? 'f' : String(x.s.no))),
        u: unit,
      });
    };
    // 프렌드가 내 서번트와 조건이 다르면(시작 NP 예장) 프렌드 자리마다 따로 계산한다.
    // 그렇지 않으면 전투 결과는 누가 프렌드든 같다고 보고 내 서번트가 가장 많은 배치로 한 번만 계산한다.
    if (st.friendStartNp) {
      let best = 0;
      for (const f of as) { const r = attempt(f); if (r) { push(f, r); best = best === 1 ? 1 : r.atk ? 2 : 1; } }
      return best;
    }
    const r = attempt(as[0]);
    if (!r) return 0;
    for (const f of as) push(f, r);
    return r.atk ? 2 : 1;
  };
  const sup = (no: number, o: Partial<Slot> = {}): Slot => ({ no, role: 'support', ...o });
  const deal = (d: PoolEntry, o: Partial<Slot> = {}): Slot => ({ no: d.svt.no, role: 'dealer', ...o });

  const total = dealers.filter((_, i) => !shard || i % shard.count === shard.index).length * combos.length;
  let done = 0;
  let plain = 0; // 딜러 1기 + 서포터 편성으로 예장 ATK 없이 클리어된 수
  for (const d of dealers) {
    if (!mine()) continue;
    const okSingles = new Set<number>();
    let soloOk = false;
    for (const combo of combos) {
      done++;
      if (soloOk || combo.includes(d.svt.no)) continue;
      if (combo.some((n) => okSingles.has(n))) continue; // 더 작은 조합으로 이미 클리어 가능
      let got = tryLineup([deal(d, { boost: true }), ...combo.map((n) => sup(n))], mcList);
      // 안 되면 서포터도 보구를 쏘는 운용: 서포터가 앞 웨이브를 맡고 딜러는 마지막 웨이브에 집중한다
      if (!got && quest.waves.length > 1 && combo.some((n) => allByNo.get(n)?.np?.dmg)) {
        // 보구 계획 탐색은 역할과 무관하게 같은 조합을 보므로 위에서 이미 했다: 여기서는 웨이브 분담 운용만 본다
        const keep = usePlan;
        usePlan = false;
        got = tryLineup([deal(d, { boost: true }), ...combo.map((n): Slot => (allByNo.get(n)?.np?.dmg ? { no: n, role: 'dealer', sub: true } : sup(n)))], mcList);
        usePlan = keep;
      }
      if (got) {
        if (got === 1) plain++;
        if (combo.length === 0) soloOk = true;
        else if (combo.length === 1) okSingles.add(combo[0]);
      }
    }
    // 프렌드로 같은 딜러를 빌려 보구를 번갈아 쓰는 편성(프렌드 보구 레벨은 1로 가정)
    if (allowDup && !soloOk && !tryLineup([deal(d, { boost: true }), deal(d, { friendOnly: true })], mcList)) {
      for (const n of supports) if (n !== d.svt.no) tryLineup([deal(d, { boost: true }), deal(d, { friendOnly: true }), sup(n)], mcList);
    }
    onProgress?.(done, total);
  }

  // 딜러 후보: 혼자서 준 대미지가 큰 딜러 + 마지막 웨이브(보스)에 강한 딜러
  const top = topD.slice(0, 14);
  if (dealers.length > 1) {
    const lastQuest: QuestData = { ...quest, waves: [quest.waves[quest.waves.length - 1]], waveCalls: undefined };
    const finishers = dealers
      .map((d) => ({ d, score: dmgOf(simulateBest([{ ...cfg(d, 'dealer'), startNp: 10000 }], lastQuest, rel, 1, st.roll, { cardNp: st.cardNp, score: st.score, prune: false })) }))
      .sort((a, b) => b.score - a.score).slice(0, 8).map((x) => x.d);
    for (const d of finishers) if (!top.includes(d)) top.push(d);
  }

  // 딜러 2~3명 조합. 딜러 1명 편성이 있더라도 항상 시도한다(인연용 자리가 줄지만 더 적은 조건으로 깨지는 경우가 있다).
  void plain;
  if (dealers.length > 1) {
    const single = combos.filter((c) => c.length <= 1);
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
      if (!mine()) continue;
      for (const c of single) if (tryLineup([deal(top[i], { boost: true }), deal(top[j]), ...c.map((n) => sup(n))], mcList) && c.length === 0) break;
    }
    // 같은 딜러 2기(내 것 + 프렌드)에 다른 딜러 1기를 더한 편성
    if (allowDup) for (const d of top) if (mine()) for (const d2 of top) if (d2 !== d) tryLineup([deal(d, { boost: true }), deal(d, { friendOnly: true }), deal(d2)], mcList);
    // 내 딜러 3기
    const t3 = top.slice(0, 12);
    for (let i = 0; i < t3.length; i++) for (let j = i + 1; j < t3.length; j++) if (mine()) for (let k = j + 1; k < t3.length; k++) {
      tryLineup([deal(t3[i], { boost: true }), deal(t3[j]), deal(t3[k])], mcList);
    }
  }

  // ---- 후열 교체를 쓰는 편성
  const subD = top.slice(0, 20);
  const optSup: (number | null)[] = [null, ...supports];
  // 보구를 쓰면 퇴장하는 서번트(아라쉬, 진궁 등): 퇴장한 자리에 후열 선두가 들어와 오더 체인지와 비슷한 효과를 낸다
  for (const x of dealers.filter((p) => p.svt.np?.dies)) {
    for (const d of subD) {
      if (d === x || !mine()) continue;
      for (const s1 of optSup) for (const s2 of optSup) {
        if (x.svt.np!.dies === 'ally') {
          // 진궁: 선두의 다른 아군(스킬을 다 쓴 서포터)을 제물로 쓴다
          if (s1 === null) continue;
          tryLineup([deal(x), sup(s1), deal(d, { boost: true }), ...(s2 === null ? [] : [sup(s2, { bench: true })])], mcList);
        } else {
          if (s2 === null && s1 === null) continue;
          tryLineup([deal(x), deal(d, { boost: true }), ...(s1 === null ? [] : [sup(s1)]), ...(s2 === null ? [] : [sup(s2, { bench: true })])], mcList);
        }
      }
    }
    onProgress?.(done, total);
  }
  // 오더 체인지: 서포터 하나의 스킬을 다 쓰고 후열의 다른 서포터와 바꾼다
  if (ocMc) {
    for (const d of subD) {
      for (const s1 of optSup) if (mine()) for (const s2 of supports) for (const s3 of supports) {
        tryLineup([deal(d, { boost: true }), ...(s1 === null ? [] : [sup(s1)]), sup(s2, { swapOut: true }), sup(s3, { bench: true })], [ocMc]);
      }
      onProgress?.(done, total);
    }
  }

  return {
    cores: cores.map(pack), coresAtk: coresAtk.map(pack), simulated, bestFail, noOc: !!st.orderChange && !ocMc,
    autoMc: st.mcAuto?.length ? (mcList.slice(1).map((m) => m!.name.replace(/^마술예장 /, '')).join(', ') || null) : undefined,
  };
}

/** 2단계: 찾은 코어(여러 워커의 몫을 합친 것) 위에서 인연을 최적화해 결과를 만든다. */
export function finishSearch(parts: CorePart[], pool: PoolEntry[], all: Servant[], stock: CEStock[], quest: QuestData, st: Settings): SearchOutput {
  const byNo = new Map(pool.map((p) => [p.svt.no, p]));
  const allByNo = new Map(all.map((s) => [s.no, s]));
  const mcById = new Map([st.mc, ...(st.mcAuto ?? [])].filter((m): m is MysticCode => !!m).map((m) => [m.id, m]));
  const atkStock = bestAtkStock(stock);
  const unpack = (c: PackedCore): Core => ({
    own: c.own.map((n) => byNo.get(n)!), friend: c.friend === null ? null : allByNo.get(c.friend)!, friendRole: c.friendRole, roles: new Map(c.roles), sim: c.sim,
    mc: c.mc === null ? null : mcById.get(c.mc) ?? null, cs: c.cs, bench: new Set(c.bench), friendBench: c.friendBench, swapOut: c.swapOut, seq: c.seq, u: c.u,
  });
  // 단위 번호순으로 합치면 한 번에 찾았을 때와 순서가 같다(같은 단위 안의 순서는 그대로 둔다)
  const merge = (pick: (p: CorePart) => PackedCore[]) => parts.flatMap(pick).map(unpack).sort((a, b) => a.u - b.u);
  const cores = merge((p) => p.cores), coresAtk = merge((p) => p.coresAtk);
  const simulated = parts.reduce((n, p) => n + p.simulated, 0);
  let bestFail: CorePart['bestFail'] = null;
  for (const p of parts) if (p.bestFail && (!bestFail || p.bestFail.sim.broken > bestFail.sim.broken || (p.bestFail.sim.broken === bestFail.sim.broken && p.bestFail.u < bestFail.u))) bestFail = p.bestFail;
  const noOc = parts.some((p) => p.noOc);

  /** 클리어되는 편성들 위에서 인연을 최적화한다. 프렌드 예장은 전투에 영향이 없으므로 여기서만 바뀐다. */
  const rank = (s2: Settings): PartyResult[] => {
    // 예장 ATK가 필요한 편성은 그 예장을 반드시 포함하는 조건으로 인연을 따로 최적화한다
    const all2 = [...optimizeBond(cores, pool, stock, quest, s2, null), ...(atkStock ? optimizeBond(coresAtk, pool, stock, quest, s2, atkStock) : [])];
    // 인연이 같으면 턴이 적고, 조건(예장 ATK·마술예장·교체)이 덜 붙은 편성을 앞에 둔다
    const burden = (r: PartyResult) => Number(!!r.atkCe) + Number(!!r.mc) + Number(r.back.some((m) => m.sub)) + (r.cs ? 3 : 0);
    all2.sort((a, b) => b.total - a.total || a.turns - b.turns || burden(a) - burden(b) || a.cost - b.cost);
    // 멤버 구성이 완전히 같은 결과는 하나만
    const seen = new Set<string>();
    return all2.filter((r) => {
      const k = [...r.front, ...r.back].filter((m) => m.svt).map((m) => m.svt.no + (m.friend ? 'f' : '')).sort().join(',') + '|' + r.ces.map((c) => c.ce.no).sort().join(',');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, s2.topN);
  };
  let results = rank(st);
  let autoFriendCe: string | null | undefined;
  if (st.friendCeAuto && !st.friendStartNp && (cores.length || coresAtk.length)) {
    // 후보: 조건마다 프렌드가 꼈을 때 수치가 가장 큰 예장 하나씩(조건 없는 % 중에서는 칼데아 티타임), 고정치 하나
    const supVal = (c: BondCE) => (c.sup ?? c.val)[1];
    const byCond = new Map<string, BondCE>();
    for (const c of stock.map((s) => s.ce)) {
      const key = c.kind === 'flat' ? 'flat' : JSON.stringify(c.cond);
      const cur = byCond.get(key);
      if (!cur || supVal(c) > supVal(cur)) byCond.set(key, c);
    }
    autoFriendCe = null;
    for (const c of byCond.values()) {
      const r = rank({ ...st, friendCe: { no: c.no, mlb: true } });
      if (r[0] && (!results[0] || r[0].total > results[0].total)) { results = r; autoFriendCe = c.name; }
    }
  }
  const feasible = cores.length + coresAtk.length;
  let note: string | undefined;
  if (st.must?.length && feasible && !results.length) {
    const missing = st.must.filter((no) => !byNo.has(no)).map((no) => allByNo.get(no)?.name ?? `#${no}`);
    note = missing.length
      ? `필수 포함 서번트가 서번트 풀에 없습니다: ${missing.join(', ')}. 보유 서번트만 쓰는 중이라면 "내 서번트"에 등록되어 있는지 확인하세요.`
      : '클리어되는 조합은 있지만, 필수 포함 서번트를 모두 넣으면 자리(내 서번트 5기)나 코스트가 모자랍니다.';
  }
  if (noOc) note = [note, '오더 체인지를 켰지만 고른 마술예장에 오더 체인지가 없어 쓰지 않았습니다. 마술예장을 자동 선택으로 두거나 전투복·결전용 제복을 고르세요.'].filter(Boolean).join(' ');
  const fail = bestFail as CorePart['bestFail'];
  return { results, simulated, feasible, bestFail: feasible || !fail ? null : { names: fail.names, sim: fail.sim }, note, autoFriendCe, autoMc: parts[0]?.autoMc };
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

interface UniItem { ce: BondCE; mlb: boolean; cost: number; g: number; pct: number; flat: number; atk: number }
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
      for (let i = 0; i < n; i++) uni.push({ ce: s.ce, mlb: s.mlb, cost: s.ce.cost, g, pct: isFlat ? 0 : pctOf(s), flat: isFlat ? pctOf(s) : 0, atk: s.atk ?? s.ce.atk });
    }
  }
  for (const t of condTypes) t.copies.sort((a, b) => b.pct - a.pct || a.cost - b.cost);
  // 인연 효과와 코스트가 같으면 ATK가 높은 예장을 고른다(예: 칼데아 티타임 대신 명탐정 폼즈).
  // 아래 계산은 먼저 본 예장을 유지하므로 ATK가 높은 순으로 늘어놓는다.
  uni.sort((a, b) => b.atk - a.atk);

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
    // 시작 위치(전열·후열)가 다르면 전열 보너스가 달라지므로 따로 본다
    const k = c.own.map((p) => p.svt.no + (c.bench.has(p.svt.no) ? 'b' : '')).sort().join(',') + (c.friend ? (c.friendBench ? '|fb' : '|ff') : '');
    const cur = uniq.get(k);
    const worse = (x: Core) => x.sim.turns * 10 + (x.mc ? 1 : 0) + (x.swapOut !== undefined ? 2 : 0) + (x.cs ? 4 : 0);
    if (!cur || worse(c) < worse(cur)) uniq.set(k, c);
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
      // 후열에서 시작하는 교체 요원은 전열 보너스를 받지 못하고, 프렌드가 후열이면 전원 보너스도 없다
      const friendFront = !!core.friend && !core.friendBench;
      const allFront = friendFront ? FRONT_FRIEND : 0;
      const frontFree = Math.max(0, 3 - (friendFront ? 1 : 0) - (ownIdx.length - core.bench.size));
      const coreMul = (1000 + FRONT_OWN + allFront) / 1000, backMul = (1000 + allFront) / 1000;
      // a = Σ 가중치×전열배율, c = Σ 가중치×전열배율×조건부%
      let costM = cc, wM = 0, aM = 0, cM = 0, n15M = 0;
      for (const i of ownIdx) {
        const w = pool[i].weight;
        n15M += is15[i];
        const mul = core.bench.has(pool[i].svt.no) ? backMul : coreMul;
        costM += pool[i].svt.cost; wM += w; aM += w * mul; cM += w * mul * condPct[i];
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
    const friendFront = !!b.core.friend && !b.core.friendBench;
    const allFront = friendFront ? FRONT_FRIEND : 0;
    const mk = (p: PoolEntry, role: Member['role'], inFront: boolean): Member => ({
      svt: p.svt, friend: false, role, counted: p.weight > 0,
      bond: bondFor(base, allFront + (inFront ? FRONT_OWN : 0), pctFor(p.svt.traits), flat) * st.teapot,
    });
    const coreMembers = b.core.own.map((p): Member => {
      const sub = b.core.bench.has(p.svt.no);
      return { ...mk(p, b.core.roles.get(p.svt.no) ?? 'filler', !sub), sub, swapOut: b.core.swapOut === p.svt.no && !sub };
    });
    const friend: Member | null = b.core.friend
      ? { svt: b.core.friend, friend: true, role: b.core.friendRole ?? 'support', bond: 0, counted: false, sub: b.core.friendBench, swapOut: b.core.swapOut === b.core.friend.no && !b.core.friendBench && !b.core.own.some((p) => p.svt.no === b.core.swapOut) }
      : null;
    const pos = (m: Member) => { const i = b.core.seq.indexOf(m.friend ? 'f' : String(m.svt.no)); return i < 0 ? 99 : i; };
    const front: Member[] = [...coreMembers.filter((m) => !m.sub), ...(friend && friendFront ? [friend] : [])].sort((x, y) => pos(x) - pos(y));
    // 후열은 교체 요원을 맨 앞에 둔다(퇴장·오더 체인지 때 후열 선두가 들어온다)
    const back: Member[] = [...coreMembers.filter((m) => m.sub), ...(friend && !friendFront ? [friend] : [])];
    const frontFree = Math.max(0, 3 - front.length);
    const fillers = b.fillers.map((i) => pool[i])
      .sort((x, y) => y.weight * (10000 + pctFor(y.svt.traits)) - x.weight * (10000 + pctFor(x.svt.traits)))
      .map((p, k) => mk(p, 'filler', k < frontFree));
    fillers.forEach((f, k) => (k < frontFree ? front : back).push(f));
    if (!friend) back.push({ svt: null as unknown as Servant, friend: true, role: 'filler', bond: 0, counted: false });
    const own = [...coreMembers, ...fillers];
    // 반드시 포함하는 예장은 효과를 위에서 이미 더했으므로 목록에만 추가한다
    const allCes = forced ? [{ ce: forced.ce, mlb: forced.mlb }, ...ces] : ces;
    // 누가 어떤 예장을 끼는지 정한다: 필수 ATK 예장은 지정된 딜러에게, 나머지는 ATK가 높은 것부터 딜러 → 그 외 순으로
    const atkDealer = forced ? (b.core.own.find((p) => b.core.roles.get(p.svt.no) === 'dealer' && !p.svt.np?.dies) ?? b.core.own[0]).svt.no : -1;
    const ceAtk = (c: { ce: BondCE }) => stock.find((x) => x.ce.no === c.ce.no)?.atk ?? c.ce.atk;
    const rest = ces.slice().sort((x, y) => ceAtk(y) - ceAtk(x));
    const ownInOrder = [...front, ...back].filter((m) => m.svt && !m.friend);
    for (const m of ownInOrder) if (forced && m.svt.no === atkDealer) m.ce = { ce: forced.ce, mlb: forced.mlb };
    for (const m of [...ownInOrder.filter((x) => x.role === 'dealer'), ...ownInOrder.filter((x) => x.role !== 'dealer')]) if (!m.ce && rest.length) m.ce = rest.shift();
    if (fCe) for (const m of [...front, ...back]) if (m.friend) m.ce = { ce: fCe, mlb: fMlb === 1 };
    out.push({
      turns: b.core.sim.turns, front, back, ces: allCes, friendCe: fCe, sim: b.core.sim,
      total: own.reduce((s, m) => s + (m.counted ? m.bond : 0), 0),
      cost: own.reduce((s, m) => s + m.svt.cost, 0) + allCes.reduce((s, c) => s + c.ce.cost, 0),
      atkCe: forced ? { ce: forced.ce, atk: forced.atk ?? forced.ce.atk, dealer: (b.core.own.find((p) => b.core.roles.get(p.svt.no) === 'dealer' && !p.svt.np?.dies) ?? b.core.own[0]).svt.name } : undefined,
      mc: b.core.mc ? { id: b.core.mc.id, name: b.core.mc.name, face: b.core.mc.face } : undefined,
      cs: b.core.cs || undefined,
    });
  }
  return out;
}
