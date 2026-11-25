// Atlas Academy 원본 데이터(data/)를 앱용 경량 JSON(public/data/)으로 변환한다.
// 사용법: node scripts/build-data.mjs [--download]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const outDir = path.join(root, 'public', 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const SOURCES = {
  'KR_nice_servant.json': 'export/KR/nice_servant.json',
  'KR_nice_war.json': 'export/KR/nice_war.json',
  'KR_basic_svt.json': 'export/KR/basic_svt.json',
  'ce.json': 'export/KR/nice_equip.json',
  'KR_nice_mystic_code.json': 'export/KR/nice_mystic_code.json',
  'JP_NiceClassRelation.json': 'export/JP/NiceClassRelation.json',
  'JP_NiceClassAttackRate.json': 'export/JP/NiceClassAttackRate.json',
  'JP_NiceAttributeRelation.json': 'export/JP/NiceAttributeRelation.json',
};

if (process.argv.includes('--download')) {
  for (const [file, url] of Object.entries(SOURCES)) {
    const res = await fetch('https://api.atlasacademy.io/' + url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.writeFileSync(path.join(dataDir, file), Buffer.from(await res.arrayBuffer()));
    console.log('downloaded', file);
  }
}

const load = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
const ids = (list) => (list || []).map((t) => t.id);

// ---------- 서번트 ----------
const BUFFS = new Set([
  'upAtk', 'downAtk', 'upCommandall', 'downCommandall', 'upNpdamage', 'downNpdamage', 'upDamage',
  'upDropnp', 'downDropnp', 'downDefence', 'upDefence', 'downDefencecommandall', 'regainNp',
  'addDamage', 'buffRate',
]);
const DAMAGE = new Set([
  'damageNp', 'damageNpIndividual', 'damageNpPierce', 'damageNpIndividualSum', 'damageNpStateIndividualFix',
  'damageNpHpratioLow', 'damageNpRare', 'damageNpAndOrCheckIndividuality', 'damageNpBattlePointPhase',
]);
const SV_KEYS = ['Rate', 'Turn', 'Count', 'Value', 'Value2', 'Correction', 'Target', 'TargetRarityList'];

function pickSv(sv) {
  const o = {};
  for (const k of SV_KEYS) if (sv[k] !== undefined) o[k] = sv[k];
  return o;
}

function compactFn(f, levels) {
  if (f.funcTargetTeam === 'enemy') return null; // 적이 사용할 때만 적용되는 효과
  const isDamage = DAMAGE.has(f.funcType);
  let buffs;
  if (f.funcType === 'addState' || f.funcType === 'addStateShort') {
    buffs = f.buffs.filter((b) => BUFFS.has(b.type)).map((b) => {
      const o = { t: b.type };
      if (b.ckSelfIndv?.length) o.cs = ids(b.ckSelfIndv);
      if (b.ckOpIndv?.length) o.co = ids(b.ckOpIndv);
      if (b.vals?.length) o.v = ids(b.vals);
      const ur = b.script?.UpBuffRateBuffIndiv;
      if (ur?.length) o.ur = ids(ur);
      return o;
    });
    if (!buffs.length) return null;
  } else if (!isDamage && !['gainNp', 'lossNp', 'shortenSkill'].includes(f.funcType)) {
    return null;
  }
  const svs = f.svals.slice(0, levels).map(pickSv);
  const same = svs.every((s) => JSON.stringify(s) === JSON.stringify(svs[0]));
  const o = { t: f.funcType, tg: f.funcTargetType, sv: same ? svs[0] : svs };
  if (f.functvals?.length) o.tv = ids(f.functvals);
  if (f.funcquestTvals?.length) o.qtv = ids(f.funcquestTvals);
  if (buffs) o.b = buffs;
  return o;
}

// 기본 특성 + 나중에 추가된 상시 특성(traitAdd). 이벤트 한정·특정 재림 한정 특성은 뺀다.
// 예: 어둠의 코얀스카야의 [짐승과의 서번트](2821)는 traitAdd에만 들어 있다.
const buildSec = Date.now() / 1000;
// 영기재림 단계에 따라 특성이 달라지는 서번트가 있다(예: 로우히는 3·4단계에서만 [짐승과의 서번트]).
// stage가 주어지면 그 단계의 특성 목록을, 없으면 기본 목록을 쓴다.
function allTraits(s, stage) {
  const byStage = stage === undefined ? null : s.ascensionAdd?.individuality?.ascension?.[stage];
  const out = new Set(ids(byStage?.length ? byStage : s.traits));
  for (const a of s.traitAdd || []) {
    if (a.eventId !== 0 || a.condType !== 'none') continue;
    if (a.limitCount !== -1 && a.limitCount !== stage) continue;
    if (a.startedAt > buildSec || a.endedAt < buildSec) continue;
    for (const t of a.trait) out.add(t.id);
  }
  return [...out].sort((x, y) => x - y);
}
// 단계별 특성이 서로 다를 때만 5단계(0~4) 목록을 돌려준다
function traitsByStage(s) {
  const lists = [0, 1, 2, 3, 4].map((st) => allTraits(s, st));
  return lists.every((l) => l.join() === lists[4].join()) ? undefined : lists;
}

const best = (list) => list.reduce((a, b) => (b.priority > a.priority || (b.priority === a.priority && b.id > a.id) ? b : a));

const rawServants = load('KR_nice_servant.json');
const servants = [];
for (const s of rawServants) {
  if (!(s.type === 'normal' || s.type === 'heroine') || s.collectionNo <= 0) continue;
  const skills = [];
  for (const num of [1, 2, 3]) {
    const cands = s.skills.filter((k) => k.num === num);
    if (!cands.length) continue;
    const k = best(cands);
    skills.push({ name: k.name, cd: k.coolDown, fn: k.functions.map((f) => compactFn(f, 10)).filter(Boolean) });
  }
  let np = null;
  if (s.noblePhantasms.length) {
    const n = best(s.noblePhantasms);
    const fn = n.functions.map((f) => compactFn(f, 5)).filter(Boolean);
    const dmgFn = fn.find((f) => DAMAGE.has(f.t));
    np = {
      name: n.name, card: { 1: 'arts', 2: 'buster', 3: 'quick' }[n.card] || n.card, gain: n.npGain.np[0], dist: n.npDistribution, fn,
      dmg: !!dmgFn, aoe: dmgFn ? dmgFn.tg === 'enemyAll' : false,
    };
  }
  const passive = [];
  for (const p of s.classPassive) {
    for (const f of p.functions) {
      if (f.funcTargetType !== 'self') continue;
      const c = compactFn(f, 1);
      if (c && c.b) passive.push(c);
    }
  }
  const g = s.atkGrowth;
  servants.push({
    id: s.id, no: s.collectionNo, name: s.name, cls: s.className, rarity: s.rarity, cost: s.cost,
    attr: s.attribute, traits: allTraits(s, 4), asc: traitsByStage(s),
    atk: { 1: g[0], max: g[s.lvMax - 1], 100: g[99], 120: g[119] },
    skills, np, passive,
    face: s.extraAssets?.faces?.ascension?.['1'] || '',
  });
}
servants.sort((a, b) => a.no - b.no);

// ---------- 인연 예장 ----------
const SUPPORT_PCT = { 910: [30, 150] }; // 칼데아 티타임: 서포트 편성 시 수치(일반, 최대해방)
const ces = [];
for (const c of load('ce.json')) {
  const rows = [];
  for (const sk of c.skills) {
    for (const f of sk.functions) {
      if (f.funcType !== 'servantFriendshipUp') continue;
      const sv = f.svals[0];
      rows.push({ mlb: sk.condLimitCount >= 4, sv, f });
    }
  }
  if (!rows.length) continue;
  if (rows.some((r) => r.sv.EventId)) continue; // 이벤트 기간 한정 예장 제외
  const base = rows.find((r) => !r.mlb) || rows[0];
  const mlb = rows.find((r) => r.mlb) || base;
  const cond = [...ids(base.f.functvals).map((i) => [i]), ...(base.f.overWriteTvalsList || []).map(ids)];
  const flat = base.sv.AddCount !== undefined;
  ces.push({
    id: c.id, no: c.collectionNo, name: c.name, rarity: c.rarity, cost: c.cost,
    kind: flat ? 'flat' : 'pct',
    val: [flat ? base.sv.AddCount : base.sv.RateCount, flat ? mlb.sv.AddCount : mlb.sv.RateCount],
    cond,
    sup: SUPPORT_PCT[c.collectionNo] || null,
    atk: c.atkMax || 0,
    face: c.extraAssets?.faces?.equip?.[c.id] || '',
  });
}

// ---------- 퀘스트 색인 ----------
const wars = [];
const DAILY_WAR = 1002; // 칼데아 게이트의 요일 퀘스트(종화 수집, 수련장, 보물창고)
const nowSec = Date.now() / 1000;
for (const w of load('KR_nice_war.json')) {
  if (w.id >= 1000 && w.id !== DAILY_WAR) continue;
  const quests = [];
  for (const sp of w.spots) {
    for (const q of sp.quests) {
      // 요일 퀘스트는 지금 열려 있는 것만 넣고 프리 퀘스트로 취급한다
      const daily = w.id === DAILY_WAR && q.closedAt > nowSec;
      if (q.type !== 'main' && q.type !== 'free' && !daily) continue;
      quests.push({
        id: q.id, type: daily ? 'free' : q.type, name: q.name.trim(), spot: sp.name, chapter: q.chapterId || 0,
        sub: q.chapterSubId || 0, subStr: (q.chapterSubStr || '').trim(), phases: q.phases,
        noBattle: q.phasesNoBattle || [], ap: q.consume, lv: q.recommendLv || '',
      });
    }
  }
  if (!quests.length) continue;
  quests.sort((a, b) => a.id - b.id);
  const longName = w.id === DAILY_WAR ? '칼데아 게이트 요일 퀘스트' : w.longName.replace(/\n/g, ' ');
  wars.push({ id: w.id, name: w.name, longName, quests });
}

// ---------- 마술예장 ----------
// 보구 대미지나 NP에 영향을 주는 스킬이 하나라도 있는 예장만 남긴다
const mcs = [];
for (const m of load('KR_nice_mystic_code.json')) {
  const skills = m.skills.map((k) => ({ name: k.name, cd: k.coolDown, fn: k.functions.map((f) => compactFn(f, 10)).filter(Boolean) }));
  if (skills.some((k) => k.fn.length)) mcs.push({ id: m.id, name: m.name, skills });
}

// ---------- 이름, 상성 ----------
const names = {};
for (const s of load('KR_basic_svt.json')) names[s.id] = s.name;

const rel = {
  classRelation: load('JP_NiceClassRelation.json'),
  classAttack: load('JP_NiceClassAttackRate.json'),
  attribute: load('JP_NiceAttributeRelation.json'),
};

const write = (f, v) => {
  const s = JSON.stringify(v);
  fs.writeFileSync(path.join(outDir, f), s);
  console.log(f, (s.length / 1024).toFixed(0) + ' KB');
};
write('servants.json', servants);
write('ces.json', ces);
write('wars.json', wars);
write('mcs.json', mcs);
write('names.json', names);
write('rel.json', rel);
console.log('servants', servants.length, 'bond CEs', ces.length, 'wars', wars.length);
