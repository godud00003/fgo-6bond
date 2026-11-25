// 보구만으로 적을 정리할 수 있는지 판정하는 간이 전투 시뮬레이터.
// 평타 대미지, 적의 행동(피격 NP, 디버프, 사망), 적 패시브·내성, 오버차지는 다루지 않는다.
// 평타로 얻는 NP는 계산하지 않고, 옵션(cardNp)으로 준 가정치만 더한다.
import type { ActorCfg, BuffDef, EnemyDef, Fn, QuestData, Rel, Servant, SimResult, Skill, Sv, TurnLog } from './types.ts';

const CARD_TRAIT: Record<string, number> = { arts: 4001, buster: 4002, quick: 4003 };
const CARD_DMG: Record<string, number> = { arts: 1, buster: 1.5, quick: 0.8 };
const CARD_NP: Record<string, number> = { arts: 3, buster: 0, quick: 1 };
const isCardTrait = (id: number) => id >= 4001 && id <= 4008;
const NP_CARD_TRAIT = 4007;

interface Buff { t: string; val: number; turn: number; count: number; d: BuffDef }
interface Actor { cfg: ActorCfg; gauge: number; buffs: Buff[]; cd: number[]; fired: boolean }
interface Enemy { def: EnemyDef; bars: number[]; buffs: Buff[]; dead: boolean; summoned?: boolean }
interface State {
  actors: Actor[]; field: Enemy[]; reserve: Enemy[]; wave: number; quest: QuestData;
  rel: Rel; roll: number; killed: number; broken: number;
  /** 마술예장 스킬을 쓰는 가상의 행동 주체(전투에는 참가하지 않는다) */
  master: Actor | null;
  cardNp: number;
  face: boolean;
}

export interface SimExtra {
  /** 마술예장 스킬(없으면 미사용) */
  mc?: Skill[] | null;
  /** 보구를 쓰지 않은 턴에 평타로 얻는다고 가정하는 NP (10000 = 100%) */
  cardNp?: number;
  /** 보구를 쓰고 남은 카드 칸의 평타를 평균 기대치로 계산한다 */
  face?: boolean;
}
export interface SimOptions extends SimExtra { maxTurns: number; roll: number; mode: 'lazy' | 'eager' }

const svAt = (fn: Fn, idx: number): Sv => (Array.isArray(fn.sv) ? fn.sv[Math.min(idx, fn.sv.length - 1)] : fn.sv);
const hasAny = (list: number[] | undefined, set: number[]) => !list || !list.length || list.some((x) => set.includes(x));

function cloneState(s: State): State {
  return {
    ...s,
    actors: s.actors.map((a) => ({ cfg: a.cfg, gauge: a.gauge, cd: a.cd.slice(), fired: a.fired, buffs: a.buffs.map((b) => ({ ...b })) })),
    master: s.master && { ...s.master, cd: s.master.cd.slice(), buffs: [] },
    field: s.field.map((e) => ({ def: e.def, bars: e.bars.slice(), dead: e.dead, summoned: e.summoned, buffs: e.buffs.map((b) => ({ ...b })) })),
    reserve: s.reserve.map((e) => ({ def: e.def, bars: e.bars.slice(), dead: e.dead, buffs: [] })),
  };
}

function loadWave(s: State) {
  const defs = s.quest.waves[s.wave].slice().sort((a, b) => a.deckId - b.deckId);
  const all = defs.map((def) => ({ def, bars: def.bars.slice(), buffs: [], dead: false }));
  s.field = all.slice(0, 3);
  s.reserve = all.slice(3);
  summon(s, false); // 웨이브 시작 시 소환(자기 증원 목록을 가진 적만)
}

/**
 * 증원 소환. 적 AI는 필드에 빈자리가 있으면 소환 스킬을 쓰며, 같은 증원을 몇 번이고 다시 부른다.
 * 자기 목록(def.call)을 가진 적은 그 적이 살아 있을 때, 웨이브 공통 목록은 적이 하나라도 남아 있을 때 소환된다.
 */
function summon(s: State, withStage: boolean) {
  const add = (def: EnemyDef) => { if (s.field.length < 3) s.field.push({ def, bars: def.bars.slice(), buffs: [], dead: false, summoned: true }); };
  const callers = s.field.filter((e) => !e.dead);
  if (!callers.length) return;
  for (const c of callers) for (const d of c.def.call ?? []) add(d);
  if (withStage) for (const d of s.quest.waveCalls?.[s.wave] ?? []) add(d);
}

