// 게임 데이터 자동 업데이트: Atlas Academy에 새 한국 서버 데이터가 올라오면 브라우저에서 직접 받아 변환하고,
// 결과를 이 브라우저(IndexedDB)에 저장한다. 변환 로직은 빌드 스크립트와 같은 것을 쓴다.
import { API, SOURCES, transform, triggerSkillIds, upcomingEvents } from '../scripts/transform.mjs';
import type { BondCE, ClassBoard, MysticCode, Rel, Servant, War } from './engine/types.ts';

export interface Meta { kr: { hash: string; timestamp: number }; builtAt: number; /** 브라우저에 저장한 데이터의 형식 번호 */ fmt?: number }
/** 저장 데이터 형식. 변환 결과에 담는 내용이 늘면 올린다(예전 형식으로 저장된 데이터는 쓰지 않는다). 2: 오픈 전 이벤트 */
export const DATA_FMT = 2;
export interface Dataset { servants: Servant[]; ces: BondCE[]; wars: War[]; names: Record<string, string>; rel: Rel; mcs: MysticCode[]; boards: ClassBoard[]; meta: Meta }

/** Atlas가 알려 주는 한국 서버 데이터의 최신 버전 */
export async function latestKr(): Promise<Meta['kr']> {
  const res = await fetch(`${API}info`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`버전 정보를 받지 못했습니다 (HTTP ${res.status})`);
  return (await res.json()).KR;
}

/** 원본을 받아 앱용 데이터로 변환한다. 원본이 80MB쯤 되므로 워커에서 돌린다. */
export async function buildDataset(onProgress: (text: string) => void): Promise<Dataset> {
  const kr = await latestKr();
  const files: Record<string, unknown> = {};
  const names = Object.keys(SOURCES);
  for (let i = 0; i < names.length; i++) {
    onProgress(`원본 데이터 받는 중 (${i + 1}/${names.length})`);
    const res = await fetch(API + SOURCES[names[i]], { cache: 'no-store' });
    if (!res.ok) throw new Error(`${SOURCES[names[i]]}: HTTP ${res.status}`);
    files[names[i]] = await res.json();
  }
  onProgress('보조 데이터 받는 중');
  const triggerSkills: Record<number, unknown> = {};
  for (const id of triggerSkillIds(files['KR_nice_servant.json'] as unknown[])) {
    const res = await fetch(`${API}nice/JP/skill/${id}`);
    if (res.ok) triggerSkills[id] = await res.json();
  }
  // 한국 서버에 아직 열리지 않은 다음 이벤트의 퀘스트 목록(일본 서버 데이터)
  const upcoming: { event: unknown; wars: unknown[] }[] = [];
  for (const event of upcomingEvents(files)) {
    const wars: unknown[] = [];
    for (const id of event.warIds) {
      const res = await fetch(`${API}nice/JP/war/${id}`);
      if (res.ok) wars.push(await res.json());
    }
    upcoming.push({ event, wars });
  }
  onProgress('변환하는 중');
  const now = Math.floor(Date.now() / 1000);
  const out = transform({ files, triggerSkills, upcoming }, now) as unknown as Omit<Dataset, 'meta'>;
  return { ...out, meta: { kr, builtAt: now, fmt: DATA_FMT } };
}

// ---- 저장(IndexedDB). 데이터가 수 MB라 localStorage에는 넣을 수 없다.
const DB = 'fgo-bond', STORE = 'data', KEY = 'dataset';
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function loadCached(): Promise<Dataset | null> {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as Dataset) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}
export async function saveCached(ds: Dataset): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(ds, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* 저장소를 못 쓰면 이번 실행에서만 새 데이터를 쓴다 */ }
}
