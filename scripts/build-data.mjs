// Atlas Academy 원본 데이터(data/)를 앱용 경량 JSON(public/data/)으로 변환한다.
// 사용법: node scripts/build-data.mjs [--download]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, SOURCES, transform, triggerSkillIds, upcomingEvents } from './transform.mjs';

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
for (const file of Object.keys(SOURCES)) {
  const p = path.join(dataDir, file);
  // 이벤트 목록은 나중에 추가된 원본이라 아직 받지 않았을 수 있다(없으면 다음 이벤트만 빠진다)
  if (fs.existsSync(p) || !/basic_event/.test(file)) files[file] = JSON.parse(fs.readFileSync(p, 'utf8'));
}
// 한국 서버에 아직 열리지 않은 다음 이벤트: 일본 서버의 워 데이터를 data/upcoming.json 에 받아 둔다
const upFile = path.join(dataDir, 'upcoming.json');
if (download) {
  const upcoming = [];
  for (const event of upcomingEvents(files)) {
    const wars = [];
    for (const id of event.warIds) {
      const res = await fetch(`${API}nice/JP/war/${id}`);
      if (res.ok) wars.push(await res.json()); else console.warn('upcoming war', id, 'HTTP', res.status);
    }
    upcoming.push({ event, wars });
  }
  fs.writeFileSync(upFile, JSON.stringify(upcoming));
}
const upcoming = fs.existsSync(upFile) ? JSON.parse(fs.readFileSync(upFile, 'utf8')) : [];
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

const out = transform({ files, triggerSkills, upcoming }, Date.now() / 1000);
const write = (f, v) => {
  const s = JSON.stringify(v);
  fs.writeFileSync(path.join(outDir, f), s);
  console.log(f, (s.length / 1024).toFixed(0) + ' KB');
};
for (const k of ['servants', 'ces', 'wars', 'mcs', 'boards', 'names', 'rel']) write(`${k}.json`, out[k]);
write('meta.json', meta);
console.log('servants', out.servants.length, 'bond CEs', out.ces.length, 'wars', out.wars.length);