const alive = (s: State) => s.field.filter((e) => !e.dead);
function pickEnemy(s: State): Enemy | undefined {
  return alive(s).reduce<Enemy | undefined>((a, e) => (!a || e.bars[0] > a.bars[0] ? e : a), undefined);
}

/** 스킬·보구의 부가 효과 1개를 적용한다. */
function applyFn(s: State, user: Actor, fn: Fn, lvIdx: number, ally: Actor | undefined) {
  const sv = svAt(fn, lvIdx);
  if (sv.Rate !== undefined && sv.Rate < 1000) return; // 확률 효과는 실패로 가정
  if (fn.qtv?.length && !fn.qtv.some((t) => s.quest.fieldTraits.includes(t))) return;
  let allies: Actor[] = [];
  let enemies: Enemy[] = [];
  switch (fn.tg) {
    case 'self': allies = [user]; break;
    case 'ptAll': case 'ptFull': allies = s.actors; break;
    case 'ptOne': allies = ally ? [ally] : []; break;
    case 'ptOther': case 'ptOtherFull': allies = s.actors.filter((a) => a !== user); break;
    case 'enemyAll': enemies = alive(s); break;
    case 'enemy': { const e = pickEnemy(s); enemies = e ? [e] : []; break; }
    default: return;
  }
  if (fn.tv?.length) {
    allies = allies.filter((a) => fn.tv!.some((t) => a.cfg.svt.traits.includes(t)));
    enemies = enemies.filter((e) => fn.tv!.some((t) => e.def.traits.includes(t)));
  }
  const v = sv.Value ?? 0;
  if (fn.t === 'gainNp') for (const a of allies) a.gauge = Math.min(30000, a.gauge + v);
  else if (fn.t === 'lossNp') for (const a of allies) a.gauge = Math.max(0, a.gauge - v);
  else if (fn.t === 'shortenSkill') for (const a of allies) a.cd = a.cd.map((c) => Math.max(0, c - v));
  else if (fn.b) {
    for (const d of fn.b) {
      const mk = (): Buff => ({ t: d.t, val: v, turn: sv.Turn ?? -1, count: sv.Count ?? -1, d });
      for (const a of allies) a.buffs.push(mk());
      for (const e of enemies) e.buffs.push(mk());
    }
  }
}

/** 공격자 쪽 버프가 이번 보구 공격에 적용되는지 */
function attackerBuffApplies(b: Buff, att: Actor, card: string, def: EnemyDef): boolean {
  const cs = b.d.cs;
  if (cs?.length) {
    const cardIds = cs.filter(isCardTrait);
    const other = cs.filter((x) => !isCardTrait(x));
    if (cardIds.length && !cardIds.includes(CARD_TRAIT[card]) && !cardIds.includes(NP_CARD_TRAIT)) return false;
    if (other.length && !other.some((x) => att.cfg.svt.traits.includes(x))) return false;
  }
  return hasAny(b.d.co, def.traits);
}
/** 적에게 걸린 디버프가 이번 보구 공격에 적용되는지 */
function defenderBuffApplies(b: Buff, att: Actor, card: string): boolean {
  const all = [...(b.d.cs || []), ...(b.d.co || [])];
  const cardIds = all.filter(isCardTrait);
  if (cardIds.length && !cardIds.includes(CARD_TRAIT[card])) return false;
  const other = (b.d.co || []).filter((x) => !isCardTrait(x));
  return !other.length || other.some((x) => att.cfg.svt.traits.includes(x));
}

interface Mods { card: number; atk: number; power: number; np: number; gain: number; add: number }
function mods(att: Actor, e: Enemy, card: string): Mods {
  const m: Mods = { card: 0, atk: 0, power: 0, np: 0, gain: 0, add: 0 };
  const rates = att.buffs.filter((b) => b.t === 'buffRate');
  for (const b of att.buffs) {
    if (!attackerBuffApplies(b, att, card, e.def)) continue;
    const v = b.val / 1000;
    switch (b.t) {
      case 'upCommandall': m.card += v; break;
      case 'downCommandall': m.card -= v; break;
      case 'upAtk': m.atk += v; break;
      case 'downAtk': m.atk -= v; break;
      case 'upDamage': m.power += v; break;
      case 'upNpdamage': {
        let boost = 0;
        for (const r of rates) if (r.d.ur?.some((x) => b.d.v?.includes(x))) boost += r.val / 1000;
        m.np += v * (1 + boost);
        break;
      }
      case 'downNpdamage': m.np -= v; break;
      case 'upDropnp': m.gain += v; break;
      case 'downDropnp': m.gain -= v; break;
      case 'addDamage': m.add += b.val; break;
    }
  }
  for (const b of e.buffs) {
    if (!defenderBuffApplies(b, att, card)) continue;
    const v = b.val / 1000;
    if (b.t === 'downDefence') m.atk += v;
    else if (b.t === 'upDefence') m.atk -= v;
    else if (b.t === 'downDefencecommandall') m.card += v;
  }
  return m;
}

