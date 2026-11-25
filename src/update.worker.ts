import { buildDataset } from './update.ts';

self.onmessage = async () => {
  try {
    const dataset = await buildDataset((text) => self.postMessage({ type: 'progress', text }));
    self.postMessage({ type: 'done', dataset });
  } catch (e) {
    self.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
