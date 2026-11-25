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
  'addDamage', 'buffRate', 'pierceInvincible',
]);
// 적에게 걸리는 버프 중 계산에 넣는 것: 무적(오베론 보구의 단점 — 같은 턴의 뒤따르는 공격이 막힌다)
const ENEMY_BUFFS = new Set(['invincible']);

// 턴 종료 시 발동하는 효과(selfturnendFunction)가 가리키는 스킬. data/skills/{id}.json 에 받아 둔다.
const skillsDir = path.join(dataDir, 'skills');
fs.mkdirSync(skillsDir, { recursive: true });
async function fetchTriggerSkill(id) {
  const file = path.join(skillsDir, `${id}.json`);
  if (fs.existsSync(file)) return;
  const res = await fetch(`https://api.atlasacademy.io/nice/JP/skill/${id}`);
  if (!res.ok) { console.warn('trigger skill', id, 'HTTP', res.status); return; }
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
/** 턴 종료 효과를 시뮬레이터용으로 줄인다: NP 증감, 강화 해제, 행동 불능(영구수면) */
function turnEndFx(id) {
  const file = path.join(skillsDir, `${id}.json`);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const f of JSON.parse(fs.readFileSync(file, 'utf8')).functions || []) {
    if (f.funcTargetTeam === 'enemy') continue;
    const sv = f.svals?.[0] || {};
    if (f.funcType === 'lossNp' || f.funcType === 'gainNp') out.push({ t: f.funcType, v: sv.Value || 0 });
    else if (f.funcType === 'subState' && !out.some((x) => x.t === 'clear')) out.push({ t: 'clear' });
    else if ((f.buffs || []).some((b) => b.type === 'donotAct') && sv.Turn === -1) out.push({ t: 'disable' });
  }
  // 강화 해제는 행동 불능과 함께 올 때만 옮긴다(다른 스킬의 해제는 약화 해제 등 종류가 달라 구분할 수 없다)
  if (!out.some((x) => x.t === 'disable')) return out.filter((x) => x.t !== 'clear');
  return out;
}
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
    // HP가 일정 이하일 때만 켜지는 버프는 뺀다(시뮬레이터는 피해를 받지 않는다고 본다)
    const toEnemy = /^enemy/.test(f.funcTargetType);
    const turnEnd = f.buffs.filter((b) => b.type === 'selfturnendFunction' && !toEnemy)
      .map(() => ({ t: 'turnEnd', te: turnEndFx(f.svals[0]?.Value) })).filter((b) => b.te.length);
    buffs = f.buffs.filter((b) => (BUFFS.has(b.type) || (toEnemy && ENEMY_BUFFS.has(b.type))) && b.script?.HP_LOWER === undefined).map((b) => {
      const o = { t: b.type };
      // 보유자가 특정 특성(또는 필드 특성)을 가질 때만 켜지는 버프
      const need = [b.script?.INDIVIDUALITIE, ...(b.script?.INDIVIDUALITIE_OR || [])].filter(Boolean).map((t) => t.id);
      if (need.length) o.si = need;
      if (b.ckSelfIndv?.length) o.cs = ids(b.ckSelfIndv);
      if (b.ckOpIndv?.length) o.co = ids(b.ckOpIndv);
      if (b.vals?.length) o.v = ids(b.vals);
      const ur = b.script?.UpBuffRateBuffIndiv;
      if (ur?.length) o.ur = ids(ur);
      return o;
    });
    buffs.push(...turnEnd);
    if (!buffs.length) return null;
  } else if (!isDamage && !['gainNp', 'lossNp', 'shortenSkill', 'forceInstantDeath', 'replaceMember'].includes(f.funcType)) {
    return null;
  }
  if (f.svals[0]?.StarHigher) return null; // 스타가 일정 수 이상일 때만 발동(스타는 계산하지 않는다)
  const svs = f.svals.slice(0, levels).map(pickSv);
  const same = svs.every((s) => JSON.stringify(s) === JSON.stringify(svs[0]));
  const o = { t: f.funcType, tg: f.funcTargetType, sv: same ? svs[0] : svs };
  if (f.functvals?.length) o.tv = ids(f.functvals);
  if (f.funcquestTvals?.length) o.qtv = ids(f.funcquestTvals);
  if (buffs) o.b = buffs;
  // 선택형 스킬: 여러 효과 중 하나만 고르는 스킬의 선택지 번호
  if (f.svals[0]?.ActSelectIndex !== undefined) o._sel = f.svals[0].ActSelectIndex;
  return o;
}

