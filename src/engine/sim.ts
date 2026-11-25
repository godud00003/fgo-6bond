// 보구만으로 적을 정리할 수 있는지 판정하는 간이 전투 시뮬레이터.
// 평타 대미지, 적의 행동(피격 NP, 디버프, 사망), 적 패시브·내성, 오버차지는 다루지 않는다.
// 평타로 얻는 NP는 계산하지 않고, 옵션(cardNp)으로 준 가정치만 더한다.
// 후열: 전열이 퇴장(보구의 즉사 효과)하거나 오더 체인지를 쓰면 후열 선두가 들어온다.
import type { ActorCfg, BuffDef, EnemyDef, Fn, QuestData, Rel, Servant, SimResult, Skill, Sv, TurnLog } from './types.ts';

const CARD_TRAIT: Record<string, number> = { arts: 4001, buster: 4002, quick: 4003 };
const CARD_DMG: Record<string, number> = { arts: 1, buster: 1.5, quick: 0.8 };
const CARD_NP: Record<string, number> = { arts: 3, buster: 0, quick: 1 };
const isCardTrait = (id: number) => id >= 4001 && id <= 4008;
const NP_CARD_TRAIT = 4007;

interface Buff { t: string; val: number; turn: number; count: number; d: BuffDef }
interface Actor {
  cfg: ActorCfg; gauge: number; buffs: Buff[]; cd: number[]; fired: boolean;
  /** 영구수면 등으로 더는 행동할 수 없다 */
  disabled?: boolean;
  /** 어펜드 스킬 5: 남은 횟수와, 이미 쿨타임 감소를 받은 스킬 */
  reload: number; reloaded: boolean[];
}
interface Enemy { def: EnemyDef; bars: number[]; buffs: Buff[]; dead: boolean; summoned?: boolean }
interface State {
  actors: Actor[]; /** 후열에서 대기 중인 서번트(앞에서부터 들어온다) */ bench: Actor[];
  field: Enemy[]; reserve: Enemy[]; wave: number; quest: QuestData;
  rel: Rel; roll: number; killed: number; broken: number;
  /** 마술예장 스킬을 쓰는 가상의 행동 주체(전투에는 참가하지 않는다) */
  master: Actor | null;
  cardNp: number;
  /** 전투 중 추가된 필드 특성(보구·스킬의 필드 변경). turn은 남은 턴 */
  fieldAdd: { trait: number; turn: number }[];
  /** 이번 계산에서 쓴 스킬 수(같은 턴에 쿨타임이 풀린 스킬을 다시 쓰는지 판단) */
  used: number;
  /** 이번 웨이브를 맡고 나면 더 쓸 일이 없는 딜러. 행동 불능이 되는 스킬(꿈의 끝)을 써도 된다. */
  expend: Actor | null;
  /** 웨이브 분담 중 주 딜러가 아닌 딜러의 차례를 준비하고 있는가 */
  expendPhase?: boolean;
  /** 필드 특성을 주는 버프가 한 번이라도 걸렸는가 */
  fieldBuff?: boolean;
}

export interface SimExtra {
  /** 마술예장 스킬(없으면 미사용) */
  mc?: Skill[] | null;
  /** 보구를 쓰지 않은 턴에 평타로 얻는다고 가정하는 NP (10000 = 100%) */
  cardNp?: number;
}
export type SimMode = 'lazy' | 'eager' | 'relay';
export interface SimOptions extends SimExtra { maxTurns: number; roll: number; mode: SimMode }

const pickLv = (sv: Sv | Sv[], idx: number): Sv => (Array.isArray(sv) ? sv[Math.min(idx, sv.length - 1)] : sv);
/** 레벨(스킬·보구)과 오버차지 단계에 맞는 수치 */
const svAt = (fn: Fn, idx: number, oc = 1): Sv => pickLv(oc > 1 && fn.oc ? fn.oc[Math.min(oc, 5) - 2] : fn.sv, idx);
// 특성은 전투 중 바뀔 수 있다: 특성 부여 버프(addIndividuality), 필드 특성 부여
const withAdded = (base: number[], buffs: Buff[]) => (buffs.some((b) => b.t === 'addIndividuality') ? [...base, ...buffs.filter((b) => b.t === 'addIndividuality').map((b) => b.val)] : base);
const actorTraits = (a: Actor) => withAdded(a.cfg.svt.traits, a.buffs);
const enemyTraits = (e: Enemy) => withAdded(e.def.traits, e.buffs);
function fieldTraits(s: State): number[] {
  // 대부분의 전투는 필드가 바뀌지 않는다: 그때는 목록을 새로 만들지 않는다
  if (!s.fieldAdd.length && !s.fieldBuff) return s.quest.fieldTraits;
  const out = s.quest.fieldTraits.slice();
  for (const f of s.fieldAdd) out.push(f.trait);
  for (const a of s.actors) for (const b of a.buffs) if (b.t === 'fieldIndividuality') out.push(b.val);
  return out;
}
/** 대상이 가진 특성·상태 중 목록에 해당하는 것의 수(중첩 특공, NP 충전량 계산용) */
const countIndiv = (traits: number[], buffs: Buff[], list: number[]) =>
  list.filter((t) => traits.includes(t)).length + buffs.filter((b) => b.d.v?.some((x) => list.includes(x))).length;
