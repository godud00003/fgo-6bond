import { useEffect, useMemo, useRef, useState } from 'react';
// 인라인 워커: 파일을 직접 열어도(file://) 동작하도록 워커 코드를 번들 안에 넣는다
import SearchWorker from './worker.ts?worker&inline';
import UpdateWorker from './update.worker.ts?worker&inline';
import { DATA_FMT, latestKr, loadCached, saveCached, type Dataset } from './update.ts';
import { fetchQuest, namuQuery, resolveQuest, type Candidate } from './engine/quest.ts';
import type { CEStock, CorePart, PartyResult, PoolEntry, SearchOutput, Settings } from './engine/search.ts';
import type { BondCE, MysticCode, QuestData, Rel, Servant, War } from './engine/types.ts';

type Data = Dataset;
import { boardScore, importLogin, type Roster, type RosterEntry, type Stock } from './engine/importLogin.ts';

interface Prefs {
  /** 이벤트 예장(딜러용): 시작 NP(10000 = 100%), 공격 위력 UP(천분율), 가진 장수 */
  evNp?: number; evPower?: number; evCount?: number;
  poolMode: 'all' | 'owned'; maxTurns: number; costCap: number; roll: number; append2: boolean; append5: boolean; fAppend2: boolean; fAppend5: boolean; fou: number;
  friendCe: string; np5: number; np4: number; np3: number; teapot: number; mc: number; cardNp: number; lv1: boolean; allowDup: boolean; must: number[]; oc: boolean; cs: boolean; npPlan: boolean; autoUpdate: boolean;
  /** 내 서번트를 스킬 레벨 10 / 어펜드 2·5 개방으로 가정하고 계산한다(육성하면 되는 편성 찾기) */
  maxSkill?: boolean; maxAppend?: boolean;
  /** 클래스 스코어: 내 것(없음 / 전부 개방 / 가져온 데이터), 프렌드 것, 가져온 판별 수치 */
  score: 'none' | 'full' | 'own'; fScore: 'none' | 'full'; scoreOwn?: Record<number, number[]>;
}
const DEFAULT_PREFS: Prefs = {
  poolMode: 'all', maxTurns: 3, costCap: 112, roll: 0.9, append2: true, append5: true, fAppend2: true, fAppend5: true, fou: 1000, friendCe: '', np5: 1, np4: 2, np3: 5, teapot: 1, mc: -1, cardNp: 0, lv1: false, allowDup: true, must: [], oc: false, cs: false, npPlan: true, autoUpdate: true, score: 'none', fScore: 'none',
};

const CLASS_KO: Record<string, string> = {
  saber: '세이버', archer: '아처', lancer: '랜서', rider: '라이더', caster: '캐스터', assassin: '어새신',
  berserker: '버서커', shielder: '실더', ruler: '룰러', avenger: '어벤저', alterEgo: '얼터에고',
  moonCancer: '문캔서', foreigner: '포리너', pretender: '프리텐더', beast: '비스트',
};
const ATTR_KO: Record<string, string> = { human: '인', sky: '천', earth: '지', star: '성', beast: '수' };
const ROLE_KO = { dealer: '딜러', support: '서포터', filler: '인연' } as const;

function usePersist<T>(key: string, init: T): [T, (v: T | ((p: T) => T)) => void] {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return typeof init === 'object' && init && !Array.isArray(init) ? { ...init, ...JSON.parse(raw) } : JSON.parse(raw);
    } catch { /* 저장소를 못 쓰면 기본값 */ }
    return init;
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 무시 */ } }, [key, val]);
  return [val, setVal];
}

