// Atlas Academy 원본 데이터를 앱용 경량 데이터로 바꾸는 순수 변환 로직.
// Node(scripts/build-data.mjs)와 브라우저(앱의 자동 업데이트)가 같이 쓴다. 파일·네트워크 입출력은 호출하는 쪽이 맡는다.

/** 받아야 하는 원본 파일: 내부 이름 → Atlas 주소 */
export const SOURCES = {
  'KR_nice_servant.json': 'export/KR/nice_servant.json',
  'KR_nice_war.json': 'export/KR/nice_war.json',
  'KR_basic_svt.json': 'export/KR/basic_svt.json',
  'ce.json': 'export/KR/nice_equip.json',
  'KR_nice_mystic_code.json': 'export/KR/nice_mystic_code.json',
  'KR_nice_class_board.json': 'export/KR/nice_class_board.json',
  'JP_NiceClassRelation.json': 'export/JP/NiceClassRelation.json',
  'JP_NiceClassAttackRate.json': 'export/JP/NiceClassAttackRate.json',
  'JP_NiceAttributeRelation.json': 'export/JP/NiceAttributeRelation.json',
  'KR_basic_event.json': 'export/KR/basic_event.json',
  'JP_basic_event.json': 'export/JP/basic_event.json',
};
export const API = 'https://api.atlasacademy.io/';

/** 턴 종료 시 발동하는 효과가 가리키는 스킬 id 목록(따로 받아야 한다: nice/JP/skill/{id}) */
export function triggerSkillIds(rawServants) {
  const need = new Set();
  for (const s of rawServants) {
    for (const k of [...s.skills, ...s.noblePhantasms]) for (const f of k.functions) {
      if ((f.buffs || []).some((b) => b.type === 'selfturnendFunction') && f.svals?.[0]?.Value) need.add(f.svals[0].Value);
    }
  }
  return [...need];
}

/**
 * 한국 서버에 아직 열리지 않은 다음 이벤트 후보를 일본 서버 개최 순으로 돌려준다(따로 받아야 한다: nice/JP/war/{id}).
 * 한국 서버는 일본 서버의 이벤트 일정을 따라가므로, 한국에 마지막으로 열린 이벤트보다 일본에서 늦게 열린 이벤트가 다음 차례다.
 * est: 한국 서버 예상 개시 시각(초). 최근 이벤트들의 한일 시차(중앙값)를 일본 개시 시각에 더한 값이다.
 */
export function upcomingEvents(files, max = 3) {
  const kr = files['KR_basic_event.json'], jp = files['JP_basic_event.json'];
  if (!Array.isArray(kr) || !Array.isArray(jp)) return [];
  // 이벤트 워(8000번대 이상)가 딸린 이벤트만 본다. 캠페인이나 메인 스토리 개방은 뺀다.
  const ok = (e) => e.type === 'eventQuest' && (e.warIds || []).some((id) => id >= 8000);
  const jpOf = new Map(jp.map((e) => [e.id, e]));
  const done = kr.filter((e) => ok(e) && jpOf.has(e.id)).sort((a, b) => a.startedAt - b.startedAt);
  if (!done.length) return [];
  const lastJp = Math.max(...done.map((e) => jpOf.get(e.id).startedAt));
  const gaps = done.slice(-9).map((e) => e.startedAt - jpOf.get(e.id).startedAt).sort((a, b) => a - b);
  const gap = gaps[gaps.length >> 1];
  const have = new Set(kr.map((e) => e.id));
  return jp.filter((e) => ok(e) && !have.has(e.id) && e.startedAt > lastJp).sort((a, b) => a.startedAt - b.startedAt).slice(0, max)
    .map((e) => ({ id: e.id, name: e.name.replace(/\s+/g, ' ').trim(), warIds: e.warIds.filter((id) => id >= 8000), est: e.startedAt + gap }));
}

/**
 * 스킬·보구 변환기. triggerSkills: 스킬 id → 스킬 JSON(턴 종료 효과를 읽는 데 쓴다. 없으면 그 효과만 빠진다).
 * 데이터 빌드와, 퀘스트가 지정한 서포트(NPC)의 스킬·보구를 앱에서 변환할 때 함께 쓴다.
 */
