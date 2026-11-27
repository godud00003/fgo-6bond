import { makeCompact } from '../../scripts/transform.mjs';
import type { EnemyDef, NP, NpcSupport, QuestData, QuestRef, Servant, Skill, War } from './types.ts';

export interface Candidate { war: War; quest: QuestRef; phase: number; label: string; battleNo: number }

// "n부 m장" 표기 → war id
const PART_CHAPTER: Record<string, number> = {
  '1-0': 100, '1-1': 101, '1-2': 102, '1-3': 103, '1-4': 104, '1-5': 105, '1-6': 106, '1-7': 107, '1-8': 108,
  '1.5-1': 201, '1.5-2': 202, '1.5-3': 203, '1.5-4': 204,
  '2-0': 300, '2-1': 301, '2-2': 302, '2-3': 303, '2-4': 304, '2-5': 305, '2-5.5': 307, '2-6': 308,
  '2-6.5': 310, '2-7': 311,
  '3-1': 402, '3-2': 403, '3-3': 404,
};
const ALIASES: [RegExp, number][] = [
  [/올림포스|5장\s*후편/, 306], [/아틀란티스|5장\s*전편/, 305], [/헤이안쿄/, 307], [/퉁구스카/, 309],
  [/트라움/, 310], [/오딜\s*콜/, 401], [/페이퍼\s*문/, 402], [/이드/, 403], [/아키타입/, 404],
  [/강화\s*퀘|강퀘/, 1001], [/막간|인연\s*퀘|인터루드|영기\s*해방/, 1003],
];

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const PUNCT = /[-–—~·・,<>《》〈〉()[\]]/g;

function battles(war: War, quests: QuestRef[]): Candidate[] {
  const out: Candidate[] = [];
  const perSection = new Map<string, number>();
  const now = Date.now() / 1000;
  for (const q of quests) {
    // 기간 한정 퀘스트는 지금 열려 있는 것만 보여 준다
    if (q.open && (now < q.open[0] || now >= q.open[1])) continue;
    const key = q.type === 'main' ? `${q.chapter}-${q.sub}` : `q${q.id}`;
    for (const phase of q.phases) {
      if (q.noBattle.includes(phase)) continue;
      const n = (perSection.get(key) ?? 0) + 1;
      perSection.set(key, n);
      const sec = q.type === 'main' ? (q.subStr || (q.sub ? `제${q.sub}절` : '')) : q.type === 'free' ? '프리' : '';
      const title = q.name || q.spot;
      out.push({
        war, quest: q, phase, battleNo: n,
        label: `${war.longName} · ${sec ? sec + ' ' : ''}${title}${q.phases.length > 1 ? ` · ${n}번째 배틀` : ''}`,
      });
    }
  }
  return out;
}

export interface Resolved { candidates: Candidate[]; note: string }