/** 선택형 스킬은 계산에 가장 도움이 되는 선택지 하나만 남긴다(보구 위력 > 공격력 > 카드 성능 > NP 충전 순으로 수치가 큰 쪽) */
function pickSelection(fns) {
  const groups = new Map();
  for (const f of fns) if (f._sel !== undefined) groups.set(f._sel, [...(groups.get(f._sel) || []), f]);
  if (!groups.size) return fns;
  const last = (f) => (Array.isArray(f.sv) ? f.sv[f.sv.length - 1] : f.sv).Value || 0;
  const score = (list) => Math.max(0, ...list.map((f) => {
    if (f.t === 'gainNp') return last(f) / 10;
    const kinds = (f.b || []).map((b) => b.t);
    if (kinds.includes('upNpdamage')) return last(f) * 1.1;
    if (kinds.includes('upAtk') || kinds.includes('upDamage')) return last(f);
    if (kinds.includes('upCommandall')) return last(f) * 0.9;
    return 0;
  }));
  let bestIdx = -1, bestScore = -1;
  for (const [idx, list] of groups) { const sc = score(list); if (sc > bestScore) { bestScore = sc; bestIdx = idx; } }
  return fns.filter((f) => f._sel === undefined || f._sel === bestIdx).map(({ _sel, ...f }) => f);
}

/** 스킬 1개를 앱용으로 변환한다. 선쿨타임·사용 조건을 함께 옮긴다. */
function compactSkill(k, levels) {
  const sc = k.script || {};
  // 스타 수·낮은 HP를 요구하는 스킬은 조건을 계산할 수 없으므로 쓰지 않는 것으로 본다
  const blocked = sc.STAR_HIGHER !== undefined || sc.HP_PER_LOWER !== undefined;
  const o = { name: k.name, cd: k.coolDown, fn: blocked ? [] : pickSelection(k.functions.map((f) => compactFn(f, levels)).filter(Boolean)) };
  if (sc.battleStartRemainingTurn) o.init = sc.battleStartRemainingTurn; // 배틀 개시 시 바로 쓸 수 없는 스킬의 선쿨타임
  if (sc.NP_HIGHER) o.needNp = sc.NP_HIGHER;                             // NP가 일정 % 이상이어야 쓸 수 있는 스킬
  // 대상을 턴 종료 후 행동 불능으로 만드는 스킬(오베론의 꿈의 끝): 마무리용으로만 써야 한다
  if (o.fn.some((f) => (f.b || []).some((b) => (b.te || []).some((x) => x.t === 'disable')))) o.fin = true;
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
// 턴 종료 발동 스킬을 미리 받아 둔다(--download 일 때만 네트워크 사용)
if (process.argv.includes('--download')) {
  const need = new Set();
  for (const s of rawServants) {
    for (const k of [...s.skills, ...s.noblePhantasms]) for (const f of k.functions) {
      if ((f.buffs || []).some((b) => b.type === 'selfturnendFunction') && f.svals?.[0]?.Value) need.add(f.svals[0].Value);
    }
  }
  for (const id of need) await fetchTriggerSkill(id);
}
const servants = [];
for (const s of rawServants) {
  if (!(s.type === 'normal' || s.type === 'heroine') || s.collectionNo <= 0) continue;
  const skills = [];
  for (const num of [1, 2, 3]) {
    const cands = s.skills.filter((k) => k.num === num);
    if (!cands.length) continue;
    const k = best(cands);
    skills.push(compactSkill(k, 10));
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
    // 보구 사용 후 퇴장: 자신이 죽거나(아라쉬 등), 다른 아군 1기를 제물로 쓴다(진궁)
    const death = fn.find((f) => f.t === 'forceInstantDeath');
    if (death) np.dies = death.tg === 'self' ? 'self' : 'ally';
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
  const skills = m.skills.map((k) => compactSkill(k, 10));
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
