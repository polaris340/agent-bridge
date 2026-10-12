/**
 * 누가 한 말인지 앞에 붙인다. 여러 사람이 한 채널에서 부르고, 작업 중에 들어온 말은
 * 한 턴에 섞이므로 에이전트가 말한 사람을 구분할 수 있어야 한다.
 *
 * 이건 이름표일 뿐 신원 증명이 아니다. 본문에 누가 "[앨리스]" 라고 써도 똑같아 보인다.
 * 부를 수 있는 사람은 ALLOWED_USER_IDS 가 막는다.
 *
 * "/" 로 시작하면 에이전트 명령(/compact, /model …)이라 그대로 둔다. 앞에 뭐가 붙으면
 * 명령으로 안 먹는다.
 */
export function withSpeaker(text, name) {
  if (!name || !text || text.startsWith('/')) return text;
  return `[${name}] ${text}`;
}