/** "2부 6장 4절 2번째 배틀" 같은 문장을 퀘스트 후보 목록으로 바꾼다. */
export function resolveQuest(query: string, wars: War[]): Resolved {
  const q = query.trim();
  if (!q) return { candidates: [], note: '' };
  let warIds: number[] = [];
  const part = q.match(/(1\.5|\d)\s*부/);
  const chap = q.match(/(\d+(?:\.\d+)?)\s*장/);
  const partKey = part ? part[1] : /주장/.test(q) ? '3' : null;
  for (const [re, id] of ALIASES) if (re.test(q)) warIds.push(id);
  if (!warIds.length && partKey) {
    const ch = /서장/.test(q) ? '0' : /종장/.test(q) ? '8' : chap?.[1];
    if (ch !== undefined) {
      const id = PART_CHAPTER[`${partKey}-${ch}`];
      if (id) warIds = partKey === '2' && ch === '5' ? [305, 306] : [id];
    }
  }
  const nq = norm(q);
  if (!warIds.length) {
    warIds = wars.filter((w) => longNameHit(w, nq)).map((w) => w.id);
  }
  const scope = warIds.length ? wars.filter((w) => warIds.includes(w.id)) : wars;
  const section = q.match(/(\d+)\s*절/);
  const battle = q.match(/(\d+)\s*번째|(\d+)\s*(?:배틀|전투)|(?:배틀|전투)\s*(\d+)/);
  const battleNo = battle ? Number(battle[1] ?? battle[2] ?? battle[3]) : 0;
  const wantFree = /프리/.test(q);

  let cands: Candidate[] = [];
  for (const w of scope) {
    let qs = w.quests;
    if (section) qs = qs.filter((x) => x.type === 'main' && x.sub === Number(section[1]));
    else if (wantFree) qs = qs.filter((x) => x.type === 'free');
    cands.push(...battles(w, qs));
  }
  if (section && battleNo) cands = cands.filter((c) => c.battleNo === battleNo);

  // 장·절로 좁히지 못했으면 퀘스트명·지명으로 검색
  if (!section) {
    // 문장부호는 검색어와 퀘스트명 양쪽에서 지운다("칼데아 게이트-종화 수집 극급" ↔ "종화 수집<살・창 편>《극급》")
    const plain = (s: string) => norm(s.replace(PUNCT, ''));
    const words = q.replace(PUNCT, ' ').split(/\s+/).map(norm)
      .filter((w) => w && !/^(\d+(\.\d+)?부|\d+(\.\d+)?장|프리|퀘스트|배틀|전투|\d+번째|칼데아|게이트|요일|강화|강퀘|막간의?|이야기|인연퀘(스트)?|인연|인터루드)$/.test(w));
    const stripped = words.filter((w) => !scope.some((s) => warIds.includes(s.id) && longNameHit(s, w)));
    if (stripped.length) {
      const hit = cands.filter((c) => stripped.every((w) => plain(c.quest.name + c.quest.spot).includes(w)));
      // 강화 퀘스트·막간의 이야기는 수백 개라, 이름이 안 맞으면 전부 보여 주지 않고 없다고 답한다
      if (hit.length || !warIds.length || warIds.every((id) => id === 1001 || id === 1003)) cands = hit;
    } else if (!warIds.length) cands = [];
    if (battleNo) cands = cands.filter((c) => c.battleNo === battleNo);
  }
  const note = !cands.length ? '일치하는 퀘스트가 없습니다. "2부 6장 4절 2번째 배틀" 또는 퀘스트명·지명으로 검색해 보세요.'
    : cands.length > 1 ? `후보 ${cands.length}개 — 하나를 선택하세요.` : '';
  return { candidates: cands.slice(0, 200), note };
}

function longNameHit(w: War, nq: string): boolean {
  const parts = w.longName.split(/[\s/・]+/).map(norm).filter((p) => p.length >= 2 && !/^lostbelt|^no\.\d|^제\d특이점$|^퀘스트$/.test(p));
  return parts.some((p) => nq.includes(p) || (nq.length >= 2 && p.includes(nq)));
}

/** 나무위키 검색어: "Lostbelt No.6", "제1특이점" 같은 머리말과 가운뎃점을 빼야 검색 결과가 나온다. */
export function namuQuery(longName: string): string {
  const words = longName.replace(/・/g, ' ').split(/\s+/)
    .filter((w) => !/^(Lostbelt|No\.\d+|제\d특이점|특이점F|종국특이점|아종특이점.?|아종평행세계|주장.)$/.test(w));
  return words.length >= 2 ? words.join(' ') : longName;
}

// 적 패시브 중 시뮬레이터가 읽는 것: 방어력 증감, 보구 대미지 내성 증감, 고정 대미지 컷·추가, 회피·무적
const ENEMY_PASSIVE = new Set(['upDefence', 'downDefence', 'downDefenceNpdamage', 'upDefenceNpdamage', 'subSelfdamage', 'addSelfdamage', 'avoidance', 'invincible']);

const API = 'https://api.atlasacademy.io';

const compact = makeCompact();
const sameSkill = (a: Skill, b: Skill | undefined) => !!b && JSON.stringify([a.cd, a.fn, a.init, a.needNp]) === JSON.stringify([b.cd, b.fn, b.init, b.needNp]);
const sameNp = (a: NP, b: NP | null | undefined) => !!b && JSON.stringify({ ...a, name: '' }) === JSON.stringify({ ...b, name: '' });

/**
 * 지정 서포트(NPC) 한 기를 시뮬레이터용으로 옮긴다.
 * NPC는 레벨·ATK·스킬 레벨·보구 레벨이 정해져 있고, 강화 전 스킬을 쓰거나 스킬이 덜 열려 있는 경우가 많다.
 * 그래서 도감 데이터가 아니라 퀘스트에 실린 스킬·보구를 변환해 쓴다(지금 도감의 것과 같으면 한국어 이름이 있는 도감 것을 쓴다).
 */
