// 게임 로그인 응답(HTTPS 스니핑으로 얻는 JSON, Chaldea가 받는 것과 같은 형식)에서
// 보유 서번트·인연 예장·코스트 상한을 읽는다. 필요한 수치만 뽑고 원본은 보관하지 않는다.
import type { BondCE, ClassBoard, Servant } from './types.ts';

export interface RosterEntry {
  owned: boolean; npLv: number; lv: 'max' | '100' | '120'; skillLv: number; bondMax: boolean; bond15?: boolean;
  /** 게임에서 가져온 실제 ATK(포우 강화 포함). 있으면 레벨·포우 설정 대신 이 값을 쓴다. */
  atk?: number;
  /** 포우 ATK 강화량. 레벨 1 고정 퀘스트에서 레벨 1 ATK에 더한다. */
  fou?: number;
  /** 스킬 1~3의 레벨. 있으면 skillLv 대신 쓴다. */
  skills?: number[];
  /** 어펜드 스킬 5(스킬 재장전) 횟수: 스킬을 처음 쓸 때 쿨타임 1 감소(Lv1~5 1회, Lv6~9 2회, Lv10 3회). 없으면 조건 탭의 설정을 따른다. */
  reload?: number;
  /** 어펜드 스킬 2로 얻는 시작 NP (10000 = 100%). 없으면 조건 탭의 설정을 따른다. */
  startNp?: number;
  /** 편성 화면에 보이는 영기재림 단계(0~4). 단계별로 특성이 다른 서번트의 판정에 쓴다. */
  asc?: number;
  /** 표시용: 실제 레벨, 인연 레벨 */
  level?: number; bond?: number;
}
export type Roster = Record<number, RosterEntry>;
export type Stock = Record<number, { count: number; mlb: boolean; atk?: number }>;

export interface LoginImport {
  roster: Roster; stock: Stock; costCap: number | null;
  /** 클래스 스코어: 판 id → [버스터, 아츠, 퀵, 보구] 천분율. 파일에 없으면 null */
  score: Record<number, number[]> | null;
  servants: number; ceKinds: number; ceCopies: number; unknown: number;
}

// 어펜드 스킬 2(마력장전) 레벨별 시작 NP(%)
const APPEND2 = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20];

interface UserSvt {
  id: number; svtId: number; lv: number; atk: number; adjustAtk?: number; limitCount: number; dispLimitCount?: number;
  skillLv1: number; skillLv2: number; skillLv3: number; treasureDeviceLv1: number;
}

function parse(text: string): any {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* base64로 저장된 경우 */ }
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(decodeURIComponent(t)), (c) => c.charCodeAt(0))));
}

/** 판 하나에서 연 칸들의 합계: [버스터, 아츠, 퀵 카드 위력, 보구 위력] 천분율. ids를 주지 않으면 전부 연 것으로 본다. */
export function boardScore(board: ClassBoard, ids?: number[]): number[] {
  const out = [0, 0, 0, 0];
  const open = ids && new Set(ids.map(String));
  for (const [id, [kind, val]] of Object.entries(board.sq)) if (!open || open.has(id)) out['baq'.indexOf(kind) >= 0 ? 'baq'.indexOf(kind) : 3] += val;
  return out;
}

