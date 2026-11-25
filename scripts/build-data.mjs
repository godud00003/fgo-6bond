// Atlas Academy 원본 데이터(data/)를 앱용 경량 JSON(public/data/)으로 변환한다.
// 사용법: node scripts/build-data.mjs [--download]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, SOURCES, transform, triggerSkillIds } from './transform.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const skillsDir = path.join(dataDir, 'skills');
const outDir = path.join(root, 'public', 'data');
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const download = process.argv.includes('--download');
const metaFile = path.join(outDir, 'meta.json');

// 데이터 버전: Atlas가 알려 주는 한국 서버 데이터의 해시와 시각. 앱이 새 데이터가 있는지 판단하는 기준이다.
let meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : { kr: { hash: '', timestamp: 0 }, builtAt: 0 };
if (download) {
  const info = await (await fetch(API + 'info')).json();
  for (const [file, url] of Object.entries(SOURCES)) {
    const res = await fetch(API + url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.writeFileSync(path.join(dataDir, file), Buffer.from(await res.arrayBuffer()));
    console.log('downloaded', file);
  }
  meta = { kr: info.KR, builtAt: Math.floor(Date.now() / 1000) };
}

const files = {};
for (const file of Object.keys(SOURCES)) files[file] = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
// 턴 종료 발동 스킬: data/skills/{id}.json 에 받아 둔다(--download 일 때만 네트워크 사용)
const triggerSkills = {};
for (const id of triggerSkillIds(files['KR_nice_servant.json'])) {
  const file = path.join(skillsDir, `${id}.json`);
  if (!fs.existsSync(file) && download) {
    const res = await fetch(`${API}nice/JP/skill/${id}`);
    if (res.ok) fs.writeFileSync(file, Buffer.from(await res.arrayBuffer())); else console.warn('trigger skill', id, 'HTTP', res.status);
  }
  if (fs.existsSync(file)) triggerSkills[id] = JSON.parse(fs.readFileSync(file, 'utf8'));
}

const out = transform({ files, triggerSkills }, Date.now() / 1000);
const write = (f, v) => {
  const s = JSON.stringify(v);
  fs.writeFileSync(path.join(outDir, f), s);
  console.log(f, (s.length / 1024).toFixed(0) + ' KB');
};
for (const k of ['servants', 'ces', 'wars', 'mcs', 'names', 'rel']) write(`${k}.json`, out[k]);
write('meta.json', meta);
console.log('servants', out.servants.length, 'bond CEs', out.ces.length, 'wars', out.wars.length);