function toNpc(s: any, names: Record<string, string>, servants: Servant[] | undefined, front: boolean): NpcSupport {
  const base = servants?.find((x) => x.id === s.svt.id);
  const jp: NonNullable<NpcSupport['jp']> = { skills: [] };
  const skills: Skill[] = [], skillLvs: number[] = [];
  for (const n of [1, 2, 3]) {
    const raw = s.skills?.[`skill${n}`];
    if (!raw || !s.skills[`skillId${n}`]) continue;
    const k = compact.compactSkill(raw, 10) as Skill;
    const known = base?.skills.find((b) => sameSkill(k, b));
    if (!known) jp.skills.push([skills.length, raw.id]);
    skills.push(known ?? k);
    skillLvs.push(s.skills[`skillLv${n}`] || 1);
  }
  let np: NP | null = null;
  const td = s.noblePhantasm?.noblePhantasm;
  if (td && s.noblePhantasm.noblePhantasmId) {
    const k = compact.compactNp(td) as NP;
    if (sameNp(k, base?.np)) np = base!.np; else { np = k; jp.np = td.id; }
  }
  const name = names[s.svt.id] || base?.name || s.svt.name;
  const svt: Servant = {
    id: s.svt.id, no: s.svt.collectionNo, name, cls: s.svt.className, rarity: s.svt.rarity, cost: base?.cost ?? 0, attr: s.svt.attribute,
    traits: base?.traits ?? (s.svt.traits || []).map((t: any) => t.id), atk: base?.atk ?? { 1: s.atk, max: s.atk, 100: s.atk, 120: s.atk },
    skills, np, passive: base?.passive ?? [], face: base?.face ?? s.svt.face ?? '',
  };
  return { svt, lv: s.lv, atk: s.atk, npLv: s.noblePhantasm?.noblePhantasmLv || 1, skillLvs, front: front || undefined, jp: jp.skills.length || jp.np ? jp : undefined };
}

/** 지정 서포트의 스킬·보구 이름 중 일본어로 남은 것을 한국 서버 이름으로 바꾼다(받지 못하면 그대로 둔다). */
export async function localizeNpc(q: QuestData): Promise<QuestData> {
  const jp = q.npc?.jp;
  if (!q.npc || !jp) return q;
  const nameOf = async (path: string): Promise<string | undefined> => {
    try { const r = await fetch(`${API}/nice/KR/${path}`); return r.ok ? (await r.json()).name : undefined; } catch { return undefined; }
  };
  const svt = { ...q.npc.svt, skills: q.npc.svt.skills.slice() };
  await Promise.all([
    ...jp.skills.map(async ([i, id]) => { const n = await nameOf(`skill/${id}`); if (n) svt.skills[i] = { ...svt.skills[i], name: n }; }),
    (async () => { if (jp.np && svt.np) { const n = await nameOf(`NP/${jp.np}`); if (n) svt.np = { ...svt.np, name: n }; } })(),
  ]);
  return { ...q, npc: { ...q.npc, svt, jp: undefined } };
}

