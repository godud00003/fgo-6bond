import { findCores, finishSearch, type CEStock, type CorePart, type PoolEntry, type Settings, type Shard } from './engine/search.ts';
import type { QuestData, Rel, Servant } from './engine/types.ts';

export interface WorkerRequest { pool: PoolEntry[]; servants: Servant[]; stock: CEStock[]; quest: QuestData; rel: Rel; settings: Settings }
/**
 * 탐색은 워커 여러 개가 나눠 맡는다.
 * cores: 클리어되는 편성 찾기(자기 몫만). finish: 모든 워커의 몫을 합쳐 인연을 최적화한다(cores를 받았던 워커 하나가 맡는다).
 */
export type WorkerMessage =
  | { type: 'cores'; req: WorkerRequest; shard: Shard }
  | { type: 'finish'; parts: CorePart[] };

let req: WorkerRequest | null = null;

self.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  try {
    if (ev.data.type === 'cores') {
      req = ev.data.req;
      const { pool, servants, stock, quest, rel, settings } = req;
      let last = 0;
      const part = findCores(pool, servants, stock, quest, rel, settings, (done, total) => {
        const now = Date.now();
        if (now - last > 100) { last = now; self.postMessage({ type: 'progress', done, total }); }
      }, ev.data.shard);
      self.postMessage({ type: 'cores', part });
    } else if (req) {
      const { pool, servants, stock, quest, settings } = req;
      self.postMessage({ type: 'done', output: finishSearch(ev.data.parts, pool, servants, stock, quest, settings) });
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e) });
  }
};