const hasAny = (list: number[] | undefined, set: number[]) => !list || !list.length || list.some((x) => set.includes(x));

// 전투 기록에 쓰는 이름. 프렌드는 '(프렌드)'를 붙이고, 이름이 같은 다른 서번트가 함께 있으면 클래스로 구분한다.
const labels = new WeakMap<ActorCfg, string>();
const nameOf = (a: Actor) => labels.get(a.cfg) ?? a.cfg.svt.name;
const CLASS_LABEL: Record<string, string> = {
  saber: '세이버', archer: '아처', lancer: '랜서', rider: '라이더', caster: '캐스터', assassin: '어새신', berserker: '버서커',
  shielder: '실더', ruler: '룰러', avenger: '어벤저', alterEgo: '얼터에고', moonCancer: '문캔서', foreigner: '포리너', pretender: '프리텐더', beast: '비스트',
};
function setLabels(lineup: ActorCfg[]) {
  for (const c of lineup) {
    const twins = lineup.filter((x) => x !== c && x.svt.name === c.svt.name);
    let label = c.svt.name;
    // 이름만 같은 다른 서번트(예: 세이버와 랜서 알트리아)는 클래스를 붙인다
    if (twins.some((x) => x.svt.no !== c.svt.no)) label += `[${CLASS_LABEL[c.svt.cls] ?? c.svt.cls}]`;
    if (c.friend) label += '(프렌드)';
    labels.set(c, label);
  }
}

const cloneActor = (a: Actor): Actor => ({ cfg: a.cfg, gauge: a.gauge, cd: a.cd.slice(), fired: a.fired, disabled: a.disabled, reload: a.reload, reloaded: a.reloaded.slice(), buffs: a.buffs.map((b) => ({ ...b })) });

function cloneState(s: State): State {
  return {
    ...s,
    actors: s.actors.map(cloneActor),
    bench: s.bench.map(cloneActor),
    master: s.master && { ...s.master, cd: s.master.cd.slice(), buffs: [] },
    fieldAdd: s.fieldAdd.map((f) => ({ ...f })),
    expend: null,
    field: s.field.map((e) => ({ def: e.def, bars: e.bars.slice(), dead: e.dead, summoned: e.summoned, buffs: e.buffs.map((b) => ({ ...b })) })),
    reserve: s.reserve.map((e) => ({ def: e.def, bars: e.bars.slice(), dead: e.dead, buffs: [] })),
  };
}

/** 적이 처음부터 가지고 있는 패시브 버프 */
const passiveBuffs = (def: EnemyDef): Buff[] => (def.passive ?? []).map((p) => ({ t: p.t, val: p.val, turn: p.turn, count: p.count, d: { t: p.t, cs: p.cs, co: p.co } }));

function loadWave(s: State) {
  const defs = s.quest.waves[s.wave].slice().sort((a, b) => a.deckId - b.deckId);
  const all = defs.map((def) => ({ def, bars: def.bars.slice(), buffs: passiveBuffs(def), dead: false }));
  s.field = all.slice(0, 3);
  s.reserve = all.slice(3);
  summon(s, false); // 웨이브 시작 시 소환(자기 증원 목록을 가진 적만)
}

/**
 * 증원 소환. 적 AI는 필드에 빈자리가 있으면 소환 스킬을 쓰며, 같은 증원을 몇 번이고 다시 부른다.
 * 자기 목록(def.call)을 가진 적은 그 적이 살아 있을 때, 웨이브 공통 목록은 적이 하나라도 남아 있을 때 소환된다.
 */
