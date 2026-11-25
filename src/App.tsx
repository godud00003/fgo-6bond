import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchQuest, namuQuery, resolveQuest, type Candidate } from './engine/quest.ts';
import type { CEStock, PartyResult, PoolEntry, SearchOutput, Settings } from './engine/search.ts';
import type { BondCE, QuestData, Rel, Servant, War } from './engine/types.ts';

interface Data { servants: Servant[]; ces: BondCE[]; wars: War[]; names: Record<string, string>; rel: Rel }
interface RosterEntry { owned: boolean; npLv: number; lv: 'max' | '100' | '120'; skillLv: number; bondMax: boolean }
type Roster = Record<number, RosterEntry>;
type Stock = Record<number, { count: number; mlb: boolean }>;
interface Prefs {
  poolMode: 'all' | 'owned'; maxTurns: number; costCap: number; roll: number; append2: boolean; fou: number;
  friendCe: string; np5: number; np4: number; np3: number;
}
const DEFAULT_PREFS: Prefs = {
  poolMode: 'all', maxTurns: 3, costCap: 115, roll: 0.9, append2: true, fou: 1000, friendCe: '', np5: 1, np4: 2, np3: 5,
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
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'party' | 'roster' | 'ce'>('party');
  const [roster, setRoster] = usePersist<Roster>('fgo-bond.roster', {});
  const [stock, setStock] = usePersist<Stock>('fgo-bond.stock', {});
  const [prefs, setPrefs] = usePersist<Prefs>('fgo-bond.prefs', DEFAULT_PREFS);

  useEffect(() => {
    const get = (f: string) => fetch(`${import.meta.env.BASE_URL}data/${f}`).then((r) => {
      if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
      return r.json();
    });
    Promise.all(['servants.json', 'ces.json', 'wars.json', 'names.json', 'rel.json'].map(get))
      .then(([servants, ces, wars, names, rel]) => setData({ servants, ces, wars, names, rel }))
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="app"><p className="error">데이터를 불러오지 못했습니다: {error}</p></div>;
  if (!data) return <div className="app"><p className="muted">데이터를 불러오는 중…</p></div>;
  const owned = Object.values(roster).filter((r) => r.owned).length;

  return (
    <div className="app">
      <header>
        <h1>FGO 인연 파티 최적화</h1>
        <p className="muted">한국 서버 기준 · 인연 예장을 끼고도 클리어되는 파티 중 인연 포인트가 가장 많은 구성을 찾습니다.</p>
        <nav>
          <button className={tab === 'party' ? 'on' : ''} onClick={() => setTab('party')}>파티 추천</button>
          <button className={tab === 'roster' ? 'on' : ''} onClick={() => setTab('roster')}>내 서번트 ({owned})</button>
          <button className={tab === 'ce' ? 'on' : ''} onClick={() => setTab('ce')}>인연 예장</button>
        </nav>
      </header>
      <div hidden={tab !== 'party'}><PartyTab data={data} roster={roster} stock={stock} prefs={prefs} setPrefs={setPrefs} /></div>
      {tab === 'roster' && <RosterTab data={data} roster={roster} setRoster={setRoster} />}
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
    out.push({
      svt, npLv: useOwn ? r.npLv : npDefault, skillLv: useOwn ? r.skillLv : 10,
      atk: svt.atk[useOwn ? r.lv : 'max'] + prefs.fou, weight: r?.bondMax ? 0 : 1,
    });
  }
  return out;
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
  const worker = useRef<Worker | null>(null);
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => ({ ...p, [k]: v }));

  const pick = async (c: Candidate) => {
    setPicked(c); setQuest(null); setOutput(null); setErr(''); setLoading(true);
    try {
      const q = await fetchQuest(c.quest.id, c.phase, data.names, c.label);
      setQuest(q);
      const minTurns = q.waves.reduce((n, w) => n + Math.ceil(w.length / 3), 0);
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
    worker.current?.terminate();
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setProgress(0); setOutput(null); setErr('');
    w.onmessage = (ev) => {
      if (ev.data.type === 'progress') setProgress(ev.data.done / ev.data.total);
      else if (ev.data.type === 'done') { setOutput(ev.data.output); setProgress(null); w.terminate(); }
      else { setErr(ev.data.message); setProgress(null); w.terminate(); }
    };
    const ceStock: CEStock[] = data.ces.map((ce) => ({ ce, count: stock[ce.no]?.count ?? 1, mlb: stock[ce.no]?.mlb ?? true }));
    const [fNo, fMlb] = prefs.friendCe.split(':');
    const settings: Settings = {
      maxTurns: prefs.maxTurns, costCap: prefs.costCap, roll: prefs.roll, startNp: prefs.append2 ? 2000 : 0,
      friendCe: fNo ? { no: Number(fNo), mlb: fMlb === '1' } : null, topN: 10,
    };
    w.postMessage({ pool: buildPool(data, roster, prefs), servants: data.servants, stock: ceStock, quest, rel: data.rel, settings });
  };
  useEffect(() => () => worker.current?.terminate(), []);

  const ownedCount = useMemo(() => Object.values(roster).filter((r) => r.owned).length, [roster]);
  const minTurns = quest ? quest.waves.reduce((n, w) => n + Math.ceil(w.length / 3), 0) : 0;

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
            {quest.warnings.map((w) => <p key={w} className="warn">{w}</p>)}
            {quest.waves.map((wave, i) => (
              <div key={i} className="wave">
                <span className="tag">{i + 1}웨이브</span>
                {wave.map((e, k) => (
                  <span key={k} className={`enemy cls-${e.cls}`}>
                    <b>{e.name}</b> {CLASS_KO[e.cls] ?? e.cls}·{ATTR_KO[e.attr] ?? e.attr}
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
          <label>턴 제한{minTurns ? ` (보구만으로 최소 ${minTurns}턴)` : ''}
            <input type="number" min={1} max={15} value={prefs.maxTurns} onChange={(e) => set('maxTurns', Number(e.target.value) || 1)} />
          </label>
          <label>파티 코스트 상한
            <input type="number" min={30} max={130} value={prefs.costCap} onChange={(e) => set('costCap', Number(e.target.value) || 115)} />
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
              {data.ces.filter((c) => c.kind === 'pct').map((c) => (
                <option key={c.no} value={`${c.no}:1`}>{c.name} (최대해방 {(c.sup ?? c.val)[1] / 10}%)</option>
              ))}
              <option value={`${data.ces.find((c) => c.kind === 'flat')?.no}:1`}>영령초상 (+50)</option>
            </select>
          </label>
          <label>포우 ATK 강화
            <select value={prefs.fou} onChange={(e) => set('fou', Number(e.target.value))}>
              <option value={0}>없음</option><option value={1000}>+1000</option><option value={2000}>+2000</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={prefs.append2} onChange={(e) => set('append2', e.target.checked)} /> 어펜드 스킬 2 (시작 NP 20%) 적용</label>
        </div>
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
          <p className="muted small">전투 조합 {output.simulated.toLocaleString()}개를 계산했고, 그중 {prefs.maxTurns}턴 안에 클리어되는 조합은 {output.feasible.toLocaleString()}개입니다.</p>
          {!output.results.length && (
            <div className="warn">
              <p>인연 예장만 끼고 {prefs.maxTurns}턴 안에 보구로 정리할 수 있는 조합을 찾지 못했습니다. 턴 제한을 늘려 보세요.</p>
              {output.bestFail && <p>가장 근접한 조합: {output.bestFail.names.join(' + ')} — 적 {output.bestFail.sim.total}기 중 {output.bestFail.sim.killed}기 처치</p>}
            </div>
          )}
          {output.results.map((r, i) => <Result key={i} r={r} rank={i + 1} base={quest.bond} />)}
        </section>
      )}
    </main>
  );
}

function NumSel({ v, on }: { v: number; on: (v: number) => void }) {
  return <select value={v} onChange={(e) => on(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select>;
}

function Face({ src, name }: { src: string; name: string }) {
  return src ? <img className="face" src={src} alt="" loading="lazy" /> : <span className="face ph">{name.slice(0, 1)}</span>;
}

function Result({ r, rank, base }: { r: PartyResult; rank: number; base: number }) {
  const [open, setOpen] = useState(rank === 1);
  const member = (m: PartyResult['front'][0], k: number) => (
    <div key={k} className={`member ${m.friend ? 'friend' : ''}`}>
      {m.svt ? <Face src={m.svt.face} name={m.svt.name} /> : <span className="face ph">?</span>}
      <div>
        <div className="mname">{m.svt ? m.svt.name : '프렌드 (자유)'}</div>
        <div className="small muted">
          {m.friend ? '프렌드 서포트' : ROLE_KO[m.role]}
          {m.svt && !m.friend && <> · <b className={m.counted ? 'bond' : ''}>{m.counted ? `+${m.bond.toLocaleString()}` : '인연 MAX'}</b></>}
        </div>
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
      <div className="line"><span className="tag">전열</span>{r.front.map(member)}</div>
      <div className="line"><span className="tag">후열</span>{r.back.map(member)}</div>
      <div className="line ces">
        <span className="tag">예장</span>
        {r.ces.map((c, k) => (
          <span key={k} className="ce">{c.ce.name}{c.ce.rarity === 5 ? (c.mlb ? ' (최대해방)' : ' (미해방)') : ''}</span>
        ))}
        {r.friendCe && <span className="ce friend">프렌드: {r.friendCe.name}</span>}
      </div>
      {open && (
        <div className="log">
          <p className="small muted">예장은 누가 껴도 효과가 같습니다(파티 전체 적용). 스킬 순서는 시뮬레이터가 고른 한 가지 예시입니다.</p>
          {r.sim.log.map((t) => (
            <div key={t.turn} className="turn">
              <b>{t.turn}턴</b> <span className="muted small">({t.wave}웨이브)</span>
              {t.skills.length > 0 && <ol>{t.skills.map((s, k) => <li key={k}>{s.who} — {s.skill}{s.target ? ` → ${s.target}` : ''}</li>)}</ol>}
              {t.nps.map((n, k) => (
                <div key={k} className="np">
                  보구: {n.who} 「{n.np}」
                  <span className="small muted"> {n.hits.map((h) => `${h.enemy} ${h.dmg.toLocaleString()}/${h.hp.toLocaleString()}${h.kill ? ' 처치' : ''}`).join(' · ')} · NP 회수 {(n.refund / 100).toFixed(0)}%</span>
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

const NEW_ENTRY: RosterEntry = { owned: true, npLv: 1, lv: 'max', skillLv: 10, bondMax: false };

function RosterTab({ data, roster, setRoster }: { data: Data; roster: Roster; setRoster: (v: Roster | ((p: Roster) => Roster)) => void }) {
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
        <p className="muted small">보유한 서번트를 체크하세요. "인연 MAX"로 표시한 서번트는 전투에는 쓰지만 인연 합계에서 빼고, 인연을 받는 자리에는 넣지 않습니다. 이 브라우저에 저장됩니다.</p>
        <div className="row">
          <input className="grow" placeholder="이름 검색" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={cls} onChange={(e) => setCls(e.target.value)}>
            <option value="">모든 클래스</option>
            {classes.map((c) => <option key={c} value={c}>{CLASS_KO[c] ?? c}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={onlyOwned} onChange={(e) => setOnlyOwned(e.target.checked)} /> 보유만</label>
          <button onClick={() => setRoster((r) => { const n = { ...r }; for (const s of list) n[s.no] = { ...NEW_ENTRY, ...n[s.no], owned: true }; return n; })}>표시된 서번트 모두 보유</button>
          <button onClick={exportJson}>내보내기</button>
          <button onClick={() => file.current?.click()}>가져오기</button>
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
                    <label>레벨
                      <select value={r.lv} onChange={(e) => upd(s.no, { lv: e.target.value as RosterEntry['lv'] })}>
                        <option value="max">기본 최대</option><option value="100">100</option><option value="120">120</option>
                      </select>
                    </label>
                    <label>스킬
                      <select value={r.skillLv} onChange={(e) => upd(s.no, { skillLv: Number(e.target.value) })}>
                        {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </label>
                    <label className="check"><input type="checkbox" checked={r.bondMax} onChange={(e) => upd(s.no, { bondMax: e.target.checked })} /> 인연 MAX</label>
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
                const s = stock[c.no] ?? { count: 1, mlb: true };
                return (
                  <div key={c.no} className="cerow">
                    <Face src={c.face} name={c.name} />
                    <span className="grow">{c.name} <span className="muted small">★{c.rarity} · 코스트 {c.cost} · {desc(c, s.mlb)}</span></span>
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
