export interface Sv {
  Rate?: number; Turn?: number; Count?: number; Value?: number; Value2?: number;
  Correction?: number; Target?: number; TargetRarityList?: number[];
  TargetList?: number[]; ParamAddMaxCount?: number; AndCheckIndividualityList?: number[]; FieldIndividuality?: number[];
}
/** 클래스 스코어 판 하나. sq: 칸 id → [종류(b 버스터·a 아츠·q 퀵 카드 위력, np 보구 위력), 천분율] */
export interface ClassBoard { id: number; name: string; cls: string[]; sq: Record<string, [string, number]> }
/** 클래스 이름 → [버스터, 아츠, 퀵 카드 위력, 보구 위력] 천분율 */
export type ClassScore = Record<string, number[]>;
export interface BuffDef {
  t: string; cs?: number[]; co?: number[]; v?: number[]; ur?: number[];
  /** 보유자가 이 특성 중 하나(또는 필드 특성)를 가질 때만 걸리는 버프 */
  si?: number[];
  /** t가 'turnEnd'일 때: 턴 종료 시 보유자에게 일어나는 일 */
  te?: { t: 'lossNp' | 'gainNp' | 'clear' | 'disable'; v?: number }[];
}
export interface Fn {
  t: string; tg: string; sv: Sv | Sv[]; tv?: number[]; qtv?: number[]; b?: BuffDef[];
  /** 오버차지 2~5단계의 수치(보구만, 1단계와 다를 때만) */
  oc?: (Sv | Sv[])[];
}
export interface Skill {
  name: string; cd: number[]; fn: Fn[];
  /** 배틀 개시 시의 선쿨타임(레벨별) */
  init?: number[];
  /** 사용에 필요한 최소 NP(%, 레벨별) */
  needNp?: number[];
  /** 대상을 턴 종료 후 행동 불능으로 만드는 스킬. 마지막 웨이브나 곧 퇴장할 대상에게만 쓴다. */
  fin?: boolean;
}
export type Card = 'arts' | 'buster' | 'quick';
export interface NP {
  name: string; card: Card; gain: number; dist: number[]; fn: Fn[]; dmg: boolean; aoe: boolean;
  /** 보구 사용 후 퇴장: 'self' 자신이 죽는다, 'ally' 선두의 다른 아군 1기를 제물로 쓴다 */
  dies?: 'self' | 'ally';
}
export interface Servant {
  id: number; no: number; name: string; cls: string; rarity: number; cost: number; attr: string;
  traits: number[]; atk: { 1: number; max: number; 100: number; 120: number };
  /** 레벨별 ATK(색인 0 = Lv1). 예전 데이터에는 없을 수 있다. */
  growth?: number[];
  skills: Skill[]; np: NP | null; passive: Fn[]; face: string;
  /** 영기재림 단계(0~4)별 특성. 단계에 따라 특성이 달라지는 서번트에만 있다. traits는 4단계 기준. */
  asc?: number[][];
}
export interface BondCE {
  id: number; no: number; name: string; rarity: number; cost: number; kind: 'pct' | 'flat';
  val: [number, number]; cond: number[][]; sup: [number, number] | null; face: string;
  /** 최대 레벨일 때의 ATK */
  atk: number;
}
export interface QuestRef {
  id: number; type: 'main' | 'free' | 'rankup' | 'interlude'; name: string; spot: string; chapter: number; sub: number;
  subStr: string; phases: number[]; noBattle: number[]; ap: number; lv: string;
  /** 기간 한정(요일·이벤트) 퀘스트가 열리는 기간 [시작, 종료] (초). 없으면 상시. */
  open?: [number, number];
  /** 강화 퀘스트·막간의 이야기: 반드시 편성해야 하는 서번트(도감 번호) */
  svt?: number;
}
export interface War {
  id: number; name: string; longName: string; quests: QuestRef[];
  /** 한국 서버에 아직 열리지 않은 다음 이벤트(일본 서버 데이터). 값은 한국 서버 예상 개시 시각(초). */
  soon?: number;
}
export interface Rel {
  classRelation: Record<string, Record<string, number>>;
  classAttack: Record<string, number>;
  attribute: Record<string, Record<string, number>>;
}