function superEffective(fn: Fn, sv: Sv, e: EnemyDef): number {
  switch (fn.t) {
    case 'damageNpIndividual':
      return sv.Target !== undefined && e.traits.includes(sv.Target) ? (sv.Correction ?? 1000) / 1000 : 1;
    case 'damageNpIndividualSum':
      return (sv.Value2 ?? 1000) / 1000; // 중첩 특공은 0중첩으로 가정
    default:
      return 1; // 상태 특공, HP 비례, 레어도 특공 등은 기본 배율만 적용
  }
}

const CONSUMED = new Set(['upCommandall', 'upAtk', 'upDamage', 'upNpdamage', 'upDropnp', 'addDamage', 'buffRate']);

function fireNp(s: State, a: Actor, log?: TurnLog) {
  const np = a.cfg.svt.np!;
  const entry = { who: a.cfg.svt.name, np: np.name, hits: [] as TurnLog['nps'][0]['hits'], refund: 0 };
  let refund = 0;
  a.gauge = 0;
  a.fired = true;
  for (const fn of np.fn) {
    if (!fn.t.startsWith('damageNp')) { applyFn(s, a, fn, a.cfg.npLv - 1, a); continue; }
    const sv = svAt(fn, a.cfg.npLv - 1);
    const targets = fn.tg === 'enemyAll' ? s.field.slice() : (() => { const e = pickEnemy(s); return e ? [e] : []; })();
    for (const e of targets) {
      const m = mods(a, e, np.card);
      const svt = a.cfg.svt;
      const classAtk = (s.rel.classAttack[svt.cls] ?? 1000) / 1000;
      const affinity = (s.rel.classRelation[svt.cls]?.[e.def.cls] ?? 1000) / 1000;
      const attr = (s.rel.attribute[svt.attr]?.[e.def.attr] ?? 1000) / 1000;
      const dmg = Math.floor(
        a.cfg.atk * ((sv.Value ?? 0) / 1000) * CARD_DMG[np.card] * Math.max(0, 1 + m.card) * classAtk * affinity * attr * 0.23 *
        Math.max(0, 1 + m.atk) * Math.max(0.001, 1 + m.power + m.np) * superEffective(fn, sv, e.def) * s.roll,
      ) + m.add;
      // NP 회수: 히트별 계산, 적을 쓰러뜨린 히트부터 오버킬 1.5배
      let hp = e.dead ? 0 : e.bars[0];
      let dealt = 0;
      const perHit = np.gain * CARD_NP[np.card] * (1 + m.card) * (e.def.tdRate / 1000) * Math.max(0, 1 + m.gain);
      np.dist.forEach((d, i) => {
        const hd = i === np.dist.length - 1 ? dmg - dealt : Math.floor((dmg * d) / 100);
        dealt += hd;
        hp -= hd;
        refund += hp <= 0 ? Math.floor(Math.floor(perHit) * 1.5) : Math.floor(perHit);
      });
      if (!e.dead) {
        const before = e.bars[0];
        let kill = false;
        if (dmg >= before) {
          e.bars.shift();
          if (!e.summoned) s.broken++;
          if (!e.bars.length) { e.dead = true; kill = true; if (!e.summoned) s.killed++; }
        } else e.bars[0] -= dmg;
        entry.hits.push({ enemy: e.def.name, dmg, hp: before, kill });
      }
    }
  }
  a.gauge = Math.min(30000, a.gauge + refund);
  entry.refund = refund;
  for (const b of a.buffs) if (b.count > 0 && CONSUMED.has(b.t)) b.count--;
  a.buffs = a.buffs.filter((b) => b.count !== 0);
  log?.nps.push(entry);
}

const dealers = (s: State) => s.actors.filter((a) => a.cfg.role === 'dealer' && a.cfg.svt.np?.dmg);

