import { search, type CEStock, type PoolEntry, type Settings } from './engine/search.ts';
import type { QuestData, Rel, Servant } from './engine/types.ts';

export interface WorkerRequest { pool: PoolEntry[]; servants: Servant[]; stock: CEStock[]; quest: QuestData; rel: Rel; settings: Settings }

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { pool, servants, stock, quest, rel, settings } = ev.data;
  try {
    let last = 0;
    const output = search(pool, servants, stock, quest, rel, settings, (done, total) => {
      const now = Date.now();
      if (now - last > 100) { last = now; self.postMessage({ type: 'progress', done, total }); }
    });
    self.postMessage({ type: 'done', output });
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e) });
  }
};
