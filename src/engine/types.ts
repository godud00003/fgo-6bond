export interface Sv {
  Rate?: number; Turn?: number; Count?: number; Value?: number; Value2?: number;
  Correction?: number; Target?: number; TargetRarityList?: number[];
}
export interface BuffDef { t: string; cs?: number[]; co?: number[]; v?: number[]; ur?: number[] }
export interface Fn { t: string; tg: string; sv: Sv | Sv[]; tv?: number[]; qtv?: number[]; b?: BuffDef[] }
export interface Skill { name: string; cd: number[]; fn: Fn[] }
export type Card = 'arts' | 'buster' | 'quick';
export interface NP { name: string; card: Card; gain: number; dist: number[]; fn: Fn[]; dmg: boolean; aoe: boolean }
export interface Servant {
  id: number; no: number; name: string; cls: string; rarity: number; cost: number; attr: string;
  traits: number[]; atk: { 1: number; max: number; 100: number; 120: number };
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
  id: number; type: 'main' | 'free'; name: string; spot: string; chapter: number; sub: number;
  subStr: string; phases: number[]; noBattle: number[]; ap: number; lv: string;
}
export interface War { id: number; name: string; longName: string; quests: QuestRef[] }
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
}

/** 마술예장. 스킬은 서번트 스킬과 같은 형식이며 레벨 10 기준으로 쓴다. */
export interface MysticCode { id: number; name: string; skills: Skill[] }

export interface EnemyDef {
  name: string; cls: string; attr: string; traits: number[]; bars: number[]; tdRate: number; deckId: number;
  /** 이 적이 살아 있는 동안 빈자리에 불러내는 증원(순서대로, 반복 소환) */
  call?: EnemyDef[];
}
export interface QuestData {
  id: number; phase: number; name: string; bond: number; ap: number;
  fieldTraits: number[]; waves: EnemyDef[][]; warnings: string[];
  /** 웨이브별 증원 목록: 특정 적이 아니라 필드에 적이 하나라도 남아 있으면 빈자리에 소환된다 */
  waveCalls?: EnemyDef[][];
}

export interface TurnLog {
  turn: number; wave: number;
  skills: { who: string; skill: string; target?: string }[];
  nps: { who: string; np: string; hits: { enemy: string; dmg: number; hp: number; kill: boolean }[]; refund: number }[];
}
export interface SimResult {
  cleared: boolean; turns: number; killed: number; total: number; log: TurnLog[];
  /** 깎아 낸 HP 게이지 수 / 전체 게이지 수(브레이크 포함) */
  broken: number; bars: number;
}
