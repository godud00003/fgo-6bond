import type { EnemyDef, QuestData, QuestRef, War } from './types.ts';

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
];

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const PUNCT = /[-–—~·・,<>《》〈〉()[\]]/g;

function battles(war: War, quests: QuestRef[]): Candidate[] {
  const out: Candidate[] = [];
  const perSection = new Map<string, number>();
  for (const q of quests) {
    const key = q.type === 'main' ? `${q.chapter}-${q.sub}` : `q${q.id}`;
    for (const phase of q.phases) {
      if (q.noBattle.includes(phase)) continue;
      const n = (perSection.get(key) ?? 0) + 1;
      perSection.set(key, n);
      const sec = q.type === 'main' ? (q.subStr || (q.sub ? `제${q.sub}절` : '')) : '프리';
      const title = q.name || q.spot;
      out.push({
        war, quest: q, phase, battleNo: n,
        label: `${war.longName} · ${sec} ${title}${q.phases.length > 1 ? ` · ${n}번째 배틀` : ''}`,
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
      .filter((w) => w && !/^(\d+(\.\d+)?부|\d+(\.\d+)?장|프리|퀘스트|배틀|전투|\d+번째|칼데아|게이트|요일)$/.test(w));
    const stripped = words.filter((w) => !scope.some((s) => warIds.includes(s.id) && longNameHit(s, w)));
    if (stripped.length) {
      const hit = cands.filter((c) => stripped.every((w) => plain(c.quest.name + c.quest.spot).includes(w)));
      if (hit.length || !warIds.length) cands = hit;
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

const API = 'https://api.atlasacademy.io';

/** Atlas Academy 응답(일본 서버 전투 데이터)을 시뮬레이터 입력으로 변환한다. */
export function toQuestData(raw: any, names: Record<string, string>, title?: string): QuestData {
  const warnings: string[] = [];
  const waves: EnemyDef[][] = [];
  const waveCalls: EnemyDef[][] = [];
  for (const st of raw.stages || []) {
    const byNpc = new Map<number, any>();
    for (const e of st.enemies) byNpc.set(e.npcId, e);
    const toDef = (e: any): EnemyDef => {
      const bars = [e.hp];
      for (const id of e.enemyScript?.shift || []) { const n = byNpc.get(id); if (n) bars.push(n.hp); }
      return {
        name: names[e.svt.id] || e.name, cls: e.svt.className, attr: e.svt.attribute,
        traits: (e.traits || []).map((t: any) => t.id), bars, tdRate: e.serverMod?.tdRate ?? 1000, deckId: e.deckId,
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
    if (wave.length) { waves.push(wave); waveCalls.push(stageCall); }
  }
  if (!waves.length) warnings.push('이 전투는 Atlas Academy에 적 데이터가 없습니다.');
  return {
    id: raw.id, phase: raw.phase, name: title || raw.name, bond: raw.bond ?? 0, ap: raw.consume ?? 0,
    fieldTraits: (raw.individuality || []).map((t: any) => t.id), waves, warnings,
    waveCalls: waveCalls.some((c) => c.length) ? waveCalls : undefined,
  };
}

export async function fetchQuest(id: number, phase: number, names: Record<string, string>, title?: string): Promise<QuestData> {
  const res = await fetch(`${API}/nice/JP/quest/${id}/${phase}`);
  if (!res.ok) throw new Error(`퀘스트 데이터를 받지 못했습니다 (HTTP ${res.status})`);
  return toQuestData(await res.json(), names, title);
}
