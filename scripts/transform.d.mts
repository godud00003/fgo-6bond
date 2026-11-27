// scripts/transform.mjs 의 타입 선언(앱의 자동 업데이트가 같은 변환 로직을 쓴다)
export const SOURCES: Record<string, string>;
export const API: string;
export function triggerSkillIds(rawServants: unknown[]): number[];
/** 스킬·보구 변환기(원본 Atlas JSON → 앱 형식). 반환값의 형식은 src/engine/types.ts 의 Skill·NP·Fn 과 같다. */
export function makeCompact(triggerSkills?: Record<number, unknown>): {
  compactFn(f: unknown, levels: number): unknown;
  compactSkill(k: unknown, levels: number): unknown;
  compactNp(n: unknown): unknown;
};
export function transform(
  raw: { files: Record<string, unknown>; triggerSkills: Record<number, unknown> },
  now: number,
): { servants: unknown[]; ces: unknown[]; wars: unknown[]; mcs: unknown[]; boards: unknown[]; names: Record<string, string>; rel: unknown };