/** 준비된 딜러의 보구를 차례로 발동한다. 필드가 비면 남은 보구는 아낀다. */
function npPhase(s: State, log?: TurnLog, withFace = true) {
  let used = 0;
  let first: string | null = null;
  for (const a of dealers(s)) {
    if (a.gauge < 10000 || !alive(s).length) continue;
    fireNp(s, a, log);
    if (!used) first = a.cfg.svt.np!.card;
    used++;
  }
  if (s.face && withFace) facePhase(s, used, first, log);
}
function wouldClear(s: State): boolean {
  const c = cloneState(s);
  // 스킬을 더 쓸지 판단할 때는 보구만 본다(평타까지 넣으면 계산량이 10배가 된다). 그래서 평타로 마무리될 상황에서도 버프를 조금 더 쓰는 쪽으로 기운다.
  npPhase(c, undefined, false);
  return !alive(c).length;
}

// ---------------------------------------------------------------- 평타
// 카드는 15장 덱에서 무작위로 나오므로 정확히 계산할 수 없다. 여기서는 보구를 먼저 내고 남은 칸마다
// "덱 15장 중 아무 카드 1장"의 평균 기대치를 낸다고 본다. 유리한 카드를 고르는 이점, 크리티컬,
// 엑스트라 어택, 오버킬 보너스는 넣지 않으므로 실제보다 낮게 나오는 편이다.
const FACE_KEY: Record<string, string> = { a: 'arts', b: 'buster', q: 'quick' };
const POS_DMG = [1, 1.2, 1.4];
const POS_NP = [1, 1.5, 2];
const DECK_SIZE = 15; // 전열 3기 × 5장. 시뮬레이션에 없는 전열(인연용 서번트)의 카드는 0으로 친다.

const deckCounts = new Map<string, Record<string, number>>();
function deckCount(deck: string, k: string): number {
  let c = deckCounts.get(deck);
  if (!c) { c = { a: 0, b: 0, q: 0 }; for (const ch of deck) if (ch in c) c[ch]++; deckCounts.set(deck, c); }
  return c[k];
}

function facePhase(s: State, used: number, first: string | null, log?: TurnLog) {
  const out: NonNullable<TurnLog['face']> = { cards: 0, hits: [], np: 0 };
  // 버프 보정은 카드 위치와 무관하므로 대상이 바뀔 때만 다시 구한다
  let cached: Enemy | undefined;
  const memo = new Map<string, Mods>();
  for (let pos = used; pos < 3; pos++) {
    // 약한 적부터 마무리한다
    const target = alive(s).reduce<Enemy | undefined>((a, e) => (!a || e.bars[0] < a.bars[0] ? e : a), undefined);
    if (!target) break;
    if (target !== cached) { memo.clear(); cached = target; }
    let dmg = 0;
    for (let ai = 0; ai < s.actors.length; ai++) {
      const a = s.actors[ai];
      const svt = a.cfg.svt;
      const classAtk = (s.rel.classAttack[svt.cls] ?? 1000) / 1000;
      const affinity = (s.rel.classRelation[svt.cls]?.[target.def.cls] ?? 1000) / 1000;
      const attr = (s.rel.attribute[svt.attr]?.[target.def.attr] ?? 1000) / 1000;
      let gain = 0;
      for (const k of 'abq') {
        const n = deckCount(svt.deck, k); // 같은 종류의 카드는 한 번만 계산한다
        if (!n) continue;
        const card = FACE_KEY[k];
        let m = memo.get(ai + k);
        if (!m) memo.set(ai + k, (m = mods(a, target, card)));
        const cardMul = CARD_DMG[card] * POS_DMG[pos] * Math.max(0, 1 + m.card) + (first === 'buster' ? 0.5 : 0);
        dmg += (n * (a.cfg.atk * 0.23 * cardMul * classAtk * affinity * attr * s.roll * Math.max(0, 1 + m.atk) * Math.max(0.001, 1 + m.power) + m.add)) / DECK_SIZE;
        const npMul = CARD_NP[card] * POS_NP[pos] * Math.max(0, 1 + m.card) + (first === 'arts' ? 1 : 0);
        gain += (n * svt.hits[k as 'a'] * svt.cgain[k as 'a'] * npMul * (target.def.tdRate / 1000) * Math.max(0, 1 + m.gain)) / DECK_SIZE;
      }
      a.gauge = Math.min(30000, a.gauge + gain);
      out.np += gain;
    }
    const d = Math.floor(dmg);
    const before = target.bars[0];
    let kill = false;
    if (d >= before) {
      target.bars.shift();
      if (!target.summoned) s.broken++;
      if (!target.bars.length) { target.dead = true; kill = true; if (!target.summoned) s.killed++; }
    } else target.bars[0] -= d;
    out.cards++;
    out.hits.push({ enemy: target.def.name, dmg: d, hp: before, kill });
  }
  if (log && out.cards) log.face = out;
}