function summon(s: State, withStage: boolean) {
  const add = (def: EnemyDef) => { if (s.field.length < 3) s.field.push({ def, bars: def.bars.slice(), buffs: passiveBuffs(def), dead: false, summoned: true }); };
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
function applyFn(s: State, user: Actor, fn: Fn, lvIdx: number, ally: Actor | undefined, oc = 1) {
  const sv = svAt(fn, lvIdx, oc);
  if (sv.Rate !== undefined && sv.Rate < 1000) return; // 확률 효과는 실패로 가정
  const field = fieldTraits(s);
  if (fn.qtv?.length && !fn.qtv.some((t) => field.includes(t))) return;
  if (fn.t === 'addFieldChangeToField') { for (const t of sv.FieldIndividuality ?? []) s.fieldAdd.push({ trait: t, turn: sv.Turn ?? -1 }); return; }
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
  const v = sv.Value ?? 0;
  // 특성·상태의 수에 비례하는 NP 충전: tv는 대상 조건이 아니라 세는 특성 목록이다
  if (fn.t === 'gainNpBuffIndividualSum' || fn.t === 'gainNpIndividualSum' || fn.t === 'gainNpTargetSum') {
    const list = fn.tv ?? [];
    for (const a of allies) {
      let n: number;
      if (fn.t === 'gainNpBuffIndividualSum') n = a.buffs.filter((b) => b.d.v?.some((x) => list.includes(x))).length;
      else {
        // Value2: 세는 대상 (0 본인, 1 아군 전체, 2 적 전체, 3 전원, 4 본인 제외 전원)
        const kind = sv.Value2 ?? 0;
        const al = kind === 0 ? [a] : kind === 2 ? [] : s.actors.filter((x) => kind !== 4 || x !== a);
        const en = kind === 0 || kind === 1 ? [] : alive(s);
        n = al.reduce((c, x) => c + countIndiv(actorTraits(x), x.buffs, list), 0) + en.reduce((c, e) => c + countIndiv(enemyTraits(e), e.buffs, list), 0);
      }
      a.gauge = Math.min(30000, a.gauge + v * n);
    }
    return;
  }
  if (fn.tv?.length) {
    allies = allies.filter((a) => fn.tv!.some((t) => actorTraits(a).includes(t)));
    enemies = enemies.filter((e) => fn.tv!.some((t) => enemyTraits(e).includes(t)));
  }
  if (fn.t === 'gainMultiplyNp') { for (const a of allies) a.gauge = Math.min(30000, a.gauge + Math.floor((a.gauge * v) / 1000)); return; }
  // 다른 아군의 NP를 줄이고, 줄어든 만큼 자신이 얻는다
  if (fn.t === 'absorbNp') { let got = 0; for (const a of allies) { const d = Math.min(a.gauge, v); a.gauge -= d; got += d; } user.gauge = Math.min(30000, user.gauge + got); return; }
  if (fn.t === 'gainNp') for (const a of allies) a.gauge = Math.min(30000, a.gauge + v);
  else if (fn.t === 'lossNp') for (const a of allies) a.gauge = Math.max(0, a.gauge - v);
  // 쿨타임 단축: Value2가 있으면 그 번호의 스킬만 줄인다(예: 토네리코 보구는 3스킬만)
  else if (fn.t === 'shortenSkill') for (const a of allies) a.cd = a.cd.map((c, i) => (sv.Value2 && sv.Value2 - 1 !== i ? c : Math.max(0, c - v)));
  else if (fn.b) {
    for (const d of fn.b) {
      const mk = (): Buff => ({ t: d.t, val: v, turn: sv.Turn ?? -1, count: sv.Count ?? -1, d });
      if (d.t === 'fieldIndividuality') s.fieldBuff = true;
      // 특성 조건이 붙은 버프는 보유자나 필드가 그 특성을 가질 때만 건다
      const ok = (a: Actor) => !d.si?.length || d.si.some((t) => actorTraits(a).includes(t) || field.includes(t));
      for (const a of allies) if (ok(a)) a.buffs.push(mk());
      for (const e of enemies) e.buffs.push(mk());
    }
  }
}

/** 공격자 쪽 버프가 이번 보구 공격에 적용되는지 */
function attackerBuffApplies(b: Buff, attTraits: number[], card: string, defTraits: number[]): boolean {
  const cs = b.d.cs;
  if (cs?.length) {
    const cardIds = cs.filter(isCardTrait);
    const other = cs.filter((x) => !isCardTrait(x));
    if (cardIds.length && !cardIds.includes(CARD_TRAIT[card]) && !cardIds.includes(NP_CARD_TRAIT)) return false;
    if (other.length && !other.some((x) => attTraits.includes(x))) return false;
  }
  return hasAny(b.d.co, defTraits);
}
/** 적에게 걸린 디버프가 이번 보구 공격에 적용되는지 */
function defenderBuffApplies(b: Buff, attTraits: number[], card: string): boolean {
  const all = [...(b.d.cs || []), ...(b.d.co || [])];
  const cardIds = all.filter(isCardTrait);
  if (cardIds.length && !cardIds.includes(CARD_TRAIT[card])) return false;
  const other = (b.d.co || []).filter((x) => !isCardTrait(x));
  return !other.length || other.some((x) => attTraits.includes(x));
}

interface Mods { card: number; atk: number; power: number; np: number; gain: number; add: number }
function mods(att: Actor, e: Enemy, card: string, pierceDef = false): Mods {
  const m: Mods = { card: 0, atk: 0, power: 0, np: 0, gain: 0, add: 0 };
  const rates = att.buffs.filter((b) => b.t === 'buffRate');
  const aT = actorTraits(att), eT = enemyTraits(e);
  const ignoreDef = pierceDef || att.buffs.some((b) => b.t === 'pierceDefence');
  for (const b of att.buffs) {
    // 상태 특공: 대상에게 그 상태(버프·디버프)가 걸려 있을 때만
    if (b.t === 'upDamageIndividualityActiveonly') {
      if (b.d.co?.length && e.buffs.some((x) => x.d.v?.some((t) => b.d.co!.includes(t)))) m.power += b.val / 1000;
      continue;
    }
    if (!attackerBuffApplies(b, aT, card, eT)) continue;
    const v = b.val / 1000;
    switch (b.t) {
      case 'upDamageIndividuality': m.power += v; break;
      case 'upCommandall': m.card += v; break;
      case 'downCommandall': m.card -= v; break;
      case 'upAtk': m.atk += v; break;
      case 'downAtk': m.atk -= v; break;
      case 'upDamage': m.power += v; break;
      case 'upNpdamage': {
        // 보구 위력 UP 부스트(오베론의 꿈의 끝)는 중복되지 않는다: 가장 큰 것 하나만 적용
        let boost = 0;
        for (const r of rates) if (r.d.ur?.some((x) => b.d.v?.includes(x))) boost = Math.max(boost, r.val / 1000);
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
    if (!defenderBuffApplies(b, aT, card)) continue;
    const v = b.val / 1000;
    if (b.t === 'downDefence') m.atk += v;
    else if (b.t === 'upDefence') { if (!ignoreDef) m.atk -= v; }
    else if (b.t === 'downDefenceNpdamage') m.np += v;
    else if (b.t === 'upDefenceNpdamage') m.np -= v;
    else if (b.t === 'subSelfdamage') m.add -= b.val;
    else if (b.t === 'addSelfdamage') m.add += b.val;
    else if (b.t === 'downDefencecommandall') m.card += v;
  }
  return m;
}

/** 보구의 특공 배율 */
function superEffective(fn: Fn, sv: Sv, e: Enemy, att: Actor): number {
  const eT = enemyTraits(e);
  const corr = (sv.Correction ?? 1000) / 1000;
  switch (fn.t) {
    case 'damageNpIndividual':
      return sv.Target !== undefined && eT.includes(sv.Target) ? corr : 1;
    case 'damageNpIndividualSum': {
      // 중첩 특공: 대상(Target 1) 또는 자신(0)이 가진 해당 특성·상태의 수만큼 배율이 오른다
      const list = sv.TargetList ?? [];
      let n = sv.Target === 1 ? countIndiv(eT, e.buffs, list) : countIndiv(actorTraits(att), att.buffs, list);
      if (n <= 0) return 1;
      if (sv.ParamAddMaxCount) n = Math.min(n, sv.ParamAddMaxCount);
      return ((sv.Value2 ?? 1000) + n * (sv.Correction ?? 0)) / 1000;
    }
    case 'damageNpStateIndividualFix': // 대상에게 해당 상태가 걸려 있을 때
      return sv.Target !== undefined && e.buffs.some((b) => b.d.v?.includes(sv.Target!)) ? corr : 1;
    case 'damageNpRare':
      return e.def.rarity !== undefined && sv.TargetRarityList?.includes(e.def.rarity) ? corr : 1;
    case 'damageNpAndOrCheckIndividuality':
      return sv.AndCheckIndividualityList?.length && sv.AndCheckIndividualityList.every((t) => eT.includes(t)) ? corr : 1;
    default:
      return 1; // HP 비례(피해를 받지 않으므로 기본 배율), 배틀 포인트 등
  }
}

const CONSUMED = new Set(['upCommandall', 'upAtk', 'upDamage', 'upNpdamage', 'upDropnp', 'addDamage', 'buffRate', 'upChagetd', 'upDamageIndividuality', 'upDamageIndividualityActiveonly']);

/** chain: 이번 턴에 앞서 쏜 보구의 수. 보구를 이어 쏘면 뒤의 것일수록 오버차지가 1단계씩 오른다. */
function fireNp(s: State, a: Actor, log?: TurnLog, chain = 0) {
  const np = a.cfg.svt.np!;
  // 오버차지: NP 100%마다 1단계(최대 3) + 보구 연계 순서 + 오버차지 UP 버프, 최대 5단계
  const oc = Math.max(1, Math.min(5, Math.min(3, Math.floor(a.gauge / 10000)) + chain + a.buffs.reduce((n, b) => n + (b.t === 'upChagetd' ? b.val : 0), 0)));
  const entry = { who: nameOf(a), np: np.name, hits: [] as TurnLog['nps'][0]['hits'], refund: 0 };
  let refund = 0;
  a.gauge = 0;
  a.fired = true;
  const leaving: Actor[] = []; // 이 보구로 퇴장하는 아군
  const pierce = a.buffs.some((b) => b.t === 'pierceInvincible');
  const sureHit = a.buffs.some((b) => b.t === 'breakAvoidance');
  for (const fn of np.fn) {
    if (fn.t === 'forceInstantDeath') {
      // 자신이 죽거나(아라쉬 등), 선두의 다른 아군 1기를 제물로 쓴다(진궁). 영구수면 상태의 아군은 제물이 될 수 없다.
      const victim = fn.tg === 'self' ? a : s.actors.find((x) => x !== a && !x.disabled);
      if (victim && !leaving.includes(victim)) leaving.push(victim);
      continue;
    }
    if (!fn.t.startsWith('damageNp')) { applyFn(s, a, fn, a.cfg.npLv - 1, a, oc); continue; }
    const sv = svAt(fn, a.cfg.npLv - 1, oc);
    if (!sv.Value) continue; // 오버차지 단계가 올라야 생기는 추가 공격
    const targets = fn.tg === 'enemyAll' ? s.field.slice() : (() => { const e = pickEnemy(s); return e ? [e] : []; })();
    for (const e of targets) {
      const m = mods(a, e, np.card, fn.t === 'damageNpPierce');
      const svt = a.cfg.svt;
      const classAtk = (s.rel.classAttack[svt.cls] ?? 1000) / 1000;
      const affinity = (s.rel.classRelation[svt.cls]?.[e.def.cls] ?? 1000) / 1000;
      const attr = (s.rel.attribute[svt.attr]?.[e.def.attr] ?? 1000) / 1000;
      // 무적 상태의 적에게는 대미지가 들어가지 않는다(오베론 보구에 맞은 적은 그 턴 동안 무적)
      const blocked = !pierce && e.buffs.some((b) => b.t === 'invincible' || (b.t === 'avoidance' && !sureHit));
      const dmg = blocked ? 0 : Math.max(0, Math.floor(
        a.cfg.atk * ((sv.Value ?? 0) / 1000) * CARD_DMG[np.card] * Math.max(0, 1 + m.card) * classAtk * affinity * attr * 0.23 *
        Math.max(0, 1 + m.atk) * Math.max(0.001, 1 + m.power + m.np) * superEffective(fn, sv, e, a) * s.roll,
      ) + m.add);
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
  for (const v of leaving) leave(s, v, log);
}

/** 전열에서 퇴장시키고 후열 선두를 그 자리에 들인다. 들어온 서번트는 다음 턴부터 행동한다. */
function leave(s: State, a: Actor, log?: TurnLog) {
  const i = s.actors.indexOf(a);
  if (i < 0) return;
  const next = s.bench.shift();
  if (next) s.actors[i] = next; else s.actors.splice(i, 1);
  if (log) (log.events ??= []).push(next ? `${nameOf(a)} 퇴장 → ${nameOf(next)} 등장` : `${nameOf(a)} 퇴장`);
}

/** 적에게 무적을 거는 보구(오베론)는 같은 턴의 다른 보구를 막으므로 맨 뒤에 쏜다 */
const blocksLater = (a: Actor) => a.cfg.svt.np!.fn.some((f) => f.tg.startsWith('enemy') && f.b?.some((b) => b.t === 'invincible'));

const dealers = (s: State) => s.actors.filter((a) => a.cfg.role === 'dealer' && a.cfg.svt.np?.dmg && !a.disabled);

/** 준비된 딜러의 보구를 차례로 발동한다. 필드가 비면 남은 보구는 아낀다. */
function npPhase(s: State, log?: TurnLog) {
  const order = dealers(s).sort((x, y) => Number(blocksLater(x)) - Number(blocksLater(y)));
  let chain = 0;
  for (const a of order) {
    // 앞선 보구의 제물이 되어 이미 퇴장했을 수 있다
    if (!s.actors.includes(a) || a.gauge < 10000 || !alive(s).length) continue;
    fireNp(s, a, log, chain++);
  }
}
function wouldClear(s: State): boolean {
  const c = cloneState(s);
  npPhase(c);
  return !alive(c).length;
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
const BUFFLIKE = new Set(['shortenSkill', 'addFieldChangeToField']);
const hasBuff = (r: SkillRef) => skillFns(r).some((f) => f.b || BUFFLIKE.has(f.t));
const CHARGE = new Set(['gainNp', 'gainNpBuffIndividualSum', 'gainNpIndividualSum', 'gainNpTargetSum', 'gainMultiplyNp', 'absorbNp']);
const shortens = (r: SkillRef) => skillFns(r).some((f) => f.t === 'shortenSkill');
const hasCharge = (r: SkillRef) => skillFns(r).some((f) => CHARGE.has(f.t));

function available(s: State): SkillRef[] {
  const out: SkillRef[] = [];
  // 앞 웨이브를 다른 딜러에게 맡길 때는 마술예장 스킬을 아껴 둔다(주 딜러의 마지막 웨이브에 쓴다)
  for (const a of s.master && !s.expendPhase ? [...s.actors, s.master] : s.actors) {
    if (a.disabled) continue;
    a.cfg.svt.skills.forEach((sk, i) => {
      if (a.cd[i] !== 0) return;
      const lv = a.cfg.skillLvs?.[i] ?? a.cfg.skillLv;
      const need = sk.needNp?.[Math.min(lv, sk.needNp.length) - 1] ?? 0; // NP가 모자라면 쓸 수 없는 스킬
      if (need && a.gauge < need * 100) return;
      out.push({ a, i });
    });
  }
  return out;
}
function useSkill(s: State, r: SkillRef, target: Actor, log?: TurnLog) {
  const sk = r.a.cfg.svt.skills[r.i];
  const lv = skillLvOf(r);
  for (const fn of sk.fn) applyFn(s, r.a, fn, lv - 1, target);
  r.a.cd[r.i] = sk.cd[Math.min(lv, sk.cd.length) - 1];
  // 어펜드 스킬 5(스킬 재장전): 스킬마다 처음 쓸 때 쿨타임 1 감소
  if (r.a.reload > 0 && !r.a.reloaded[r.i]) { r.a.cd[r.i] = Math.max(0, r.a.cd[r.i] - 1); r.a.reload--; r.a.reloaded[r.i] = true; }
  s.used++;
  const needsTarget = sk.fn.some((f) => f.tg === 'ptOne');
  log?.skills.push({ who: nameOf(r.a), skill: sk.name, target: needsTarget ? nameOf(target) : undefined });
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

/**
 * 대상을 턴 종료 후 행동 불능으로 만드는 스킬(오베론의 꿈의 끝)을 지금 써도 되는가.
 * 마지막 웨이브이거나, 대상이 어차피 이번 보구로 퇴장하는 서번트일 때만 쓴다.
 */
function finOk(s: State, r: SkillRef, target: Actor): boolean {
  if (!r.a.cfg.svt.skills[r.i].fin) return true;
  return s.wave >= s.quest.waves.length - 1 || target.cfg.svt.np?.dies === 'self' || s.expend === target;
}

/**
 * 오더 체인지: 내보내기로 정한 서번트의 스킬을 모두 쓴 뒤 후열 선두와 바꾼다.
 * 들어온 서번트는 같은 턴에 바로 스킬을 쓸 수 있다.
 */
function orderChange(s: State, log: TurnLog) {
  const m = s.master;
  if (!m || !s.bench.length) return;
  const oc = m.cfg.svt.skills.findIndex((sk) => sk.fn.some((f) => f.t === 'replaceMember'));
  if (oc < 0 || m.cd[oc] !== 0) return;
  const out = s.actors.find((a) => a.cfg.swapOut && !a.disabled);
  if (!out) return;
  const target = dealers(s)[0] ?? s.actors.find((a) => a !== out) ?? out;
  for (const r of available(s)) if (r.a === out && finOk(s, r, target) && r.a.cfg.svt.skills[r.i].fn.length) useSkill(s, r, target, log);
  const next = s.bench.shift()!;
  s.actors[s.actors.indexOf(out)] = next;
  s.bench.push(out);
  const sk = m.cfg.svt.skills[oc];
  m.cd[oc] = sk.cd[Math.min(10, sk.cd.length) - 1];
  (log.events ??= []).push(`오더 체인지: ${nameOf(out)}의 스킬을 쓴 뒤 ${nameOf(next)}와(과) 교체`);
}

/** 스킬이 대상 c에게 쓸모가 있는가: 남의 자기 전용 스킬은 c에게 아무 효과가 없다 */
const helps = (r: SkillRef, c: Actor) => r.a === c || skillFns(r).some((f) => f.tg !== 'self');

/** c 혼자 보구를 쏴서 지금 필드를 비울 수 있는가 */
function clearsAlone(s: State, i: number): boolean {
  const c = cloneState(s);
  if (c.actors[i].gauge < 10000) return false;
  fireNp(c, c.actors[i]);
  return !alive(c).length;
}
/** i번 딜러 혼자 이번 웨이브를 정리하도록 NP를 채우고, 모자라면 버프를 하나씩 건다. 성공 여부를 돌려준다. */
function prepareSolo(s: State, i: number, expendable: boolean, log?: TurnLog): boolean {
  const c = s.actors[i];
  s.expend = expendable ? c : null;
  s.expendPhase = true;
  if (!ensureCharge(s, c, log)) { s.expend = null; s.expendPhase = false; return false; }
  for (let pass = 0; pass < 2 && !clearsAlone(s, i); pass++) {
    // 행동 불능을 부르는 스킬은 맨 마지막에, NP 충전이 딸린 버프는 그 앞에 쓴다(충전은 뒤 웨이브에도 쓸모가 있다)
    const list = available(s).filter((r) => hasBuff(r) && helps(r, c) && finOk(s, r, c))
      .sort((x, y) => Number(!!x.a.cfg.svt.skills[x.i].fin) - Number(!!y.a.cfg.svt.skills[y.i].fin) || Number(hasCharge(x)) - Number(hasCharge(y)) || Number(y.a === c) - Number(x.a === c));
    for (const r of list) { if (clearsAlone(s, i)) break; useSkill(s, r, c, log); }
  }
  const ok = clearsAlone(s, i);
  s.expend = null;
  s.expendPhase = false;
  return ok;
}
/**
 * 웨이브 분담: 마지막 웨이브가 아니면 주 딜러를 아끼고, 다른 딜러 중 스킬을 가장 적게 쓰고 정리할 수 있는 쪽이 보구를 쏜다.
 * 누구도 혼자 정리하지 못하면 false를 돌려주고 평소 운용으로 넘어간다.
 */
function playRelay(s: State, log: TurnLog): boolean {
  const lastWave = s.quest.waves.length - 1;
  const main = s.actors.find((a) => a.cfg.main && !a.disabled);
  if (!main || s.wave >= lastWave) return false;
  // 다음이 마지막 웨이브면 이번에 쏘는 딜러는 더 쓸 일이 없다
  const expendable = s.wave === lastWave - 1;
  let best = -1, bestCost = Infinity;
  for (const d of dealers(s)) {
    if (d === main) continue;
    const i = s.actors.indexOf(d);
    const c = cloneState(s);
    if (!prepareSolo(c, i, expendable)) continue;
    // 스킬을 같은 만큼 쓴다면 약한 쪽이 먼저 쏜다: 앞 웨이브일수록 적이 약하므로 강한 쪽을 뒤 웨이브에 남긴다
    const cost = (c.used - s.used) * 1e6 + d.cfg.atk;
    if (cost < bestCost) { bestCost = cost; best = i; }
  }
  if (best < 0) return false;
  prepareSolo(s, best, expendable, log);
  fireNp(s, s.actors[best], log);
  return true;
}

function playTurn(s: State, mode: SimMode, log: TurnLog) {
  orderChange(s, log);
  if (mode === 'relay') {
    if (playRelay(s, log)) return;
    mode = 'eager'; // 마지막 웨이브(또는 분담 실패)는 버프를 몰아 쓴다
  }
  const ds = dealers(s).sort((x, y) => Number(!!y.cfg.main) - Number(!!x.cfg.main));
  if (!ds.length) return;
  const main = ds.find((d) => reachable(s, d));
  const order = (list: SkillRef[], d: Actor) =>
    // 쿨타임 단축 스킬은 다른 스킬을 쓴 뒤에 써야 효과가 있으므로 맨 뒤로 보낸다
    list.filter((r) => finOk(s, r, d)).sort((x, y) => Number(shortens(x)) - Number(shortens(y)) || Number(hasCharge(x)) - Number(hasCharge(y)) || Number(y.a === d) - Number(x.a === d));
  if (mode === 'eager' && main) {
    for (const r of order(available(s).filter((r) => hasBuff(r) && !hasCharge(r) && !shortens(r)), main)) useSkill(s, r, main, log);
  }
  // 쿨타임 단축으로 같은 턴에 다시 쓸 수 있게 된 스킬이 있으면 한 번 더 돈다
  for (let pass = 0; pass < 3; pass++) {
    const before = s.used;
    for (const d of ds) {
      if (wouldClear(s)) break;
      ensureCharge(s, d, log);
    }
    const ready = ds.find((d) => d.gauge >= 10000);
    if (ready) {
      for (const r of order(available(s).filter(hasBuff), ready)) {
        if (wouldClear(s)) break;
        // 쿨타임 단축은 줄일 쿨타임이 있을 때만 쓴다
        if (shortens(r) && !skillFns(r).some((f) => f.b || f.t !== 'shortenSkill') && !ready.cd.some((c) => c > 0) && !s.actors.some((a) => a !== ready && a.cd.some((c) => c > 0))) continue;
        useSkill(s, r, ready, log);
      }
    }
    if (s.used === before) break;
  }
  npPhase(s, log);
}

function endTurn(s: State): boolean {
  if (s.master) s.master.cd = s.master.cd.map((c) => Math.max(0, c - 1));
  for (const a of s.actors) {
    if (!a.fired && s.cardNp) a.gauge = Math.min(30000, a.gauge + s.cardNp);
    a.fired = false;
    for (const b of a.buffs) if (b.t === 'regainNp') a.gauge = Math.min(30000, a.gauge + b.val);
    // 턴 종료 시 발동하는 효과: NP 증감, 강화 해제 + 행동 불능(오베론의 꿈의 끝)
    let clear = false;
    for (const b of a.buffs) {
      if (b.t !== 'turnEnd' || !b.d.te) continue;
      for (const fx of b.d.te) {
        if (fx.t === 'gainNp') a.gauge = Math.min(30000, a.gauge + (fx.v ?? 0));
        else if (fx.t === 'lossNp') a.gauge = Math.max(0, a.gauge - (fx.v ?? 0));
        else if (fx.t === 'clear') clear = true;
        else if (fx.t === 'disable') a.disabled = true;
      }
      if (b.count > 0) b.count--;
    }
    // 강화 해제: 패시브(무기한)만 남긴다
    if (clear) a.buffs = a.buffs.filter((b) => b.turn === -1 && b.count === -1 && b.t !== 'turnEnd');
    for (const b of a.buffs) if (b.turn > 0) b.turn--;
    a.buffs = a.buffs.filter((b) => b.turn !== 0 && b.count !== 0);
    a.cd = a.cd.map((c) => Math.max(0, c - 1));
  }
  for (const a of s.bench) a.cd = a.cd.map((c) => Math.max(0, c - 1));
  for (const f of s.fieldAdd) if (f.turn > 0) f.turn--;
  s.fieldAdd = s.fieldAdd.filter((f) => f.turn !== 0);
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
  const svt = { id: 0, no: 0, name: '마스터', cls: '', rarity: 0, cost: 0, attr: '', traits: [], atk: { 1: 0, max: 0, 100: 0, 120: 0 }, skills, np: null, passive: [], face: '' } as Servant;
  return { cfg: { svt, npLv: 1, skillLv: 10, atk: 0, startNp: 0, role: 'master' }, gauge: 0, buffs: [], cd: skills.map(() => 0), fired: false, reload: 0, reloaded: [] };
}

// 선쿨타임이 있는 스킬은 그만큼 기다려야 쓸 수 있다
const mkActor = (cfg: ActorCfg): Actor => ({
  cfg, gauge: cfg.startNp, buffs: [], fired: false, reload: cfg.reload ?? 0, reloaded: [],
  cd: cfg.svt.skills.map((sk, i) => { const lv = cfg.skillLvs?.[i] ?? cfg.skillLv; return sk.init?.[Math.min(lv, sk.init.length) - 1] ?? 0; }),
});

/** front: 편성 전체. bench 표시가 있는 서번트는 후열에서 시작한다. */
export function simulate(front: ActorCfg[], quest: QuestData, rel: Rel, opt: SimOptions): SimResult {
  const s: State = {
    actors: front.filter((c) => !c.bench).map(mkActor),
    bench: front.filter((c) => c.bench).map(mkActor),
    field: [], reserve: [], wave: 0, quest, rel, roll: opt.roll, killed: 0, broken: 0,
    master: opt.mc?.length ? masterActor(opt.mc) : null, cardNp: opt.cardNp ?? 0, fieldAdd: [], used: 0, expend: null,
  };
  setLabels(front);
  for (const a of [...s.actors, ...s.bench]) for (const fn of a.cfg.svt.passive) applyFn(s, a, fn, 0, a);
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
  const better = (x: SimResult, y: SimResult) => (x.cleared !== y.cleared ? (x.cleared ? x : y) : x.cleared ? (y.turns < x.turns ? y : x) : y.broken > x.broken ? y : x);
  let best = better(a, b);
  // 웨이브 분담: 주 딜러가 정해져 있고 보구를 쏠 수 있는 서번트가 둘 이상이며 웨이브가 여럿일 때
  if (!(best.cleared && best.turns <= quest.waves.length) && quest.waves.length > 1 && front.some((f) => f.main) && front.filter((f) => f.role === 'dealer').length > 1) {
    best = better(best, simulate(front, quest, rel, { ...extra, maxTurns, roll, mode: 'relay' }));
  }
  return best;
}
