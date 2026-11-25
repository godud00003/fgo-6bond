// 앱 전체(스크립트·스타일·워커·게임 데이터)를 HTML 파일 하나로 묶는다.
// 사용법: npm run single  →  fgo-bond.html (더블클릭으로 바로 열림, 서버 불필요)
// 적 구성 조회와 서번트 아이콘은 인터넷 연결이 필요하다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-single');

await build({
  root,
  logLevel: 'warn',
  worker: { format: 'iife' }, // 모듈 워커보다 file:// 에서 제약이 적다
  build: {
    outDir, emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: 100_000_000, copyPublicDir: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

const assets = path.join(outDir, 'assets');
const files = fs.readdirSync(assets);
const one = (ext) => {
  const list = files.filter((f) => f.endsWith(ext));
  if (list.length !== 1) throw new Error(`${ext} 파일이 ${list.length}개입니다: ${list.join(', ')}`);
  return fs.readFileSync(path.join(assets, list[0]), 'utf8');
};
// HTML 안에 넣어도 태그가 닫히지 않게 한다
const safe = (s) => s.replace(/<\/(script|style)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const data = {};
for (const f of ['servants', 'ces', 'wars', 'names', 'rel', 'mcs', 'meta']) {
  data[f] = JSON.parse(fs.readFileSync(path.join(root, 'public', 'data', `${f}.json`), 'utf8'));
}

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>FGO 인연 파티 최적화</title>
<style>${safe(one('.css'))}</style>
</head>
<body>
<div id="root"></div>
<script>window.__FGO_DATA__ = ${safe(JSON.stringify(data))};</script>
<script type="module">${safe(one('.js'))}</script>
</body>
</html>
`;
const out = path.join(root, 'fgo-bond.html');
fs.writeFileSync(out, html);
fs.rmSync(outDir, { recursive: true, force: true });
console.log(`${out} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
