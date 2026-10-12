import { claudeAgent, sonnetAgent } from './claude.js';
import { codexAgent } from './codex.js';
import { genericAgent } from './generic.js';

/** 완료 감지를 전용으로 구현한 에이전트들. */
export const agents = {
  codex: codexAgent,
  claude: claudeAgent,
  sonnet: sonnetAgent,
  generic: genericAgent,
};

/**
 * 이름으로 어댑터를 찾는다. 모르는 이름이면 그 이름을 실행 파일로 삼아
 * 화면 idle 방식(generic)으로 붙인다 — opencode, aider, gemini 등 아무 TUI 나.
 */
export function resolveAgent(name) {
  if (agents[name]) return agents[name];
  return { ...genericAgent, name, defaultCommand: name };
}

export const knownAgentNames = Object.keys(agents);