export function importLogin(text: string, servants: Servant[], ces: BondCE[], boards: ClassBoard[] = []): LoginImport {
  let json: any;
  try { json = parse(text); } catch { throw new Error('JSON 형식이 아닙니다. 게임 로그인 응답 파일이나 Chaldea 백업 파일인지 확인하세요.'); }
  // Chaldea 앱의 유저데이터 백업(chaldea-userdata-*.json)
  if (Array.isArray(json?.users) && json.users.length) return importChaldea(json, servants, ces, boards);
  const tables = json?.cache?.replaced ?? json?.replaced ?? json;
  const rows: UserSvt[] = [...(tables?.userSvt ?? []), ...(tables?.userSvtStorage ?? [])];
  if (!rows.length) throw new Error('보유 서번트 목록(userSvt)이 없습니다. 게임 로그인 응답 파일인지 확인하세요.');

  const collection = new Map<number, any>((tables.userSvtCollection ?? []).map((c: any) => [c.svtId, c]));
  const appendByUserSvt = new Map<number, number>();
  const append5ByUserSvt = new Map<number, number>();
  for (const a of tables.userSvtAppendPassiveSkillLv ?? []) {
    const i = (a.appendPassiveSkillNums ?? []).indexOf(101);
    if (i >= 0) appendByUserSvt.set(a.userSvtId, a.appendPassiveSkillLvs?.[i] ?? 0);
    // 어펜드 스킬 5(스킬 재장전)는 번호 104
    const k = (a.appendPassiveSkillNums ?? []).indexOf(104);
    if (k >= 0) append5ByUserSvt.set(a.userSvtId, a.appendPassiveSkillLvs?.[k] ?? 0);
  }

  const svtById = new Map(servants.map((s) => [s.id, s]));
  const ceById = new Map(ces.map((c) => [c.id, c]));
  const best = new Map<number, UserSvt>();
  const ceLimits = new Map<number, number[]>();
  const ceAtk = new Map<number, number>(); // 예장별 가장 높은 ATK(예장 레벨에 따라 다르다)
  let unknown = 0;
  // 같은 서번트가 여러 기면 가장 많이 키운 쪽을 쓴다
  const score = (u: UserSvt) => u.lv * 1000 + u.treasureDeviceLv1 * 100 + u.skillLv1 + u.skillLv2 + u.skillLv3;
  for (const u of rows) {
    const svt = svtById.get(u.svtId);
    if (svt) {
      const cur = best.get(svt.no);
      if (!cur || score(u) > score(cur)) best.set(svt.no, u);
    } else if (ceById.has(u.svtId)) {
      const ce = ceById.get(u.svtId)!;
      ceLimits.set(ce.no, [...(ceLimits.get(ce.no) ?? []), u.limitCount]);
      ceAtk.set(ce.no, Math.max(ceAtk.get(ce.no) ?? 0, u.atk ?? 0));
    } else unknown++;
  }

  const roster: Roster = {};
  for (const [no, u] of best) {
    const col = collection.get(u.svtId);
    const bond: number = col?.friendshipRank ?? 0;
    const bondCap = Math.min(15, 10 + (col?.friendshipExceedCount ?? 0));
    const appendLv = appendByUserSvt.get(u.id) ?? 0;
    roster[no] = {
      owned: true, npLv: Math.max(1, Math.min(5, u.treasureDeviceLv1)),
      lv: u.lv >= 120 ? '120' : u.lv >= 100 ? '100' : 'max',
      skillLv: Math.min(u.skillLv1, u.skillLv2, u.skillLv3), skills: [u.skillLv1, u.skillLv2, u.skillLv3],
      atk: u.atk, fou: (u.adjustAtk ?? 0) * 10, level: u.lv, bond,
      asc: u.dispLimitCount !== undefined && u.dispLimitCount >= 0 && u.dispLimitCount <= 4 ? u.dispLimitCount : undefined,
      startNp: appendLv > 0 ? APPEND2[Math.min(appendLv, 10) - 1] * 100 : 0,
      reload: ((lv) => (lv >= 10 ? 3 : lv >= 6 ? 2 : lv >= 1 ? 1 : 0))(append5ByUserSvt.get(u.id) ?? 0),
      bondMax: bond >= bondCap, bond15: bond >= 15,
    };
  }

  // 인연 예장: 최대해방본이 있으면 그 장수, 없으면 미해방 장수. 없는 예장은 0장.
  const stock: Stock = {};
  let ceCopies = 0;
  for (const ce of ces) {
    const limits = ceLimits.get(ce.no) ?? [];
    const mlb = limits.filter((l) => l >= 4).length;
    stock[ce.no] = { ...(mlb ? { count: mlb, mlb: true } : { count: limits.length, mlb: false }), atk: ceAtk.get(ce.no) ?? 0 };
    ceCopies += limits.length;
  }
  const costMax = tables.userGame?.[0]?.costMax;
  // 클래스 스코어: 판마다 강화한 칸 id 목록
  let classScore: LoginImport['score'] = null;
  if (Array.isArray(tables.userClassBoardSquare)) {
    classScore = {};
    for (const b of boards) {
      const row = tables.userClassBoardSquare.find((r: any) => r.classBoardBaseId === b.id);
      classScore[b.id] = boardScore(b, row?.classBoardSquareIds ?? []);
    }
  }
  return {
    score: classScore,
    roster, stock, costCap: typeof costMax === 'number' && costMax > 0 ? costMax : null,
    servants: best.size, ceKinds: ceLimits.size, ceCopies, unknown,
  };
}

// ---------------------------------------------------------------- Chaldea 유저데이터