export default function App() {
  const [data, setData] = useState<Data | null>(null);
  const [upd, setUpd] = useState('');
  const updating = useRef(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'party' | 'roster' | 'ce'>('party');
  const [roster, setRoster] = usePersist<Roster>('fgo-bond.roster', {});
  const [stock, setStock] = usePersist<Stock>('fgo-bond.stock', {});
  const [prefs, setPrefs] = usePersist<Prefs>('fgo-bond.prefs', DEFAULT_PREFS);

  useEffect(() => {
    // 단일 HTML 배포본에는 게임 데이터가 파일 안에 들어 있다
    const embedded = (window as unknown as { __FGO_DATA__?: Data }).__FGO_DATA__;
    const get = (f: string) => fetch(`${import.meta.env.BASE_URL}data/${f}`).then((r) => {
      if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
      return r.json();
    });
    const base: Promise<Data> = embedded ? Promise.resolve(embedded)
      : Promise.all(['servants.json', 'ces.json', 'wars.json', 'names.json', 'rel.json', 'mcs.json', 'boards.json', 'meta.json'].map(get))
        .then(([servants, ces, wars, names, rel, mcs, boards, meta]) => ({ servants, ces, wars, names, rel, mcs, boards, meta }));
    base.then(async (b) => {
      if (!b.meta) b.meta = { kr: { hash: '', timestamp: 0 }, builtAt: 0 };
      // 이전에 이 브라우저에서 받아 둔 더 새로운 데이터가 있으면 그것을 쓴다
      const cached = await loadCached();
      // 예전 형식(오픈 전 이벤트 없음 등)으로 저장된 데이터는 쓰지 않는다
      const cur = cached && cached.meta.fmt === DATA_FMT && cached.meta.kr.timestamp > b.meta.kr.timestamp ? cached : b;
      setData(cur);
      if (prefs.autoUpdate ?? true) void checkUpdate(cur, false);
    }).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 새 한국 서버 데이터가 있으면 받아서 바꾼다. manual: 사용자가 직접 누른 경우(결과를 항상 알려 준다) */
  const checkUpdate = async (cur: Data, manual: boolean) => {
    if (updating.current) return;
    try {
      if (manual) setUpd('새 데이터가 있는지 확인하는 중…');
      const kr = await latestKr();
      if (kr.timestamp <= cur.meta.kr.timestamp) { setUpd(manual ? '이미 최신 데이터입니다.' : ''); return; }
    } catch {
      setUpd(manual ? '확인하지 못했습니다. 인터넷 연결을 확인하세요.' : '');
      return;
    }
    updating.current = true;
    setUpd('새 게임 데이터를 받는 중…');
    const w = new UpdateWorker();
    w.onmessage = async (ev) => {
      if (ev.data.type === 'progress') { setUpd(`새 게임 데이터로 업데이트하는 중 — ${ev.data.text}`); return; }
      if (ev.data.type === 'done') {
        const ds: Data = ev.data.dataset;
        await saveCached(ds);
        setData(ds);
        setUpd(`새 게임 데이터로 업데이트했습니다 (서번트 ${ds.servants.length}기).`);
      } else setUpd(`업데이트하지 못했습니다: ${ev.data.message}`);
      updating.current = false;
      w.terminate();
    };
    w.postMessage(0);
  };

  /** 게임 로그인 데이터를 읽어 보유 서번트·인연 예장·코스트 상한을 한 번에 채운다(브라우저 안에서만 처리) */
  const onLogin = async (f: File): Promise<string> => {
    if (!data) return '';
    const r = importLogin(await f.text(), data.servants, data.ces, data.boards);
    setRoster(r.roster);
    setStock(r.stock);
    setPrefs((p) => ({ ...p, poolMode: 'owned', costCap: r.costCap ?? p.costCap, ...(r.score ? { score: 'own' as const, scoreOwn: r.score } : {}) }));
    return `가져왔습니다: 서번트 ${r.servants}기, 인연 예장 ${r.ceKinds}종 ${r.ceCopies}장${r.costCap ? `, 코스트 상한 ${r.costCap}` : ''}${r.score ? ', 클래스 스코어' : ''}. 서번트 풀은 "내 보유 서번트만"으로 바꿨고, 이 브라우저에 저장했습니다.`;
  };

  if (error) return <div className="app"><p className="error">데이터를 불러오지 못했습니다: {error}</p></div>;
  if (!data) return <div className="app"><p className="muted">데이터를 불러오는 중…</p></div>;
  const owned = Object.values(roster).filter((r) => r.owned).length;

  return (
    <div className="app">
      <header>
        <h1>FGO 인연 파티 최적화</h1>
        <p className="muted">한국 서버 기준 · 인연 예장을 끼고도 클리어되는 파티 중 인연 포인트가 가장 많은 구성을 찾습니다.</p>
        <p className="muted small dataline">
          게임 데이터: {data.meta.kr.timestamp ? new Date(data.meta.kr.timestamp * 1000).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '알 수 없음'} 기준
          <button onClick={() => void checkUpdate(data, true)}>업데이트 확인</button>
          <label className="check"><input type="checkbox" checked={prefs.autoUpdate ?? true} onChange={(e) => setPrefs((p) => ({ ...p, autoUpdate: e.target.checked }))} /> 열 때마다 자동 업데이트</label>
          {upd && <b>{upd}</b>}
        </p>
        <nav>
          <button className={tab === 'party' ? 'on' : ''} onClick={() => setTab('party')}>파티 추천</button>
          <button className={tab === 'roster' ? 'on' : ''} onClick={() => setTab('roster')}>내 서번트 ({owned})</button>
          <button className={tab === 'ce' ? 'on' : ''} onClick={() => setTab('ce')}>인연 예장</button>
        </nav>
      </header>
      <div hidden={tab !== 'party'}><PartyTab data={data} roster={roster} stock={stock} prefs={prefs} setPrefs={setPrefs} /></div>
      {tab === 'roster' && <RosterTab data={data} roster={roster} setRoster={setRoster} onLogin={onLogin} />}
      {tab === 'ce' && <CETab data={data} stock={stock} setStock={setStock} />}
      <footer className="muted">
        게임 데이터: Atlas Academy (서번트·예장·퀘스트는 한국 서버, 적 구성은 같은 퀘스트의 일본 서버 데이터).
        클리어 판정은 보구만 계산하는 근사치이며 실제 전투와 다를 수 있습니다.
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ 파티 추천

function buildPool(data: Data, roster: Roster, prefs: Prefs): PoolEntry[] {
  const out: PoolEntry[] = [];
  for (const svt of data.servants) {
    const r = roster[svt.no];
    if (prefs.poolMode === 'owned' && !r?.owned) continue;
    const npDefault = svt.rarity >= 5 ? prefs.np5 : svt.rarity === 4 ? prefs.np4 : prefs.np3;
    const useOwn = !!r?.owned;
    // 재림 단계에 따라 특성이 달라지는 서번트는 등록한 단계의 특성으로 판정한다
    const stage = useOwn && svt.asc ? svt.asc[r.asc ?? 4] : undefined;
    out.push({
      svt: stage ? { ...svt, traits: stage } : svt, npLv: useOwn ? r.npLv : npDefault, skillLv: useOwn && !prefs.maxSkill ? r.skillLv : 10,
      skillLvs: useOwn && !prefs.maxSkill ? r.skills : undefined,
      // 육성 가정: 어펜드 2(시작 NP 20%)와 어펜드 5 Lv10(재장전 3회)을 연 것으로 본다
      startNp: !useOwn ? undefined : prefs.maxAppend ? Math.max(r.startNp ?? 0, 2000) : r.startNp, reload: !useOwn ? undefined : prefs.maxAppend ? 3 : r.reload,
      // 레벨 1 고정 퀘스트: 레벨 1 ATK + 포우 강화(가져온 서번트는 실제 강화량)
      atk: prefs.lv1 ? svt.atk[1] + (useOwn && r.fou !== undefined ? r.fou : prefs.fou)
        : useOwn && r.atk ? r.atk : svt.atk[useOwn ? r.lv : 'max'] + prefs.fou, weight: useOwn && (r.bondMax || r.bond15) ? 0 : 1, bond15: useOwn && !!r.bond15,
    });
  }
  return out;
}

/** 권장 턴 수: 웨이브마다 처음 나온 적과 대기 중인 적을 차례로 정리하는 턴 수와 브레이크 게이지 줄 수 중 큰 쪽 */
function suggestTurns(q: QuestData): number {
  return q.waves.reduce((n, w, i) => {
    const size = q.waveSize?.[i] ?? 3;
    const late = w.filter((e) => e.deckId > size).length;
    const open = Math.max(1, size - (q.waveNoEntry?.[i]?.length ?? 0));
    const clear = late < w.length ? 1 + Math.ceil(late / open) : Math.ceil(late / open);
    return n + Math.max(clear, ...w.map((e) => e.bars.length));
  }, 0);
}

function PartyTab({ data, roster, stock, prefs, setPrefs }: {
  data: Data; roster: Roster; stock: Stock; prefs: Prefs; setPrefs: (v: Prefs | ((p: Prefs) => Prefs)) => void;
}) {
  const [query, setQuery] = useState('2부 6장 4절 2번째 배틀');
  const [cands, setCands] = useState<Candidate[]>([]);
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [quest, setQuest] = useState<QuestData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [output, setOutput] = useState<SearchOutput | null>(null);
  const workers = useRef<Worker[]>([]);
  const stopWorkers = () => { for (const w of workers.current) w.terminate(); workers.current = []; };
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => ({ ...p, [k]: v }));

  const pick = async (c: Candidate) => {
    setPicked(c); setQuest(null); setOutput(null); setErr(''); setLoading(true);
    try {
      const q = await fetchQuest(c.quest.id, c.phase, data.names, c.label, data.servants);
      setQuest(q);
      const minTurns = suggestTurns(q);
      if (minTurns) set('maxTurns', Math.max(minTurns, 1));
    } catch (e) { setErr(String(e)); }
    setLoading(false);
  };
  const doSearch = () => {
    const r = resolveQuest(query, data.wars);
    setCands(r.candidates); setNote(r.note); setPicked(null); setQuest(null); setOutput(null);
    if (r.candidates.length === 1) void pick(r.candidates[0]);
  };

  const run = () => {
    if (!quest) return;
    stopWorkers();
    // 편성 찾기는 워커 여러 개가 나눠 맡고(코어 수 - 1, 최대 8), 다 끝나면 한 워커가 합쳐서 인연을 최적화한다
    const count = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    const ws = Array.from({ length: count }, () => new SearchWorker());
    workers.current = ws;
    setProgress(0); setOutput(null); setErr('');
    const prog = ws.map(() => [0, 1]);
    const parts: CorePart[] = [];
    ws.forEach((w, index) => {
      w.onmessage = (ev) => {
        if (workers.current !== ws) return; // 새 계산이 시작됐다
        if (ev.data.type === 'progress') {
          prog[index] = [ev.data.done, ev.data.total];
          setProgress(prog.reduce((n, p) => n + p[0], 0) / Math.max(1, prog.reduce((n, p) => n + p[1], 0)));
        } else if (ev.data.type === 'cores') {
          parts.push(ev.data.part);
          if (parts.length === count) ws[0].postMessage({ type: 'finish', parts });
        } else if (ev.data.type === 'done') { setOutput(ev.data.output); setProgress(null); stopWorkers(); }
        else { setErr(ev.data.message); setProgress(null); stopWorkers(); }
      };
    });
    const ceStock: CEStock[] = data.ces.map((ce) => ({ ce, count: stock[ce.no]?.count ?? 1, mlb: stock[ce.no]?.mlb ?? true, atk: stock[ce.no]?.atk ?? ce.atk }));
    const [fNo, fMlb] = prefs.friendCe.split(':');
    // 클래스 스코어: 판별 수치를 클래스 이름별로 펼친다
    const scoreOf = (mode: string | undefined) => {
      if (!mode || mode === 'none') return undefined;
      const out: Record<string, number[]> = {};
      for (const b of data.boards ?? []) {
        const v = mode === 'full' ? boardScore(b) : prefs.scoreOwn?.[b.id];
        if (v?.some((x) => x > 0)) for (const c of b.cls) out[c] = v;
      }
      return out;
    };
    const settings: Settings = {
      score: scoreOf(prefs.score), friendScore: scoreOf(prefs.fScore),
      maxTurns: prefs.maxTurns, costCap: prefs.costCap, roll: prefs.roll, startNp: prefs.append2 ? 2000 : 0, reload: prefs.append5 ? 3 : 0,
      friendAppendNp: (prefs.fAppend2 ?? true) ? 2000 : 0, friendReload: (prefs.fAppend5 ?? true) ? 3 : 0,
      // 프렌드 예장 칸은 하나: 인연 예장이거나, 시작 NP 예장(np:수치)이거나
      friendCe: fNo && fNo !== 'np' && fNo !== 'auto' ? { no: Number(fNo), mlb: fMlb === '1' } : null, friendCeAuto: fNo === 'auto', friendStartNp: fNo === 'np' ? Number(fMlb) : 0, topN: 10, teapot: prefs.teapot,
      // 마술예장: -1 자동 선택, 0 사용 안 함, 그 외 지정
      mc: data.mcs.find((m) => m.id === prefs.mc) ?? null, mcAuto: prefs.mc === -1 ? data.mcs : undefined, orderChange: prefs.oc, commandSpell: !!prefs.cs, npPlan: prefs.npPlan ?? true, cardNp: prefs.cardNp, lv1: prefs.lv1, allowDup: prefs.allowDup,
      // 퀘스트가 편성을 강제하는 서번트는 검색 쪽에서 더한다(막간의 이야기·강화 퀘스트라고 해서 그 서번트가 필수인 것은 아니다)
      must: prefs.must ?? [],
      // 이벤트 예장: 5성 예장(코스트 12)으로 본다
      eventCe: (prefs.evNp || prefs.evPower) ? { np: prefs.evNp ?? 0, power: prefs.evPower ?? 0, count: prefs.evCount ?? 1, cost: 12 } : null,
    };
    const req = { pool: buildPool(data, roster, prefs), servants: data.servants, stock: ceStock, quest, rel: data.rel, settings };
    ws.forEach((w, index) => w.postMessage({ type: 'cores', req, shard: { index, count } }));
  };
  useEffect(() => stopWorkers, []);

  const ownedCount = useMemo(() => Object.values(roster).filter((r) => r.owned).length, [roster]);
  const minTurns = quest ? suggestTurns(quest) : 0;

  return (
    <main>
      <section className="card">
        <h2>1. 퀘스트</h2>
        <form className="row" onSubmit={(e) => { e.preventDefault(); doSearch(); }}>
          <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="예: 2부 6장 4절 2번째 배틀 / 아발론 프리 / 솔즈베리" />
          <button className="primary" type="submit">찾기</button>
        </form>
        {note && <p className="muted">{note}</p>}
        {cands.length > 1 && (
          <ul className="cands">
            {cands.map((c) => (
              <li key={`${c.quest.id}-${c.phase}`}>
                <button className={picked === c ? 'on' : ''} onClick={() => void pick(c)}>
                  {c.label} <span className="muted">· AP {c.quest.ap}{c.quest.lv ? ` · Lv ${c.quest.lv}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {loading && <p className="muted">적 구성을 불러오는 중…</p>}
        {quest && picked && (
          <div className="quest">
            <h3>{quest.name}</h3>
            <p className="muted">
              기본 인연 포인트 <b>{quest.bond.toLocaleString()}</b> · AP {picked.quest.ap} ·{' '}
              <a href={`https://namu.wiki/Search?q=${encodeURIComponent(namuQuery(picked.war.longName))}`} target="_blank" rel="noreferrer">나무위키에서 이 장 찾기</a>
            </p>
            {picked.war.soon !== undefined && (
              <p className="warn">
                한국 서버에 아직 열리지 않은 이벤트입니다(예상 {new Date(picked.war.soon * 1000).toLocaleDateString('ko-KR')}경). 일본 서버 데이터라 이름이 일본어로 나오고, 한국 서버에서는 내용이나 일정이 달라질 수 있습니다.
              </p>
            )}
            {quest.warnings.map((w) => <p key={w} className="warn">{w}</p>)}
            {quest.waves.map((wave, i) => (
              <div key={i} className="wave">
                <span className="tag">{i + 1}웨이브</span>
                {wave.map((e, k) => (
                  <span key={k} className={`enemy cls-${e.cls}`} title={e.deckId > (quest.waveSize?.[i] ?? 3) ? '먼저 나온 적이 쓰러진 다음 턴에 등장' : undefined}>
                    <b>{e.deckId > (quest.waveSize?.[i] ?? 3) ? '대기: ' : ''}{e.name}</b> {CLASS_KO[e.cls] ?? e.cls}·{ATTR_KO[e.attr] ?? e.attr}
                    <span className="hp">{e.bars.map((h) => h.toLocaleString()).join(' / ')}</span>
                  </span>
                ))}
                {[...wave.flatMap((e) => e.call ?? []), ...(quest.waveCalls?.[i] ?? [])]
                  .filter((e, k, all) => all.findIndex((x) => x.name === e.name && x.cls === e.cls && x.bars[0] === e.bars[0]) === k)
                  .map((e, k) => (
                    <span key={`c${k}`} className={`enemy call cls-${e.cls}`} title="빈자리가 생기면 반복 소환되는 증원">
                      <b>증원: {e.name}</b> {CLASS_KO[e.cls] ?? e.cls}·{ATTR_KO[e.attr] ?? e.attr}
                      <span className="hp">{e.bars.map((h) => h.toLocaleString()).join(' / ')}</span>
                    </span>
                  ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>2. 조건</h2>
        <div className="grid">
          <label>서번트 풀
            <select value={prefs.poolMode} onChange={(e) => set('poolMode', e.target.value as Prefs['poolMode'])}>
              <option value="all">한국 서버 전체 서번트</option>
              <option value="owned">내 보유 서번트만 ({ownedCount}기)</option>
            </select>
          </label>
          <label>턴 제한{minTurns ? ` (권장 ${minTurns}턴 이상)` : ''}
            <input type="number" min={1} max={15} value={prefs.maxTurns} onChange={(e) => set('maxTurns', Number(e.target.value) || 1)} />
          </label>
          <label>파티 코스트 상한
            <input type="number" min={30} max={130} value={prefs.costCap} onChange={(e) => set('costCap', Number(e.target.value) || 112)} />
          </label>
          <label>대미지 난수
            <select value={prefs.roll} onChange={(e) => set('roll', Number(e.target.value))}>
              <option value={0.9}>최저(0.9) — 확정 클리어</option>
              <option value={1}>평균(1.0)</option>
            </select>
          </label>
          <label>프렌드 서포트의 예장
            <select value={prefs.friendCe} onChange={(e) => set('friendCe', e.target.value)}>
              <option value="">인연 예장 없음</option>
              <option value="auto">자동 선택 (가장 도움이 되는 인연 예장)</option>
              {data.ces.filter((c) => c.kind === 'pct').map((c) => (
                <option key={c.no} value={`${c.no}:1`}>{c.name} (최대해방 {(c.sup ?? c.val)[1] / 10}%)</option>
              ))}
              <option value={`${data.ces.find((c) => c.kind === 'flat')?.no}:1`}>영령초상 (+50)</option>
              <option value="np:5000">시작 NP 50% 예장 (인연 효과 없음)</option>
              <option value="np:8000">시작 NP 80% 예장 (인연 효과 없음)</option>
              <option value="np:10000">시작 NP 100% 예장 — 칼레이도스코프 최대해방 (인연 효과 없음)</option>
            </select>
          </label>
          <label>포우 ATK 강화
            <select value={prefs.fou} onChange={(e) => set('fou', Number(e.target.value))}>
              <option value={0}>없음</option><option value={1000}>+1000</option><option value={2000}>+2000</option>
            </select>
          </label>
          <label>마술예장 (레벨 10 기준)
            <select value={prefs.mc} onChange={(e) => set('mc', Number(e.target.value))}>
              <option value={-1}>자동 선택 (가장 도움이 되는 것)</option>
              <option value={0}>사용 안 함</option>
              {data.mcs.map((m) => <option key={m.id} value={m.id}>{m.name.replace(/^마술예장 /, '')}</option>)}
            </select>
          </label>
          <label>평타로 얻는 NP 가정 (보구를 안 쓴 턴마다)
            <select value={prefs.cardNp} onChange={(e) => set('cardNp', Number(e.target.value))}>
              <option value={0}>없음 — 확정 클리어</option><option value={500}>5%</option><option value={1000}>10%</option>
            </select>
          </label>
          <label>이벤트 예장 (딜러가 끼는 차지·특공 예장)
            <span className="evrow">
              <select value={prefs.evNp ?? 0} onChange={(e) => set('evNp', Number(e.target.value))}>
                <option value={0}>차지 0%</option><option value={3000}>차지 30%</option><option value={5000}>차지 50%</option>
              </select>
              <select value={prefs.evPower ?? 0} onChange={(e) => set('evPower', Number(e.target.value))}>
                <option value={0}>특공 0%</option><option value={1000}>특공 100%</option><option value={2000}>특공 200%</option>
              </select>
              <select value={prefs.evCount ?? 1} onChange={(e) => set('evCount', Number(e.target.value))} disabled={!prefs.evNp && !prefs.evPower}>
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n}장</option>)}
              </select>
            </span>
          </label>
          <label>찻주전자
            <select value={prefs.teapot} onChange={(e) => set('teapot', Number(e.target.value))}>
              <option value={1}>사용 안 함</option><option value={2}>인연 2배</option><option value={3}>인연 3배</option>
            </select>
          </label>
          <label title="클래스 스코어의 카드 위력 UP·보구 위력 UP 칸을 대미지에 반영합니다. 계정 데이터를 가져오면 실제로 연 칸 기준으로 계산할 수 있습니다. 크리티컬·스타 칸은 평타에만 영향이 있어 계산하지 않습니다.">클래스 스코어 (내 서번트)
            <select value={prefs.score ?? 'none'} onChange={(e) => set('score', e.target.value as Prefs['score'])}>
              <option value="none">적용 안 함</option>
              <option value="full">전부 개방 (카드 +20%, 보구 +10%)</option>
              {prefs.scoreOwn && <option value="own">가져온 내 데이터</option>}
            </select>
          </label>
          <label title="프렌드 서번트에는 그 프렌드의 클래스 스코어가 적용됩니다. 빌리는 상대에 맞게 고르세요.">클래스 스코어 (프렌드)
            <select value={prefs.fScore ?? 'none'} onChange={(e) => set('fScore', e.target.value as Prefs['fScore'])}>
              <option value="none">적용 안 함</option>
              <option value="full">전부 개방</option>
            </select>
          </label>
          <label className="check" title="2부 6장의 일부 전투처럼 출전 서번트 전원(프렌드 포함)의 레벨이 1이 되는 기믹. 스킬·보구 레벨은 그대로이고 ATK만 레벨 1 수치로 계산합니다.">
            <input type="checkbox" checked={prefs.lv1} onChange={(e) => set('lv1', e.target.checked)} /> 전원 레벨 1 고정 (2부 6장 기믹)
          </label>
          <label className="check" title="프렌드로 내 파티에 있는 것과 같은 서번트를 빌리는 편성(예: 같은 딜러 2기, 같은 서포터 2기)을 후보에 넣습니다.">
            <input type="checkbox" checked={prefs.allowDup} onChange={(e) => set('allowDup', e.target.checked)} /> 동일 서번트 편성 허용 (프렌드로 같은 서번트 빌리기)
          </label>
          <label className="check" title="서포터 하나의 스킬을 다 쓴 뒤 후열의 다른 서포터와 바꾸는 편성도 찾습니다. 오더 체인지가 있는 마술예장(칼데아 전투복, 결전용 칼데아 제복)을 쓸 때만 적용됩니다. 계산이 조금 더 오래 걸립니다.">
            <input type="checkbox" checked={!!prefs.oc} onChange={(e) => set('oc', e.target.checked)} /> 오더 체인지 사용 (전투복·결전용 제복)
          </label>
          <label className="check" title="령주 1획으로 아군 한 명의 NP를 100% 채우는 것을 허용합니다. 령주 없이 깨지는 편성에는 쓰지 않고, 령주를 써야만 되는 편성에는 결과에 표시합니다. 령주는 하루에 1획씩 회복됩니다.">
            <input type="checkbox" checked={!!prefs.cs} onChange={(e) => set('cs', e.target.checked)} /> 령주 1획 사용 (NP +100%)
          </label>
          <label className="check" title="정해진 운용으로 안 깨지는 편성은 턴마다 누가 보구를 쏠지 바꿔 가며 다시 찾습니다. 서포터의 보구(제갈공명·알트리아 캐스터 같은 버프·디버프 보구 포함)를 쓰는 경우와 한 턴에 보구 2~3개를 함께 쏘는 경우가 여기에 들어갑니다. 끄면 계산이 2~3배 빨라지지만 찾는 편성이 줄어듭니다.">
            <input type="checkbox" checked={prefs.npPlan ?? true} onChange={(e) => set('npPlan', e.target.checked)} /> 보구 조합 탐색 (서포터 보구 · 한 턴에 보구 여러 개)
          </label>
          <label className="check" title="등록한 내 서번트의 스킬을 전부 레벨 10으로 보고 계산합니다. 지금은 안 되지만 스킬을 올리면 되는 편성을 찾을 때 켭니다. 결과에 어떤 서번트의 스킬을 올려야 하는지 표시됩니다."><input type="checkbox" checked={!!prefs.maxSkill} onChange={(e) => set('maxSkill', e.target.checked)} /> 육성 가정: 내 서번트 스킬 전부 Lv10</label>
          <label className="check" title="등록한 내 서번트가 어펜드 스킬 2(시작 NP 20%)와 어펜드 스킬 5 Lv10(쿨타임 -1)을 연 것으로 보고 계산합니다. 결과에 어떤 서번트의 어펜드를 열어야 하는지 표시됩니다."><input type="checkbox" checked={!!prefs.maxAppend} onChange={(e) => set('maxAppend', e.target.checked)} /> 육성 가정: 내 서번트 어펜드 2·5 개방</label>
          <label className="check"><input type="checkbox" checked={prefs.append2} onChange={(e) => set('append2', e.target.checked)} /> 미등록 서번트: 어펜드 스킬 2 (시작 NP 20%)</label>
          <label className="check" title="스킬 재장전 Lv10: 스킬마다 처음 쓸 때 쿨타임이 1 줄어듭니다. 로그인 데이터로 가져온 서번트는 실제 레벨을 쓰고, 등록하지 않은 서번트와 프렌드에만 이 설정을 적용합니다."><input type="checkbox" checked={prefs.append5 ?? true} onChange={(e) => set('append5', e.target.checked)} /> 미등록 서번트: 어펜드 스킬 5 (쿨타임 -1)</label>
          <label className="check" title="프렌드로 빌리는 서번트가 어펜드 스킬 2를 열었는지. 빌리는 상대에 따라 다르니 실제 프렌드에 맞게 고르세요."><input type="checkbox" checked={prefs.fAppend2 ?? true} onChange={(e) => set('fAppend2', e.target.checked)} /> 프렌드: 어펜드 스킬 2 (시작 NP 20%)</label>
          <label className="check" title="프렌드로 빌리는 서번트가 어펜드 스킬 5를 Lv10까지 올렸는지."><input type="checkbox" checked={prefs.fAppend5 ?? true} onChange={(e) => set('fAppend5', e.target.checked)} /> 프렌드: 어펜드 스킬 5 (쿨타임 -1)</label>
        </div>
        <MustPicker
          servants={prefs.poolMode === 'owned' ? data.servants.filter((s) => roster[s.no]?.owned) : data.servants}
          all={data.servants} value={prefs.must ?? []} onChange={(v) => set('must', v)}
        />
        {prefs.poolMode === 'all' && (
          <div className="row muted small">
            미등록 서번트의 보구 레벨 가정: ★5
            <NumSel v={prefs.np5} on={(v) => set('np5', v)} /> ★4 <NumSel v={prefs.np4} on={(v) => set('np4', v)} /> ★3 이하 <NumSel v={prefs.np3} on={(v) => set('np3', v)} />
            (내 서번트 탭에 등록한 서번트는 등록한 수치를 씁니다)
          </div>
        )}
        <div className="row">
          <button className="primary" disabled={!quest || !quest.waves.length || progress !== null} onClick={run}>최적 파티 찾기</button>
          {progress !== null && <progress value={progress} max={1} />}
        </div>
        {err && <p className="error">{err}</p>}
      </section>

      {output && quest && (
        <section className="card">
          <h2>3. 추천 파티</h2>
          <p className="muted small">전투 조합 {output.simulated.toLocaleString()}개를 계산했고, 그중 {prefs.maxTurns}턴 안에 클리어되는 조합은 {output.feasible.toLocaleString()}개입니다.
            {output.autoFriendCe !== undefined && (output.autoFriendCe ? ` 프렌드 예장 자동 선택: "${output.autoFriendCe}"(최대해방)을 낀 프렌드를 빌릴 때 인연이 가장 큽니다.` : ' 프렌드 예장 자동 선택: 도움이 되는 인연 예장이 없었습니다.')}
            {output.autoMc !== undefined && (output.autoMc ? ` 마술예장 자동 선택: 예장 없이 안 되는 편성에는 "${output.autoMc}"을(를) 썼습니다.` : ' 마술예장 자동 선택: 도움이 되는 예장이 없었습니다.')}</p>
          {output.note && <div className="warn"><p>{output.note}</p></div>}
          {!output.results.length && !output.note && (
            <div className="warn">
              <p>인연 예장만 끼고 {prefs.maxTurns}턴 안에 보구로 정리할 수 있는 조합을 찾지 못했습니다.</p>
              <p className="small">
                이 계산기는 보구만 계산하고 시작 NP를 주는 예장을 끼지 않는다고 봅니다. 실제로는 평타로 마무리되는 전투도 여기서는 실패로 나옵니다. 시도해 볼 것:
                {prefs.mc === 0 && ' 마술예장을 자동 선택으로 ·'}
                {!prefs.friendCe.startsWith('np:') && ' 프렌드 예장을 시작 NP 예장으로(프렌드가 칼레이도스코프를 낀 경우) ·'}
                {!prefs.oc && ' 오더 체인지 켜기 ·'}
                {!prefs.cs && ' 령주 1획 사용 켜기 ·'}
                {' '}턴 제한 늘리기 · 대미지 난수를 평균으로 · 평타 NP 가정 올리기
                {prefs.poolMode === 'owned' && ' · 서번트 풀을 전체로 바꿔 가능한 편성 확인'}
              </p>
              {output.bestFail && <p>가장 근접한 조합: {output.bestFail.names.join(' + ')} — 적 {output.bestFail.sim.total}기 중 {output.bestFail.sim.killed}기 처치{output.bestFail.sim.bars > output.bestFail.sim.total ? `, HP 게이지 ${output.bestFail.sim.bars}줄 중 ${output.bestFail.sim.broken}줄 파괴` : ''}</p>}
            </div>
          )}
          {output.results.map((r, i) => <Result key={i} r={r} rank={i + 1} base={quest.bond} raise={raiseList(r, roster, prefs)} />)}
        </section>
      )}
    </main>
  );
}

/** 반드시 파티에 넣을 서번트를 고른다. 이름을 입력하면 후보가 뜨고, 고르면 칩으로 추가된다. */
function MustPicker({ servants, all, value, onChange }: { servants: Servant[]; all: Servant[]; value: number[]; onChange: (v: number[]) => void }) {
  const [text, setText] = useState('');
  const label = (s: Servant) => `${s.name} (★${s.rarity} ${CLASS_KO[s.cls] ?? s.cls} · No.${s.no})`;
  const q = text.trim();
  const hits = q ? servants.filter((s) => !value.includes(s.no) && s.name.includes(q)).slice(0, 8) : [];
  const add = (no: number) => { onChange([...value, no]); setText(''); };
  return (
    <div className="must">
      <div className="row">
        <span className="small">반드시 포함할 서번트</span>
        {value.map((no) => {
          const s = all.find((x) => x.no === no);
          return (
            <span key={no} className="ce need">
              {s ? s.name : `No.${no}`}{s && !servants.includes(s) ? ' (풀에 없음)' : ''}
              <button className="x" title="빼기" onClick={() => onChange(value.filter((v) => v !== no))}>×</button>
            </span>
          );
        })}
        <input className="grow" placeholder={value.length >= 5 ? '최대 5기' : '이름으로 검색해 추가 (예: 로우히)'} value={text} disabled={value.length >= 5}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && hits.length) { e.preventDefault(); add(hits[0].no); } }} />
      </div>
      {hits.length > 0 && (
        <div className="row">
          {hits.map((s) => <button key={s.no} onClick={() => add(s.no)}>{label(s)}</button>)}
        </div>
      )}
      {value.length > 0 && <p className="muted small">고른 서번트는 내 파티에 반드시 들어갑니다. 딜러나 서포터로 쓰이지 않으면 인연을 받는 자리에 넣습니다.</p>}
    </div>
  );
}

function NumSel({ v, on }: { v: number; on: (v: number) => void }) {
  return <select value={v} onChange={(e) => on(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select>;
}

function Face({ src, name }: { src: string; name: string }) {
  return src ? <img className="face" src={src} alt="" loading="lazy" /> : <span className="face ph">{name.slice(0, 1)}</span>;
}

/** 육성 가정으로 계산했을 때, 이 편성의 딜러·서포터 중 실제 육성이 가정에 못 미치는 서번트와 올려야 할 것 */
function raiseList(r: PartyResult, roster: Roster, prefs: Prefs): { name: string; todo: string[] }[] {
  if (!prefs.maxSkill && !prefs.maxAppend) return [];
  const out: { name: string; todo: string[] }[] = [];
  for (const m of [...r.front, ...r.back]) {
    if (!m.svt || m.friend || m.role === 'filler') continue;
    const ro = roster[m.svt.no];
    if (!ro?.owned) continue;
    const todo: string[] = [];
    if (prefs.maxSkill) {
      const lv = ro.skills ?? [ro.skillLv, ro.skillLv, ro.skillLv];
      if (lv.some((x) => x < 10)) todo.push(`스킬 ${lv.join('/')} → 10/10/10`);
    }
    if (prefs.maxAppend) {
      if ((ro.startNp ?? (prefs.append2 ? 2000 : 0)) < 2000) todo.push('어펜드 2 (시작 NP 20%)');
      if ((ro.reload ?? ((prefs.append5 ?? true) ? 3 : 0)) < 3) todo.push('어펜드 5 Lv10');
    }
    if (todo.length) out.push({ name: m.svt.name, todo });
  }
  return out;
}

function Result({ r, rank, base, raise }: { r: PartyResult; rank: number; base: number; raise: { name: string; todo: string[] }[] }) {
  const [open, setOpen] = useState(rank === 1);
  // 게임의 편성 화면처럼 한 칸에 서번트와 그 서번트가 끼는 예장을 함께 보여 준다
  const member = (m: PartyResult['front'][0], k: number, pos: number) => (
    <div key={k} className={`slot ${m.friend ? 'friend' : ''}`}>
      <div className="pos">{pos}</div>
      {m.svt ? <Face src={m.svt.face} name={m.svt.name} /> : <span className="face ph">?</span>}
      <div className="mname">{m.svt ? m.svt.name : '프렌드 (자유)'}</div>
      <div className="small muted">
        {m.npc ? `지정 서포트${m.role === 'dealer' ? ' (딜러)' : m.role === 'filler' ? ' (전투에 쓰지 않음)' : ''}` : m.friend ? (m.svt ? `프렌드 ${m.role === 'dealer' ? '(딜러)' : '서포트'}` : '아무 서번트나') : ROLE_KO[m.role]}
        {m.sub && <b className="sub"> · 교체 투입</b>}{m.swapOut && <b className="sub"> · 오더 체인지로 나감</b>}
      </div>
      {m.svt && !m.friend && <div className="small"><b className={m.counted ? 'bond' : 'muted'}>{m.counted ? `+${m.bond.toLocaleString()}` : '인연 MAX'}</b></div>}
      <div className={`slotce ${!m.friend && m.ce && ((r.atkCe && m.ce.ce.no === r.atkCe.ce.no) || (r.eventCe && m.ce.ce.no < 0)) ? 'need' : ''}`}>
        {m.ce ? (
          <>
            <Face src={m.ce.ce.face} name={m.ce.ce.name} />
            <span className="small">{m.ce.ce.name}{m.ce.ce.rarity === 5 && !m.ce.mlb ? ' (미해방)' : ''}</span>
          </>
        ) : <span className="small muted">{m.friend && !m.npc ? '인연 예장 없음' : '예장 없음'}</span>}
      </div>
    </div>
  );
  return (
    <article className="result">
      <div className="rhead" onClick={() => setOpen(!open)}>
        <span className="rank">#{rank}</span>
        <span className="total">인연 합계 {r.total.toLocaleString()}</span>
        <span className="muted">기본치의 {(r.total / base).toFixed(2)}배 · {r.turns}턴 · 코스트 {r.cost}</span>
        <span className="toggle">{open ? '접기' : '자세히'}</span>
      </div>
      <div className="formation">
        <div className="row3"><span className="tag">전열</span>{r.front.map((m, k) => member(m, k, k + 1))}</div>
        <div className="row3"><span className="tag">후열</span>{r.back.map((m, k) => member(m, k, k + 4))}</div>
      </div>
      <div className="line">
        <span className="tag">마술예장</span>
        {r.mc ? (
          <>
            <span className="ce need mc">{r.mc.face && <img className="mcicon" src={r.mc.face} alt="" loading="lazy" />}{r.mc.name.replace(/^마술예장 /, '')}</span>
            <span className="small muted">이 예장의 스킬을 써야 클리어됩니다 (레벨 10 기준)</span>
          </>
        ) : <span className="small muted">아무거나 (마술예장 스킬 없이 클리어)</span>}
        {r.cs && <span className="ce need">령주 1획 사용 (NP +100%)</span>}
      </div>
      {raise.length > 0 && (
        <div className="line">
          <span className="tag">육성 필요</span>
          <span className="small">{raise.map((x) => `${x.name}: ${x.todo.join(', ')}`).join(' · ')}</span>
          <span className="small muted">육성 가정으로 계산한 편성입니다. 여기 적힌 것이 지금 계정과 다른 부분입니다.</span>
        </div>
      )}
      {open && (
        <div className="log">
          <p className="small muted">
            예장의 인연 효과는 누가 껴도 같습니다(파티 전체 적용).
            {r.eventCe ? ` 단, "${r.eventCe.name}"은(는) ${r.eventCe.dealers.join(', ')}에게 끼워야 클리어됩니다(인연 효과 없음, 코스트 12로 계산).` : r.atkCe ? ` 단, "${r.atkCe.ce.name}" 예장은 ${r.atkCe.dealer}에게 끼우세요. 이 예장의 ATK +${r.atkCe.atk.toLocaleString()}까지 더해야 클리어됩니다.` : ' ATK가 붙은 예장은 딜러에게 끼우면 여유가 생깁니다.'}
            {' '}스킬 순서는 시뮬레이터가 고른 한 가지 예시입니다.
          </p>
          {r.sim.log.map((t) => (
            <div key={t.turn} className="turn">
              <b>{t.turn}턴</b> <span className="muted small">({t.wave}웨이브)</span>
              {t.events?.map((e, k) => <div key={`e${k}`} className="np"><b className="sub">{e}</b></div>)}
              {t.skills.length > 0 && <ol>{t.skills.map((s, k) => <li key={k}>{s.who} — {s.skill}{s.target ? ` → ${s.target}` : ''}</li>)}</ol>}
              {t.nps.map((n, k) => (
                <div key={k} className="np">
                  보구: {n.who} 「{n.np}」
                  <span className="small muted"> {n.hits.length ? <>{n.hits.map((h) => `${h.enemy} ${h.dmg.toLocaleString()}/${h.hp.toLocaleString()}${h.kill ? ' 처치' : ''}`).join(' · ')} · NP 회수 {(n.refund / 100).toFixed(0)}%</> : '버프·디버프 보구 (대미지 없음)'}</span>
                </div>
              ))}
              {!t.nps.length && <div className="small muted">보구 없음</div>}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

// ------------------------------------------------------------------ 내 서번트

const NEW_ENTRY: RosterEntry = { owned: true, npLv: 1, lv: 'max', skillLv: 10, bondMax: false, bond15: false };

function RosterTab({ data, roster, setRoster, onLogin }: {
  data: Data; roster: Roster; setRoster: (v: Roster | ((p: Roster) => Roster)) => void; onLogin: (f: File) => Promise<string>;
}) {
  const loginFile = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const doLogin = async (f: File) => {
    try { setMsg({ ok: true, text: await onLogin(f) }); setOnlyOwned(true); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };
  const [q, setQ] = useState('');
  const [cls, setCls] = useState('');
  const [onlyOwned, setOnlyOwned] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const classes = useMemo(() => [...new Set(data.servants.map((s) => s.cls))], [data]);
  const list = data.servants.filter((s) =>
    (!q || s.name.includes(q)) && (!cls || s.cls === cls) && (!onlyOwned || roster[s.no]?.owned));
  const upd = (no: number, patch: Partial<RosterEntry>) =>
    setRoster((r) => ({ ...r, [no]: { ...NEW_ENTRY, ...r[no], ...patch } }));
  const exportJson = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(roster)], { type: 'application/json' }));
    a.download = 'fgo-bond-roster.json';
    a.click();
  };
  const importJson = async (f: File) => {
    try { setRoster(JSON.parse(await f.text())); } catch { alert('파일을 읽지 못했습니다.'); }
  };
  return (
    <main>
      <section className="card">
        <h2>내 서번트</h2>
        <p className="muted small">보유한 서번트를 체크하세요. "인연 MAX"로 표시한 서번트는 전투에는 쓰지만 인연 합계에서 빼고, 인연을 받는 자리에는 넣지 않습니다. "인연 15"로 표시한 서번트는 파티에 있으면 다른 파티원 전원의 인연이 25% 늘어납니다. 이 브라우저에 저장됩니다.</p>
        <div className="row">
          <button className="primary" onClick={() => loginFile.current?.click()}>계정 데이터 가져오기</button>
          <input ref={loginFile} type="file" accept=".txt,.json,application/json,text/plain" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void doLogin(f); }} />
          <span className="muted small">게임 로그인 응답 파일(예: fgo_login_kr.txt)이나 Chaldea 앱의 백업 파일(chaldea-userdata-….json)을 고르면 보유 서번트, 레벨·보구·스킬·어펜드, 인연 레벨, 인연 예장이 한 번에 채워집니다. 파일은 이 브라우저 안에서만 읽고, 기존 등록 내용은 덮어씁니다. Chaldea 백업에는 레벨과 코스트 상한이 없어서 레벨은 재림 단계로 추정합니다.</span>
        </div>
        {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
        <div className="row">
          <input className="grow" placeholder="이름 검색" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={cls} onChange={(e) => setCls(e.target.value)}>
            <option value="">모든 클래스</option>
            {classes.map((c) => <option key={c} value={c}>{CLASS_KO[c] ?? c}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={onlyOwned} onChange={(e) => setOnlyOwned(e.target.checked)} /> 보유만</label>
          <button onClick={() => setRoster((r) => { const n = { ...r }; for (const s of list) n[s.no] = { ...NEW_ENTRY, ...n[s.no], owned: true }; return n; })}>표시된 서번트 모두 보유</button>
          <button onClick={exportJson}>백업 내보내기</button>
          <button onClick={() => file.current?.click()}>백업 가져오기</button>
          <input ref={file} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && void importJson(e.target.files[0])} />
        </div>
        <div className="roster">
          {list.map((s) => {
            const r = roster[s.no];
            return (
              <div key={s.no} className={`rrow ${r?.owned ? 'owned' : ''}`}>
                <label className="rname">
                  <input type="checkbox" checked={!!r?.owned} onChange={(e) => upd(s.no, { owned: e.target.checked })} />
                  <Face src={s.face} name={s.name} />
                  <span>{s.name}<br /><span className="small muted">★{s.rarity} {CLASS_KO[s.cls] ?? s.cls}</span></span>
                </label>
                {r?.owned && (
                  <div className="rctl small">
                    <label>보구 <NumSel v={r.npLv} on={(v) => upd(s.no, { npLv: v })} /></label>
                    {r.atk !== undefined && (
                      <span className="imported">
                        Lv {r.level} · ATK {r.atk.toLocaleString()}{r.skills ? ` · 스킬 ${r.skills.join('/')}` : ''} · 시작 NP {(r.startNp ?? 0) / 100}%{r.reload ? ` · 재장전 ${r.reload}회` : ''}{r.bond !== undefined ? ` · 인연 ${r.bond}` : ''}
                      </span>
                    )}
                    <label>레벨
                      <select value={r.lv} onChange={(e) => upd(s.no, { lv: e.target.value as RosterEntry['lv'], atk: undefined, level: undefined })}>
                        <option value="max">기본 최대</option><option value="100">100</option><option value="120">120</option>
                      </select>
                    </label>
                    <label>스킬
                      <select value={r.skillLv} onChange={(e) => upd(s.no, { skillLv: Number(e.target.value), skills: undefined })}>
                        {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </label>
                    {s.asc && (
                      <label title="이 서번트는 영기재림 단계(모습)에 따라 특성이 달라져 조건부 인연 예장 적용 여부가 바뀝니다">모습
                        <select value={r.asc ?? 4} onChange={(e) => upd(s.no, { asc: Number(e.target.value) })}>
                          {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>재림 {n}단계</option>)}
                        </select>
                      </label>
                    )}
                    <label className="check"><input type="checkbox" checked={r.bondMax || !!r.bond15} disabled={!!r.bond15} onChange={(e) => upd(s.no, { bondMax: e.target.checked })} /> 인연 MAX</label>
                    <label className="check"><input type="checkbox" checked={!!r.bond15} onChange={(e) => upd(s.no, { bond15: e.target.checked })} /> 인연 15</label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

// ------------------------------------------------------------------ 인연 예장

function CETab({ data, stock, setStock }: { data: Data; stock: Stock; setStock: (v: Stock | ((p: Stock) => Stock)) => void }) {
  const upd = (no: number, patch: Partial<{ count: number; mlb: boolean }>) =>
    setStock((s) => ({ ...s, [no]: { ...(s[no] ?? { count: 1, mlb: true }), ...patch } }));
  const desc = (c: BondCE, mlb: boolean) => {
    const v = c.val[mlb ? 1 : 0];
    return c.kind === 'flat' ? `+${v}` : `+${v / 10}%`;
  };
  const groups: [string, BondCE[]][] = [
    ['조건부 (조건에 맞는 파티원 전원)', data.ces.filter((c) => c.kind === 'pct' && c.cond.length > 0)],
    ['조건 없음 %', data.ces.filter((c) => c.kind === 'pct' && !c.cond.length)],
    ['고정치', data.ces.filter((c) => c.kind === 'flat')],
  ];
  return (
    <main>
      <section className="card">
        <h2>인연 예장 보유 현황</h2>
        <p className="muted small">기본값은 모든 예장 1장씩, ★5는 최대해방입니다. 가지고 있지 않은 예장은 0으로 바꾸세요. 이벤트 기간 한정 효과는 제외했습니다.</p>
        {groups.map(([title, list]) => (
          <div key={title}>
            <h3>{title}</h3>
            <div className="celist">
              {list.map((c) => {
                const s: Stock[number] = stock[c.no] ?? { count: 1, mlb: true };
                const ceAtk = s.atk ?? c.atk;
                return (
                  <div key={c.no} className="cerow">
                    <Face src={c.face} name={c.name} />
                    <span className="grow">{c.name} <span className="muted small">★{c.rarity} · 코스트 {c.cost} · {desc(c, s.mlb)}{ceAtk ? ` · ATK +${ceAtk.toLocaleString()}` : ''}</span></span>
                    <label className="small">보유 <input type="number" min={0} max={5} value={s.count} onChange={(e) => upd(c.no, { count: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })} /></label>
                    {c.val[0] !== c.val[1] && <label className="check small"><input type="checkbox" checked={s.mlb} onChange={(e) => upd(c.no, { mlb: e.target.checked })} /> 최대해방</label>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