/** 전투에 나서는 서번트 1기의 육성 상태 */
export interface ActorCfg {
  svt: Servant;
  npLv: number;       // 1~5
  skillLv: number;    // 1~10
  skillLvs?: number[]; // 스킬별 레벨(있으면 skillLv 대신 사용)
  atk: number;        // 성배·포우 포함 최종 ATK
  startNp: number;    // 시작 NP (10000 = 100%)
  role: 'dealer' | 'support' | 'filler' | 'master';
  friend?: boolean;
  /** 퀘스트가 지정한 서포트(NPC). friend와 함께 켜진다. 클래스 스코어가 적용되지 않는다. */
  npc?: boolean;
  /** 어펜드 스킬 5(스킬 재장전)의 남은 횟수: 스킬을 처음 쓸 때 쿨타임이 1 줄어든다(스킬마다 1회) */
  reload?: number;
  /** 후열에서 시작한다. 전열이 퇴장하거나 오더 체인지를 쓰면 들어온다. */
  bench?: boolean;
  /** 오더 체인지로 내보낼 서번트. 스킬을 다 쓴 뒤 후열 선두와 바꾼다. */
  swapOut?: boolean;
  /** 주 딜러: 마지막 웨이브를 맡는다. 다른 딜러(보구를 쏘는 서포터 포함)가 앞 웨이브를 나눠 맡는 운용에서 쓴다. */
  main?: boolean;
}

/** 마술예장. 스킬은 서번트 스킬과 같은 형식이며 레벨 10 기준으로 쓴다. */
export interface MysticCode { id: number; name: string; skills: Skill[]; /** 아이콘 이미지 주소 */ face?: string }

export interface EnemyDef {
  name: string; cls: string; attr: string; traits: number[]; bars: number[]; tdRate: number; deckId: number;
  /** 레어도(레어도 특공 판정용) */
  rarity?: number;
  /** 전투 시작부터 걸려 있는 패시브 중 받는 대미지에 영향을 주는 것(방어력, 대미지 컷, 회피 등) */
  passive?: { t: string; val: number; turn: number; count: number; cs?: number[]; co?: number[] }[];
  /** 이 적이 살아 있는 동안 빈자리에 불러내는 증원(순서대로, 반복 소환) */
  call?: EnemyDef[];
}
/** 퀘스트가 지정한 서포트(NPC): 프렌드 대신 반드시 이 서번트를 데려가야 한다. 예장은 없는 것으로 본다. */
export interface NpcSupport {
  /** 도감 데이터에 이 NPC의 스킬·보구를 덮어쓴 서번트(쓸 수 없는 스킬은 빠져 있다) */
  svt: Servant;
  lv: number; atk: number; npLv: number;
  /** svt.skills와 같은 순서의 스킬 레벨 */
  skillLvs: number[];
  /** 전열에 고정된다(편성 화면에서 후열로 옮길 수 없다). 전투 중 오더 체인지로는 뺄 수 있다. */
  front?: boolean;
  /** 한국어 이름을 아직 받지 못한 스킬(svt.skills의 색인 → 스킬 id)과 보구 id */
  jp?: { skills: [number, number][]; np?: number };
}
export interface QuestData {
  id: number; phase: number; name: string; bond: number; ap: number;
  fieldTraits: number[]; waves: EnemyDef[][]; warnings: string[];
  /** 웨이브별 증원 목록: 특정 적이 아니라 필드에 적이 하나라도 남아 있으면 빈자리에 소환된다 */
  waveCalls?: EnemyDef[][];
  /** 웨이브별 동시 등장 수(기본 3). 6마리가 한꺼번에 나오는 퀘스트에서만 들어 있다 */
  waveSize?: number[];
  /** 웨이브별 진입 금지 자리(1부터). 처음부터 비워 두는 자리로, 대기 중인 적도 이 자리로는 들어오지 않는다 */
  waveNoEntry?: number[][];
  /** 지정 서포트(NPC). 있으면 프렌드를 고를 수 없다. */
  npc?: NpcSupport;
  /** 내 파티에 넣을 수 없는 서번트(서번트 id) */
  ban?: number[];
  /** 내 파티에 반드시 넣어야 하는 서번트(서번트 id). 퀘스트에 편성 제한이 걸려 있을 때만 들어 있다. */
  must?: number[];
}

export interface TurnLog {
  turn: number; wave: number;
  skills: { who: string; skill: string; target?: string }[];
  nps: { who: string; np: string; hits: { enemy: string; dmg: number; hp: number; kill: boolean }[]; refund: number }[];
  /** 교체·퇴장 같은 사건 */
  events?: string[];
  /** 이 턴에 한 행동을 순서대로 적은 것(다시 재생하는 데 쓴다). 서번트는 편성 안의 자리 번호, 마스터는 -1. */
  ops?: Op[];
}
/** 스킬 사용 [s, 사용자, 스킬 번호, 대상] / 보구 [n, 사용자, 연계 순서] / 오더 체인지 교체 [x] */
export type Op = ['s', number, number, number] | ['n', number, number] | ['x'];
export interface SimResult {
  cleared: boolean; turns: number; killed: number; total: number; log: TurnLog[];
  /** 깎아 낸 HP 게이지 수 / 전체 게이지 수(브레이크 포함) */
  broken: number; bars: number;
}