// 재림 단계별 레벨 상한(★0은 ★2와 같다)
const ASC_CAP: Record<number, number[]> = {
  5: [50, 60, 70, 80, 90], 4: [40, 50, 60, 70, 80], 3: [30, 40, 50, 60, 70], 2: [25, 35, 45, 55, 65], 1: [20, 30, 40, 50, 60], 0: [25, 35, 45, 55, 65],
};
/** 성배를 n개 쓴 뒤의 레벨: 90까지는 5씩(★1·★2의 첫 단계는 70으로), 그 뒤로는 2씩, 최대 120 */
function grailLevel(maxLv: number, grails: number): number {
  let lv = maxLv;
  for (let i = 0; i < grails && lv < 120; i++) lv = lv < 70 ? 70 : lv < 90 ? lv + 5 : lv + 2;
  return lv;
}
/** 레벨에 맞는 ATK. 레벨별 표가 없는 예전 데이터에서는 Lv1·기본 최대·100·120 사이를 직선으로 잇는다(근사치). */
function atkAt(svt: Servant, lv: number, maxLv: number): number {
  if (svt.growth?.[lv - 1] !== undefined) return svt.growth[lv - 1];
  const pts: [number, number][] = [[1, svt.atk[1]], [maxLv, svt.atk.max], [100, svt.atk[100]], [120, svt.atk[120]]];
  for (let i = 1; i < pts.length; i++) {
    const [l0, a0] = pts[i - 1], [l1, a1] = pts[i];
    if (lv <= l1 && l1 > l0) return Math.round(a0 + ((a1 - a0) * (lv - l0)) / (l1 - l0));
  }
  return svt.atk[120];
}

/**
 * Chaldea 백업에는 레벨이 없고 재림 단계와 성배 수만 있다. 그래서 레벨은 이렇게 본다:
 * 재림 4단계는 기본 최대(+성배), 1~3단계는 그 단계의 레벨 상한, 0단계는 Lv1.
 * (실제 계정과 대조하면 재림한 서번트는 대개 그 단계의 상한까지, 재림하지 않은 서번트는 대개 Lv1이다.)
 * 예장은 종류별 보유 여부만 있어 1장으로 보고, 코스트 상한은 들어 있지 않다.
 */
function importChaldea(json: any, servants: Servant[], ces: BondCE[], boards: ClassBoard[]): LoginImport {
  const user = json.users[json.curUserKey ?? 0] ?? json.users[0];
  const roster: Roster = {};
  let count = 0;
  for (const svt of servants) {
    const st = user.servants?.[svt.no];
    const cur = st?.cur;
    if (!cur?.favorite) continue;
    count++;
    const caps = ASC_CAP[svt.rarity] ?? ASC_CAP[3];
    const maxLv = caps[4];
    const asc: number = Math.max(0, Math.min(4, cur.ascension ?? 0));
    const level = asc >= 4 ? grailLevel(maxLv, cur.grail ?? 0) : asc === 0 ? 1 : caps[asc];
    const fou = (cur.fouAtk3 ?? 0) * 50 + (cur.fouAtk ?? 0) * 20;
    const skills: number[] = (cur.skills ?? [1, 1, 1]).map((n: number) => Math.max(1, Math.min(10, n || 1)));
    const append: number[] = cur.appendSkills ?? [];
    const bond: number = st.bond ?? 0;
    const bondCap: number = cur.bondLimit ?? 10;
    const a5 = append[4] ?? 0;
    roster[svt.no] = {
      owned: true, npLv: Math.max(1, Math.min(5, cur.npLv ?? 1)),
      lv: level >= 120 ? '120' : level >= 100 ? '100' : 'max',
      skillLv: Math.min(...skills), skills,
      atk: atkAt(svt, level, maxLv) + fou, fou, level, bond, asc,
      startNp: (append[1] ?? 0) > 0 ? APPEND2[Math.min(append[1], 10) - 1] * 100 : 0,
      reload: a5 >= 10 ? 3 : a5 >= 6 ? 2 : a5 >= 1 ? 1 : 0,
      bondMax: bond >= bondCap, bond15: bond >= 15,
    };
  }
  if (!count) throw new Error('Chaldea 백업에 보유(즐겨찾기) 표시된 서번트가 없습니다.');
  const stock: Stock = {};
  let kinds = 0;
  for (const ce of ces) {
    const c = user.craftEssences?.[ce.no];
    const has = c?.status === 2;
    if (has) kinds++;
    // 예장 ATK는 레벨에 비례한다: Lv1에서 최대치의 1/4
    const lvMax = ce.rarity >= 5 ? 100 : ce.rarity === 4 ? 80 : 60;
    const atk = has ? Math.floor(ce.atk * (0.25 + (0.75 * (Math.min(c.lv ?? 1, lvMax) - 1)) / (lvMax - 1))) : 0;
    stock[ce.no] = { count: has ? 1 : 0, mlb: has && (c.limitCount ?? 0) >= 4, atk };
  }
  let score: LoginImport['score'] = null;
  if (user.classBoards) {
    score = {};
    for (const b of boards) score[b.id] = boardScore(b, user.classBoards[b.id]?.enhancedSquares ?? []);
  }
  return { score, roster, stock, costCap: null, servants: count, ceKinds: kinds, ceCopies: kinds, unknown: 0 };
}
