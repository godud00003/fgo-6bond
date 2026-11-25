// 게임 로그인 응답(HTTPS 스니핑으로 얻는 JSON, Chaldea가 받는 것과 같은 형식)에서
// 보유 서번트·인연 예장·코스트 상한을 읽는다. 필요한 수치만 뽑고 원본은 보관하지 않는다.
import type { BondCE, Servant } from './types.ts';

export interface RosterEntry {
  owned: boolean; npLv: number; lv: 'max' | '100' | '120'; skillLv: number; bondMax: boolean; bond15?: boolean;
  /** 게임에서 가져온 실제 ATK(포우 강화 포함). 있으면 레벨·포우 설정 대신 이 값을 쓴다. */
  atk?: number;
  /** 스킬 1~3의 레벨. 있으면 skillLv 대신 쓴다. */
  skills?: number[];
  /** 어펜드 스킬 2로 얻는 시작 NP (10000 = 100%). 없으면 조건 탭의 설정을 따른다. */
  startNp?: number;
  /** 편성 화면에 보이는 영기재림 단계(0~4). 단계별로 특성이 다른 서번트의 판정에 쓴다. */
  asc?: number;
  /** 표시용: 실제 레벨, 인연 레벨 */
  level?: number; bond?: number;
}
export type Roster = Record<number, RosterEntry>;
export type Stock = Record<number, { count: number; mlb: boolean }>;

export interface LoginImport {
  roster: Roster; stock: Stock; costCap: number | null;
  servants: number; ceKinds: number; ceCopies: number; unknown: number;
}

// 어펜드 스킬 2(마력장전) 레벨별 시작 NP(%)
const APPEND2 = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20];

interface UserSvt {
  id: number; svtId: number; lv: number; atk: number; limitCount: number; dispLimitCount?: number;
  skillLv1: number; skillLv2: number; skillLv3: number; treasureDeviceLv1: number;
}

function parse(text: string): any {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* base64로 저장된 경우 */ }
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(decodeURIComponent(t)), (c) => c.charCodeAt(0))));
}

export function importLogin(text: string, servants: Servant[], ces: BondCE[]): LoginImport {
  let json: any;
  try { json = parse(text); } catch { throw new Error('JSON 형식이 아닙니다. 게임 로그인 응답 파일인지 확인하세요.'); }
  const tables = json?.cache?.replaced ?? json?.replaced ?? json;
  const rows: UserSvt[] = [...(tables?.userSvt ?? []), ...(tables?.userSvtStorage ?? [])];
  if (!rows.length) throw new Error('보유 서번트 목록(userSvt)이 없습니다. 게임 로그인 응답 파일인지 확인하세요.');

  const collection = new Map<number, any>((tables.userSvtCollection ?? []).map((c: any) => [c.svtId, c]));
  const appendByUserSvt = new Map<number, number>();
  for (const a of tables.userSvtAppendPassiveSkillLv ?? []) {
    const i = (a.appendPassiveSkillNums ?? []).indexOf(101);
    if (i >= 0) appendByUserSvt.set(a.userSvtId, a.appendPassiveSkillLvs?.[i] ?? 0);
  }

  const svtById = new Map(servants.map((s) => [s.id, s]));
  const ceById = new Map(ces.map((c) => [c.id, c]));
  const best = new Map<number, UserSvt>();
  const ceLimits = new Map<number, number[]>();
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
      atk: u.atk, level: u.lv, bond,
      asc: u.dispLimitCount !== undefined && u.dispLimitCount >= 0 && u.dispLimitCount <= 4 ? u.dispLimitCount : undefined,
      startNp: appendLv > 0 ? APPEND2[Math.min(appendLv, 10) - 1] * 100 : 0,
      bondMax: bond >= bondCap, bond15: bond >= 15,
    };
  }

  // 인연 예장: 최대해방본이 있으면 그 장수, 없으면 미해방 장수. 없는 예장은 0장.
  const stock: Stock = {};
  let ceCopies = 0;
  for (const ce of ces) {
    const limits = ceLimits.get(ce.no) ?? [];
    const mlb = limits.filter((l) => l >= 4).length;
    stock[ce.no] = mlb ? { count: mlb, mlb: true } : { count: limits.length, mlb: false };
    ceCopies += limits.length;
  }
  const costMax = tables.userGame?.[0]?.costMax;
  return {
    roster, stock, costCap: typeof costMax === 'number' && costMax > 0 ? costMax : null,
    servants: best.size, ceKinds: ceLimits.size, ceCopies, unknown,
  };
}