interface SkillRef { a: Actor; i: number }
const skillFns = (r: SkillRef) => r.a.cfg.svt.skills[r.i].fn;
const skillLvOf = (r: SkillRef) => r.a.cfg.skillLvs?.[r.i] ?? r.a.cfg.skillLv;
function chargeFor(r: SkillRef, target: Actor): number {
  let sum = 0;
  for (const fn of skillFns(r)) {
    if (fn.t !== 'gainNp') continue;
    const hit = fn.tg === 'self' ? r.a === target
      : fn.tg === 'ptAll' || fn.tg === 'ptFull' || fn.tg === 'ptOne' ? true
        : fn.tg === 'ptOther' || fn.tg === 'ptOtherFull' ? r.a !== target : false;
    if (hit) sum += svAt(fn, skillLvOf(r) - 1).Value ?? 0;
  }
  return sum;
}
const hasBuff = (r: SkillRef) => skillFns(r).some((f) => f.b || f.t === 'shortenSkill');
const hasCharge = (r: SkillRef) => skillFns(r).some((f) => f.t === 'gainNp');

function available(s: State): SkillRef[] {
  const out: SkillRef[] = [];
  for (const a of s.master ? [...s.actors, s.master] : s.actors) a.cfg.svt.skills.forEach((_, i) => { if (a.cd[i] === 0) out.push({ a, i }); });
  return out;
}
function useSkill(s: State, r: SkillRef, target: Actor, log?: TurnLog) {
  const sk = r.a.cfg.svt.skills[r.i];
  const lv = skillLvOf(r);
  for (const fn of sk.fn) applyFn(s, r.a, fn, lv - 1, target);
  r.a.cd[r.i] = sk.cd[Math.min(lv, sk.cd.length) - 1];
  const needsTarget = sk.fn.some((f) => f.tg === 'ptOne');
  log?.skills.push({ who: r.a.cfg.svt.name, skill: sk.name, target: needsTarget ? target.cfg.svt.name : undefined });
}

/** 낭비가 가장 적은 NP 충전 스킬 조합으로 대상의 게이지를 100%까지 채운다. */
function ensureCharge(s: State, d: Actor, log?: TurnLog): boolean {
  const need = 10000 - d.gauge;
  if (need <= 0) return true;
  const cands = available(s).map((r) => ({ r, c: chargeFor(r, d) })).filter((x) => x.c > 0).slice(0, 10);
  let bestMask = -1, bestSum = Infinity, bestN = Infinity;
  for (let mask = 1; mask < 1 << cands.length; mask++) {
    let sum = 0, n = 0;
    for (let i = 0; i < cands.length; i++) if (mask & (1 << i)) { sum += cands[i].c; n++; }
    if (sum >= need && (sum < bestSum || (sum === bestSum && n < bestN))) { bestMask = mask; bestSum = sum; bestN = n; }
  }
  if (bestMask < 0) return false;
  const chosen = cands.filter((_, i) => bestMask & (1 << i)).map((x) => x.r);
  chosen.sort((x, y) => Number(y.a === d) - Number(x.a === d)); // 딜러 본인 스킬 먼저(쿨타임 단축 효과를 살리기 위해)
  for (const r of chosen) useSkill(s, r, d, log);
  return true;
}

function reachable(s: State, d: Actor): boolean {
  return d.gauge + available(s).reduce((sum, r) => sum + chargeFor(r, d), 0) >= 10000;
}

function playTurn(s: State, mode: 'lazy' | 'eager', log: TurnLog) {
  const ds = dealers(s);
  if (!ds.length) { npPhase(s, log); return; }
  const main = ds.find((d) => reachable(s, d));
  const order = (list: SkillRef[], d: Actor) =>
    list.sort((x, y) => Number(hasCharge(x)) - Number(hasCharge(y)) || Number(y.a === d) - Number(x.a === d));
  if (mode === 'eager' && main) {
    for (const r of order(available(s).filter((r) => hasBuff(r) && !hasCharge(r)), main)) useSkill(s, r, main, log);
  }
  for (const d of ds) {
    if (wouldClear(s)) break;
    ensureCharge(s, d, log);
  }
  const ready = ds.find((d) => d.gauge >= 10000);
  if (ready) {
    for (const r of order(available(s).filter(hasBuff), ready)) {
      if (wouldClear(s)) break;
      useSkill(s, r, ready, log);
    }
  }
  npPhase(s, log);
}

