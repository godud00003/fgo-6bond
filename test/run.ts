import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveQuest, toQuestData } from '../src/engine/quest.ts';
import { search, type PoolEntry, type CEStock } from '../src/engine/search.ts';
import { simulate } from '../src/engine/sim.ts';
import type { ActorCfg, BondCE, MysticCode, Rel, Servant, War } from '../src/engine/types.ts';

const j = (f: string) => JSON.parse(fs.readFileSync(new URL('../public/data/' + f, import.meta.url), 'utf8'));
const servants: Servant[] = j('servants.json'); const ces: BondCE[] = j('ces.json'); const wars: War[] = j('wars.json');
const names = j('names.json'); const rel: Rel = j('rel.json');
const query = process.argv[2] || '2부 6장 4절 2번째 배틀';
const r = resolveQuest(query, wars);
console.log(query, '→', r.candidates.length, r.note);
for (const c of r.candidates.slice(0, 8)) console.log('  ', c.quest.id, c.phase, c.label);
if (r.candidates.length !== 1 && !process.argv[3]) process.exit(0);
const c = r.candidates[Number(process.argv[3] || 0)];
const cache = new URL(`../data/quests/${c.quest.id}_${c.phase}.json`, import.meta.url);
if (!fs.existsSync(cache)) {
  fs.mkdirSync(new URL('../data/quests/', import.meta.url), { recursive: true });
  execFileSync('curl', ['-sS', '-m', '60', '-o', fileURLToPath(cache), `https://api.atlasacademy.io/nice/JP/quest/${c.quest.id}/${c.phase}`]);
}
const raw = JSON.parse(fs.readFileSync(cache, 'utf8'));
const quest = toQuestData(raw, names, c.label);
console.log('bond', quest.bond, quest.warnings);
quest.waves.forEach((w, i) => console.log(' wave', i + 1, w.map((e) => `${e.name}(${e.cls},${e.bars.join('/')})`).join(' ')));

const npDefault = (s: Servant) => (s.rarity >= 5 ? 1 : s.rarity === 4 ? 2 : 5);
const lv1 = !!process.env.LV1; // LV1=1 이면 전원 레벨 1 고정
const pool: PoolEntry[] = servants.map((s) => ({ svt: s, npLv: npDefault(s), skillLv: 10, atk: (lv1 ? s.atk[1] : s.atk.max) + 1000, weight: 1 }));
const stock: CEStock[] = ces.map((ce) => ({ ce, count: 1, mlb: true }));
const mcs: MysticCode[] = j('mcs.json');
// 환경 변수: MC=마술예장 id, CARDNP=평타 NP 가정(100 = 1%)
// NODUP=1 이면 동일 서번트 편성 제외
// MUST=도감번호,도감번호 이면 그 서번트를 반드시 포함
// MC=auto 마술예장 자동 선택 / MC=예장 id, OC=1 오더 체인지 편성 포함
// FNP=10000 이면 프렌드가 시작 NP 100% 예장을 낀 것으로 계산
// FCE=auto 이면 프렌드 인연 예장 자동 선택
// CS=1 이면 령주 1획(NP +100%) 사용 허용
const st = { commandSpell: !!process.env.CS, friendCeAuto: process.env.FCE === 'auto', friendStartNp: Number(process.env.FNP || 0), reload: process.env.NORELOAD ? 0 : 3, must: (process.env.MUST || '').split(',').filter(Boolean).map(Number), allowDup: !process.env.NODUP, lv1, mc: mcs.find((m) => m.id === Number(process.env.MC)) ?? null, mcAuto: process.env.MC === 'auto' ? mcs : undefined, orderChange: !!process.env.OC, cardNp: Number(process.env.CARDNP || 0), maxTurns: Number(process.argv[4] || 3), costCap: 112, roll: 0.9, startNp: 2000, friendCe: null, topN: 5, teapot: 1 };
const t0 = Date.now();
const out = search(pool, servants, stock, quest, rel, st);
console.log('sims', out.simulated, 'feasible cores', out.feasible, 'ms', Date.now() - t0, out.autoFriendCe !== undefined ? '| 프렌드 예장 자동: ' + out.autoFriendCe : '');
for (const p of out.results) {
  console.log(`\n총 ${p.total} / ${p.turns}턴 / 코스트 ${p.cost}`);
  console.log('  전열:', p.front.map((m) => `${m.svt.name}${m.friend ? '(프렌드)' : ''}[${m.role}${m.swapOut ? ',교체로 나감' : ''}] ${m.bond}`).join(' | '));
  console.log('  후열:', p.back.map((m) => (m.svt ? `${m.svt.name}${m.friend ? '(프렌드)' : ''}${m.sub ? '[교체 투입]' : ''} ${m.bond}` : '(프렌드 자유)')).join(' | '));
  if (p.mc) console.log('  마술예장:', p.mc.name);
  console.log('  예장:', p.ces.map((c) => c.ce.name).join(', '));
}
const p = out.results[0];
if (p) for (const t of p.sim.log) {
  console.log(` T${t.turn} W${t.wave}`, t.skills.map((s) => `${s.who}:${s.skill}${s.target ? '→' + s.target : ''}`).join(', '));
  for (const n of t.nps) console.log('    ', n.who, n.np, n.hits.map((h) => `${h.enemy} ${h.dmg}/${h.hp}${h.kill ? '✔' : ''}`).join(' '), 'refund', n.refund / 100);
}
if (out.bestFail) console.log('best fail', out.bestFail.names, out.bestFail.sim.killed, '/', out.bestFail.sim.total, '| 게이지', out.bestFail.sim.broken, '/', out.bestFail.sim.bars);

// 기준 검증: 캐스토리아 2 + 아츠 광역 딜러
if (process.argv[5]) {
  const by = (no: number) => servants.find((s) => s.no === no)!;
  const mk = (no: number, role: any, npLv = 1): ActorCfg => ({ svt: by(no), npLv, skillLv: 10, atk: by(no).atk.max + 1000, startNp: 2000, role });
  for (const d of process.argv[5].split(',').map(Number)) {
    const res = simulate([mk(d, 'dealer', 5), mk(284, 'support'), mk(284, 'support')], quest, rel, { maxTurns: 3, roll: 0.9, mode: 'eager' });
    console.log(by(d).name, res.cleared, res.turns, JSON.stringify(res.log.map((t) => t.nps.map((n) => [n.hits.map((h) => h.dmg), n.refund]))));
  }
}