export function makeCompact(triggerSkills) {
  const ids = (list) => (list || []).map((t) => t.id);

  const BUFFS = new Set([
    'upAtk', 'downAtk', 'upCommandall', 'downCommandall', 'upNpdamage', 'downNpdamage', 'upDamage',
    'upDropnp', 'downDropnp', 'downDefence', 'upDefence', 'downDefencecommandall', 'regainNp',
    'addDamage', 'buffRate', 'pierceInvincible',
    // 근성: 대미지와는 무관하지만 '[근성] 상태인 아군'을 조건으로 하는 효과(테스카틀리포카 1스)가 있어 상태로 남긴다
    'guts',
    // 강화 성공률 UP: 확률로 걸리는 버프(황제특권 등)를 확정으로 만든다
    'upGrantstate',
    // 받는 강화 성공률 UP(강화 내성 DOWN): 받는 쪽에 걸린다(스카사하 2스)
    'downTolerance',
    // 오버차지 단계 UP, 특성 특공(대상의 특성 / 대상에게 걸린 상태), 특성 부여, 필드 특성 부여, 방어 무시
    'breakAvoidance', 'upChagetd', 'upDamageIndividuality', 'upDamageIndividualityActiveonly', 'addIndividuality', 'fieldIndividuality', 'pierceDefence',
  ]);
  // 버프가 아닌 효과 중 계산에 넣는 것
  const PLAIN_FN = new Set([
    'gainNp', 'lossNp', 'shortenSkill', 'forceInstantDeath', 'replaceMember',
    'gainNpBuffIndividualSum', 'gainNpIndividualSum', 'gainNpTargetSum', 'gainMultiplyNp', 'addFieldChangeToField',
  ]);
  // 적에게 걸리는 버프 중 계산에 넣는 것: 무적(오베론 보구의 단점 — 같은 턴의 뒤따르는 공격이 막힌다)
  const ENEMY_BUFFS = new Set(['invincible']);

  /** 턴 종료 효과를 시뮬레이터용으로 줄인다: NP 증감, 강화 해제, 행동 불능(영구수면) */
  function turnEndFx(id) {
    const skill = triggerSkills?.[id];
    if (!skill) return [];
    const out = [];
    for (const f of skill.functions || []) {
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
  const SV_KEYS = ['Rate', 'Turn', 'Count', 'Value', 'Value2', 'Correction', 'Target', 'TargetRarityList', 'TargetList', 'ParamAddMaxCount', 'AndCheckIndividualityList', 'FieldIndividuality'];

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
        // 근성의 INDIVIDUALITIE는 반대 뜻이다(근성 봉인 상태면 발동하지 않는다): 조건으로 옮기지 않는다
        if (need.length && b.type !== 'guts') o.si = need;
        if (b.ckSelfIndv?.length) o.cs = ids(b.ckSelfIndv);
        if (b.ckOpIndv?.length) o.co = ids(b.ckOpIndv);
        if (b.vals?.length) o.v = ids(b.vals);
        const ur = b.script?.UpBuffRateBuffIndiv;
        if (ur?.length) o.ur = ids(ur);
        return o;
      });
      buffs.push(...turnEnd);
      if (!buffs.length) return null;
    } else if (f.funcType === 'gainNpFromTargets') {
      // 다른 아군의 NP를 줄이고 줄인 만큼 얻는 효과만 옮긴다(적의 차지를 빼앗는 쪽은 적 행동을 계산하지 않으므로 제외)
      const dep = f.svals[0]?.DependFunc;
      if (dep?.funcType !== 'lossNp' || dep.funcTargetTeam === 'enemy') return null;
      return { t: 'absorbNp', tg: dep.funcTargetType, sv: f.svals.slice(0, levels).map((sv) => ({ Rate: sv.Rate, Value: sv.DependFuncVals?.Value ?? 0 }))[levels - 1] ?? { Value: 0 } };
    } else if (!isDamage && !PLAIN_FN.has(f.funcType)) {
      return null;
    }
    if (f.svals[0]?.StarHigher) return null; // 스타가 일정 수 이상일 때만 발동(스타는 계산하지 않는다)
    const svs = f.svals.slice(0, levels).map(pickSv);
    const same = svs.every((s) => JSON.stringify(s) === JSON.stringify(svs[0]));
    const o = { t: f.funcType, tg: f.funcTargetType, sv: same ? svs[0] : svs };
    // 오버차지 2~5단계의 수치(1단계와 다를 때만). 보구에만 있다.
    if (f.svals2?.length) {
      const ocs = [f.svals2, f.svals3, f.svals4, f.svals5].map((list) => {
        const l = (list || f.svals).slice(0, levels).map(pickSv);
        return l.every((s) => JSON.stringify(s) === JSON.stringify(l[0])) ? l[0] : l;
      });
      if (ocs.some((x) => JSON.stringify(x) !== JSON.stringify(o.sv))) o.oc = ocs;
    }
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

  /** 보구 1개를 앱용으로 변환한다. */
  function compactNp(n) {
    const fn = n.functions.map((f) => compactFn(f, 5)).filter(Boolean);
    const dmgFn = fn.find((f) => DAMAGE.has(f.t));
    const np = {
      name: n.name, card: { 1: 'arts', 2: 'buster', 3: 'quick' }[n.card] || n.card, gain: n.npGain.np[0], dist: n.npDistribution, fn,
      dmg: !!dmgFn, aoe: dmgFn ? dmgFn.tg === 'enemyAll' : false,
    };
    // 보구 사용 후 퇴장: 자신이 죽거나(아라쉬 등), 다른 아군 1기를 제물로 쓴다(진궁)
    const death = fn.find((f) => f.t === 'forceInstantDeath');
    if (death) np.dies = death.tg === 'self' ? 'self' : 'ally';
    return np;
  }

  return { ids, compactFn, compactSkill, compactNp };
}