function endTurn(s: State): boolean {
  if (s.master) s.master.cd = s.master.cd.map((c) => Math.max(0, c - 1));
  for (const a of s.actors) {
    a.gauge = Math.floor(a.gauge);
    if (!a.fired && s.cardNp) a.gauge = Math.min(30000, a.gauge + s.cardNp);
    a.fired = false;
    for (const b of a.buffs) if (b.t === 'regainNp') a.gauge = Math.min(30000, a.gauge + b.val);
    for (const b of a.buffs) if (b.turn > 0) b.turn--;
    a.buffs = a.buffs.filter((b) => b.turn !== 0);
    a.cd = a.cd.map((c) => Math.max(0, c - 1));
  }
  s.field = s.field.filter((e) => !e.dead);
  for (const e of s.field) {
    for (const b of e.buffs) if (b.turn > 0) b.turn--;
    e.buffs = e.buffs.filter((b) => b.turn !== 0);
  }
  while (s.field.length < 3 && s.reserve.length) s.field.push(s.reserve.shift()!);
  summon(s, true); // 플레이어 행동이 끝난 뒤 남은 적이 빈자리에 증원을 부른다
  if (!s.field.length) {
    s.wave++;
    if (s.wave >= s.quest.waves.length) return true;
    loadWave(s);
  }
  return false;
}

function masterActor(skills: Skill[]): Actor {
  const svt = { id: 0, no: 0, name: '마스터', cls: '', rarity: 0, cost: 0, attr: '', traits: [], atk: { 1: 0, max: 0, 100: 0, 120: 0 }, deck: '', hits: { a: 0, b: 0, q: 0 }, cgain: { a: 0, b: 0, q: 0 }, skills, np: null, passive: [], face: '' } as Servant;
  return { cfg: { svt, npLv: 1, skillLv: 10, atk: 0, startNp: 0, role: 'master' }, gauge: 0, buffs: [], cd: skills.map(() => 0), fired: false };
}

export function simulate(front: ActorCfg[], quest: QuestData, rel: Rel, opt: SimOptions): SimResult {
  const s: State = {
    actors: front.map((cfg) => ({ cfg, gauge: cfg.startNp, buffs: [], cd: cfg.svt.skills.map(() => 0), fired: false })),
    field: [], reserve: [], wave: 0, quest, rel, roll: opt.roll, killed: 0, broken: 0,
    master: opt.mc?.length ? masterActor(opt.mc) : null, cardNp: opt.cardNp ?? 0, face: !!opt.face,
  };
  for (const a of s.actors) for (const fn of a.cfg.svt.passive) applyFn(s, a, fn, 0, a);
  const total = quest.waves.reduce((n, w) => n + w.length, 0);
  const log: TurnLog[] = [];
  const bars = quest.waves.reduce((n, w) => n + w.reduce((m, e) => m + e.bars.length, 0), 0);
  if (!total) return { cleared: false, turns: 0, killed: 0, total, log, broken: 0, bars };
  loadWave(s);
  for (let turn = 1; turn <= opt.maxTurns; turn++) {
    const entry: TurnLog = { turn, wave: s.wave + 1, skills: [], nps: [] };
    playTurn(s, opt.mode, entry);
    log.push(entry);
    if (endTurn(s)) return { cleared: true, turns: turn, killed: s.killed, total, log, broken: s.broken, bars };
  }
  return { cleared: false, turns: opt.maxTurns, killed: s.killed, total, log, broken: s.broken, bars };
}

/** 두 가지 스킬 운용 방침을 모두 돌려 더 나은 결과를 고른다. */
export function simulateBest(front: ActorCfg[], quest: QuestData, rel: Rel, maxTurns: number, roll: number, extra: SimExtra = {}): SimResult {
  const a = simulate(front, quest, rel, { ...extra, maxTurns, roll, mode: 'lazy' });
  if (a.cleared && a.turns <= quest.waves.length) return a;
  const b = simulate(front, quest, rel, { ...extra, maxTurns, roll, mode: 'eager' });
  if (a.cleared !== b.cleared) return a.cleared ? a : b;
  if (a.cleared) return b.turns < a.turns ? b : a;
  return b.broken > a.broken ? b : a;
}