/** Atlas Academy 응답(일본 서버 전투 데이터)을 시뮬레이터 입력으로 변환한다. */
export function toQuestData(raw: any, names: Record<string, string>, title?: string, servants?: Servant[]): QuestData {
  const warnings: string[] = [];
  // ---- 편성 제한: 지정 서포트(NPC), 서포트 자리 고정, 편성 금지 서번트
  const restr: { type: string; rangeType: string; targetVals: number[] }[] = (raw.restrictions || []).map((r: any) => r.restriction);
  const sups: any[] = raw.supportServants || [];
  // 반드시 편성: 내 서번트나 NPC 중 하나로 데려가야 하는 서번트 / 내 서번트를 전열에 세워야 하는 서번트
  const need = restr.filter((r) => r.type === 'mySvtOrNpc').flatMap((r) => r.targetVals);
  const needMain = restr.filter((r) => r.type === 'fixedMySvtIndividualityPositionMain').flatMap((r) => r.targetVals);
  const nameOf = (id: number) => names[id] || servants?.find((x) => x.id === id)?.name || `#${id}`;
  let npc: NpcSupport | undefined;
  let npcId: number | undefined;
  if (raw.isNpcOnly && sups.length) {
    const fix = restr.find((r) => r.type === 'fixedSupportPosition');
    const front = !!fix && fix.targetVals.length > 0 && fix.targetVals.every((p) => p <= 3);
    // 후보가 여럿이면 반드시 편성해야 하는 서번트의 NPC를 고른다(내 서번트를 따로 넣지 않아도 된다)
    const sup = sups.find((s) => need.includes(s.svt?.id)) ?? sups[0];
    npcId = sup.svt?.id;
    npc = toNpc(sup, names, servants, front);
    warnings.push(`지정 서포트 전투입니다: 프렌드 대신 ${npc.svt.name}(Lv.${npc.lv}, 보구 Lv.${npc.npLv}, 예장 없음)을(를) 데려가야 합니다. 프렌드 관련 설정은 적용되지 않습니다.`);
    if (front) warnings.push('지정 서포트는 전열에 고정됩니다. 전투 중 오더 체인지로는 후열과 바꿀 수 있습니다("오더 체인지 사용"을 켜면 그 편성도 찾습니다).');
    if (sups.length > 1) warnings.push(`지정 서포트 후보가 ${sups.length}기입니다. ${npc.svt.name}을(를) 고른 것으로 계산합니다.`);
  }
  const must = [...new Set([...needMain, ...need.filter((id) => id !== npcId)])];
  if (must.length) warnings.push(`이 전투에는 ${must.map(nameOf).join(', ')}을(를) 내 파티에 반드시 넣어야 해서, 들어간 편성만 찾습니다.`);
  const viaNpc = need.filter((id) => id !== npcId && sups.some((s) => s.svt?.id === id));
  if (viaNpc.length) warnings.push(`내 서번트 대신 서포트 목록의 NPC ${viaNpc.map(nameOf).join(', ')}을(를) 데려가도 조건이 채워지지만, 그 경우는 계산하지 않습니다.`);
  if (needMain.length) warnings.push(`${needMain.map(nameOf).join(', ')}은(는) 전열(스타팅 멤버)에 세워야 합니다. 결과에 후열로 나오면 전열로 옮겨야 하고, 그만큼 인연 포인트가 달라질 수 있습니다.`);
  const ban = [...new Set(restr.filter((r) => r.type === 'individuality' && r.rangeType === 'notEqual').flatMap((r) => r.targetVals))];
  if (ban.length) {
    const who = ban.map(nameOf).join(', ');
    warnings.push(`이 전투에는 ${who}을(를) 내 파티에 넣을 수 없습니다.`);
  }
  const flags: string[] = raw.flags || [];
  const odd = [
    flags.some((f) => f === 'supportOnlyBattle' || f === 'supportOnlyForceBattle') && '서포트만 출전',
    flags.includes('userEventDeck') && '전용 편성',
    restr.some((r) => r.type === 'svtNum' || r.type === 'mySvtNum') && '출전 인원 제한',
    flags.includes('disableMasterSkill') && '마스터 스킬 사용 불가',
  ].filter(Boolean);
  if (odd.length) warnings.push(`이 전투에는 계산에 반영하지 못한 편성 제한이 있습니다: ${odd.join(', ')}. 결과가 실제와 다를 수 있습니다.`);

  const waves: EnemyDef[][] = [];
  const waveCalls: EnemyDef[][] = [];
  const waveSize: number[] = [];
  const waveNoEntry: number[][] = [];
  for (const st of raw.stages || []) {
    const byNpc = new Map<number, any>();
    for (const e of st.enemies) byNpc.set(e.npcId, e);
    const toDef = (e: any): EnemyDef => {
      const bars = [e.hp];
      for (const id of e.enemyScript?.shift || []) { const n = byNpc.get(id); if (n) bars.push(n.hp); }
      // 적의 패시브: 특성 부여는 특성 목록에 합치고, 받는 대미지에 영향을 주는 버프는 따로 옮긴다
      const traits: number[] = (e.traits || []).map((t: any) => t.id);
      const passive: NonNullable<EnemyDef['passive']> = [];
      const idsOf = (l: any[] | undefined) => (l || []).map((t: any) => t.id);
      for (const p of [...(e.classPassive?.classPassive || []), ...(e.classPassive?.addPassive || [])]) {
        for (const fn of p.functions || []) {
          if ((fn.funcType !== 'addState' && fn.funcType !== 'addStateShort') || fn.funcTargetType !== 'self') continue;
          const sv = fn.svals?.[0] ?? {};
          if ((sv.Rate ?? 1000) < 1000) continue;
          for (const b of fn.buffs || []) {
            if (b.type === 'addIndividuality') { if (sv.Value) traits.push(sv.Value); continue; }
            if (!ENEMY_PASSIVE.has(b.type)) continue;
            passive.push({ t: b.type, val: sv.Value ?? 0, turn: sv.Turn ?? -1, count: sv.Count ?? -1, cs: idsOf(b.ckSelfIndv), co: idsOf(b.ckOpIndv) });
          }
        }
      }
      return {
        name: names[e.svt.id] || e.name, cls: e.svt.className, attr: e.svt.attribute,
        traits, bars, tdRate: e.serverMod?.tdRate ?? 1000, deckId: e.deckId,
        rarity: e.svt.rarity, passive: passive.length ? passive : undefined,
      };
    };
    // 증원(call 덱): 적 AI가 필드에 빈자리가 있을 때 불러낸다. 소환 목록은 적 개별(enemyScript.call) 또는 웨이브 공통(stage.call).
    const callDefs = (ids: number[] | undefined): EnemyDef[] =>
      (ids || []).map((id) => byNpc.get(id)).filter((e: any) => e && e.deck === 'call').map(toDef);
    const wave: EnemyDef[] = [];
    for (const e of st.enemies) {
      if (e.deck !== 'enemy') continue;
      const def = toDef(e);
      const call = callDefs(e.enemyScript?.call);
      if (call.length) def.call = call;
      wave.push(def);
    }
    const stageCall = callDefs(st.call);
    if (stageCall.length || wave.some((e) => e.call)) {
      warnings.push(`${st.wave}웨이브의 적은 빈자리가 생기면 증원을 계속 소환합니다. 소환하는 적까지 같은 턴에 쓰러뜨려야 웨이브가 끝납니다.`);
    }
    if (wave.some((e) => e.bars.length > 1)) warnings.push(`${st.wave}웨이브에 브레이크 게이지를 가진 적이 있습니다.`);
    if (wave.length) {
      const size = st.enemyFieldPosCount || 3;
      waves.push(wave); waveCalls.push(stageCall); waveSize.push(size); waveNoEntry.push(st.NoEntryIds || []);
      // 자리 번호(deckId)가 필드 자리 수보다 큰 적은 대기 중이며, 앞의 적이 쓰러진 다음 턴에 들어온다
      const late = wave.filter((e) => e.deckId > size);
      if (late.length && late.length < wave.length) {
        warnings.push(`${st.wave}웨이브의 ${late.map((e) => e.name).join(', ')}은(는) 처음에는 나오지 않고, 먼저 나온 적이 쓰러진 다음 턴에 등장합니다.`);
      }
    }
  }
  if (!waves.length) warnings.push('이 전투는 Atlas Academy에 적 데이터가 없습니다.');
  if (/랜덤|ランダム/.test(`${title ?? ''}${raw.name ?? ''}`)) {
    warnings.push('이 퀘스트는 적 클래스가 판마다 바뀝니다. 아래는 데이터에 기록된 한 가지 구성이라, 실제 판과 상성이 다를 수 있습니다.');
  }
  return {
    id: raw.id, phase: raw.phase, name: title || raw.name, bond: raw.bond ?? 0, ap: raw.consume ?? 0,
    fieldTraits: (raw.individuality || []).map((t: any) => t.id), waves, warnings,
    waveCalls: waveCalls.some((c) => c.length) ? waveCalls : undefined,
    waveSize: waveSize.some((n) => n !== 3) ? waveSize : undefined,
    waveNoEntry: waveNoEntry.some((l) => l.length) ? waveNoEntry : undefined,
    npc, ban: ban.length ? ban : undefined, must: must.length ? must : undefined,
  };
}

export async function fetchQuest(id: number, phase: number, names: Record<string, string>, title?: string, servants?: Servant[]): Promise<QuestData> {
  const res = await fetch(`${API}/nice/JP/quest/${id}/${phase}`);
  if (!res.ok) throw new Error(`퀘스트 데이터를 받지 못했습니다 (HTTP ${res.status})`);
  return localizeNpc(toQuestData(await res.json(), names, title, servants));
}