/**
 * raw.files: SOURCES의 내부 이름 → 파싱된 JSON, raw.triggerSkills: 스킬 id → 스킬 JSON, now: 기준 시각(초).
 * raw.upcoming: [{ event: upcomingEvents()의 항목, wars: 그 이벤트의 일본 서버 워 JSON 목록 }] (없어도 된다).
 * 반환: { servants, ces, wars, mcs, boards, names, rel }
 */
export function transform(raw, now) {
  const { ids, compactFn, compactSkill, compactNp } = makeCompact(raw.triggerSkills);

  // ---------- 서번트 ----------

  // 기본 특성 + 나중에 추가된 상시 특성(traitAdd). 이벤트 한정·특정 재림 한정 특성은 뺀다.
  // 예: 어둠의 코얀스카야의 [짐승과의 서번트](2821)는 traitAdd에만 들어 있다.
  const buildSec = now;
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

  const rawServants = raw.files['KR_nice_servant.json'];
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
    if (s.noblePhantasms.length) np = compactNp(best(s.noblePhantasms));
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
      // 레벨별 ATK(1~120). 레벨만 아는 데이터(Chaldea 백업)에서 정확한 ATK를 구하는 데 쓴다.
      growth: g.slice(0, 120),
      skills, np, passive,
      face: s.extraAssets?.faces?.ascension?.['1'] || '',
    });
  }
  servants.sort((a, b) => a.no - b.no);

  // ---------- 인연 예장 ----------
  const SUPPORT_PCT = { 910: [30, 150] }; // 칼데아 티타임: 서포트 편성 시 수치(일반, 최대해방)
  const ces = [];
  for (const c of raw.files['ce.json']) {
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
  const nowSec = now;
  // 강화 퀘스트(워 1001 전부)와 막간의 이야기(type friendship: 워 1003과 각 장의 지점에 흩어져 있다)는 따로 모아 워 하나씩으로 만든다.
  // 둘 다 해당 서번트를 편성해야 하므로 그 서번트(개방 조건의 svtGet)의 도감 번호를 함께 담는다.
  const RANKUP_WAR = 1001, INTERLUDE_WAR = 1003;
  const svtOf = new Map(raw.files['KR_nice_servant.json'].map((s) => [s.id, s]));
  const relateOf = new Map();
  for (const s of raw.files['KR_nice_servant.json']) for (const id of s.relateQuestIds || []) relateOf.set(id, s);
  const rankups = [], interludes = [];
  const svtQuest = (q, type) => {
    if (!q.phases.length) return;
    // 서번트: 개방 조건(svtGet, 없으면 svtLimit) → 서번트 쪽의 관련 퀘스트 목록 → 막간의 이야기 id 규칙(91 + 서번트 id 앞자리 + 순번)
    const cond = (t) => svtOf.get(q.releaseConditions?.find((r) => r.type === t)?.targetId);
    const owner = cond('svtGet') ?? cond('svtLimit') ?? relateOf.get(q.id)
      ?? (String(q.id).startsWith('91') ? svtOf.get(Number(String(q.id).slice(2, -2)) * 100) : undefined);
    const name = q.name.trim();
    const o = {
      id: q.id, type, name: owner && !name.includes(owner.name) ? `${owner.name} · ${name}` : name, spot: '', chapter: 0, sub: 0, subStr: '',
      phases: q.phases, noBattle: q.phasesNoBattle || [], ap: q.consume, lv: q.recommendLv || '',
    };
    if (owner?.collectionNo > 0) o.svt = owner.collectionNo;
    (type === 'rankup' ? rankups : interludes).push(o);
  };
  for (const w of raw.files['KR_nice_war.json']) {
    for (const sp of w.spots) for (const q of sp.quests) {
      if (w.id === RANKUP_WAR) svtQuest(q, 'rankup');
      else if (q.type === 'friendship') svtQuest(q, 'interlude');
    }
    // 이벤트 워(8000번대 이상): 반복해서 돌 수 있는 퀘스트만 넣는다
    const isEvent = w.id >= 8000;
    if (w.id >= 1000 && w.id !== DAILY_WAR && !isEvent) continue;
    const quests = [];
    for (const sp of w.spots) {
      for (const q of sp.quests) {
        // 요일·이벤트 퀘스트는 아직 닫히지 않은 것만 넣고 프리 퀘스트로 취급한다. 열리는 기간을 함께 담아 앱에서 지금 열린 것만 보여 준다.
        const timed = (w.id === DAILY_WAR || (isEvent && q.afterClear === 'repeatLast')) && q.closedAt > nowSec && q.phases.length > 0;
        if (isEvent && !timed) continue;
        if (q.type !== 'main' && q.type !== 'free' && !timed) continue;
        const o = {
          id: q.id, type: timed ? 'free' : q.type, name: q.name.trim(), spot: sp.name, chapter: q.chapterId || 0,
          sub: q.chapterSubId || 0, subStr: (q.chapterSubStr || '').trim(), phases: q.phases,
          noBattle: q.phasesNoBattle || [], ap: q.consume, lv: q.recommendLv || '',
        };
        if (timed) o.open = [q.openedAt, q.closedAt];
        quests.push(o);
      }
    }
    if (!quests.length) continue;
    quests.sort((a, b) => a.id - b.id);
    const longName = w.id === DAILY_WAR ? '칼데아 게이트 요일 퀘스트' : isEvent ? `이벤트 ${(w.longName || w.name).replace(/\n/g, ' ')}` : w.longName.replace(/\n/g, ' ');
    wars.push({ id: w.id, name: w.name, longName, quests });
  }
  // 한국 서버에 아직 열리지 않은 다음 이벤트: 후보 중 반복해서 돌 수 있는 퀘스트가 있는 첫 이벤트 하나만 넣는다.
  // 한국어 데이터가 없으므로 이름은 일본어 그대로다. 기간은 담지 않는다(한국에 열리면 한국 데이터의 것으로 바뀐다).
  for (const u of raw.upcoming || []) {
    const quests = [];
    for (const w of u.wars || []) for (const sp of w.spots || []) for (const q of sp.quests) {
      if (q.afterClear !== 'repeatLast' || !q.phases.length) continue;
      quests.push({
        id: q.id, type: 'free', name: q.name.trim(), spot: sp.name, chapter: 0, sub: 0, subStr: '', phases: q.phases,
        noBattle: q.phasesNoBattle || [], ap: q.consume, lv: q.recommendLv || '',
      });
    }
    if (!quests.length || !u.wars?.length || wars.some((w) => w.id === u.wars[0].id)) continue;
    quests.sort((a, b) => a.id - b.id);
    wars.push({ id: u.wars[0].id, name: u.event.name, longName: `오픈 전 이벤트 ${u.event.name}`, quests, soon: u.event.est });
    break;
  }
  for (const [id, name, quests] of [[RANKUP_WAR, '강화 퀘스트', rankups], [INTERLUDE_WAR, '막간의 이야기', interludes]]) {
    if (!quests.length) continue;
    quests.sort((a, b) => a.id - b.id);
    wars.push({ id, name, longName: name, quests });
  }

  // ---------- 마술예장 ----------
  // 보구 대미지나 NP에 영향을 주는 스킬이 하나라도 있는 예장만 남긴다
  const mcs = [];
  for (const m of raw.files['KR_nice_mystic_code.json']) {
    const skills = m.skills.map((k) => compactSkill(k, 10));
    if (skills.some((k) => k.fn.length)) mcs.push({ id: m.id, name: m.name, skills, face: m.extraAssets?.item?.male || '' });
  }

  // ---------- 이름, 상성 ----------
  const names = {};
  for (const s of raw.files['KR_basic_svt.json']) names[s.id] = s.name;

  const rel = {
    classRelation: raw.files['JP_NiceClassRelation.json'],
    classAttack: raw.files['JP_NiceClassAttackRate.json'],
    attribute: raw.files['JP_NiceAttributeRelation.json'],
  };

  // ---------- 클래스 스코어 ----------
  // 보구 대미지에 닿는 칸만 남긴다: 카드 위력 UP(버스터 b·아츠 a·퀵 q), 보구 위력 UP(np). 값은 천분율.
  const CARD_KIND = { 4001: 'a', 4002: 'b', 4003: 'q' };
  const boards = [];
  for (const bd of raw.files['KR_nice_class_board.json'] || []) {
    const sq = {};
    for (const q of bd.squares) {
      const f = q.targetSkill?.functions?.[0], bf = f?.buffs?.[0];
      if (q.skillType !== 'passive' || !bf) continue;
      const val = f.svals?.[0]?.Value ?? 0;
      const kind = bf.type === 'upNpdamage' ? 'np' : bf.type === 'upCommandatk' ? CARD_KIND[bf.ckSelfIndv?.[0]?.id] : undefined;
      if (kind && val) sq[q.id] = [kind, val];
    }
    boards.push({ id: bd.id, name: bd.name, cls: bd.classes.map((c) => c.className), sq });
  }

  return { servants, ces, wars, mcs, boards, names, rel };
}
