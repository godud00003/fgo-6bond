// scripts/transform.mjs 의 타입 선언(앱의 자동 업데이트가 같은 변환 로직을 쓴다)
export const SOURCES: Record<string, string>;
export const API: string;
export function triggerSkillIds(rawServants: unknown[]): number[];
export function transform(
  raw: { files: Record<string, unknown>; triggerSkills: Record<number, unknown> },
  now: number,
): { servants: unknown[]; ces: unknown[]; wars: unknown[]; mcs: unknown[]; boards: unknown[]; names: Record<string, string>; rel: unknown };
