/**
 * "이 메시지는 어느 라우트의, 어느 세션으로 가는가" 만 정하는 순수 함수.
 *
 * 세션을 만들거나 tmux 를 건드리지 않으므로 그대로 테스트할 수 있다
 * (routing.test.js). 실제 세션 관리는 Router 가 한다.
 */

/**
 * @param {{routes: object[], allowedChannelIds?: string[], allowedGuildIds?: string[], allowedUserIds?: string[]}} conf
 * @param {{channelId: string, parentId?: string|null, guildId?: string|null, userId?: string}} message
 * @returns {{route: object, scopeId: string|null}|null} 못 쓰면 null
 */
export function pickRoute(conf, { channelId, parentId = null, guildId = null, userId = null }) {
  const routes = conf.routes ?? [];
  const allowedChannelIds = conf.allowedChannelIds ?? [];
  const allowedGuildIds = conf.allowedGuildIds ?? [];
  const allowedUserIds = conf.allowedUserIds ?? [];

  const cid = String(channelId);
  const pid = parentId === null || parentId === undefined ? null : String(parentId);
  const gid = guildId === null || guildId === undefined ? null : String(guildId);

  // 이 채널(혹은 스레드의 부모 채널)을 콕 집은 라우트가 우선이다.
  let route = routes.find((r) => r.channelIds.includes(cid));
  if (!route && pid !== null) route = routes.find((r) => r.channelIds.includes(pid));

  if (!route) {
    // 채널을 지정하지 않은 라우트는 전역 허용 범위를 따른다.
    const open = routes.find((r) => r.channelIds.length === 0);
    if (!open) return null;
    // 장소도 사람도 하나 안 적힌 열린 라우트는 아무도 못 쓴다. 다른 라우트에 채널을
    // 적었다고 이것까지 열리면, 봇과 같은 서버에 있는 아무나(DM 포함) 에이전트를 부린다.
    const placeScoped = allowedChannelIds.length > 0 || allowedGuildIds.length > 0;
    const userScoped = allowedUserIds.length > 0 || open.userIds?.length > 0;
    if (!placeScoped && !userScoped) return null;
    if (!isAllowedPlace({ cid, pid, gid }, { allowedChannelIds, allowedGuildIds })) return null;
    route = open;
  }

  if (route.userIds?.length > 0 && !route.userIds.includes(String(userId))) return null;
  if (allowedUserIds.length > 0 && !allowedUserIds.includes(String(userId))) return null;

  return { route, scopeId: scopeFor(route, cid, pid) };
}

function isAllowedPlace({ cid, pid, gid }, { allowedChannelIds, allowedGuildIds }) {
  // 장소를 안 적었으면 여기서 막지 않는다. 그때는 사람 목록이 막는다 (pickRoute 에서 확인).
  if (allowedChannelIds.length === 0 && allowedGuildIds.length === 0) return true;
  if (allowedChannelIds.includes(cid)) return true;
  if (pid !== null && allowedChannelIds.includes(pid)) return true;
  if (gid !== null && allowedGuildIds.includes(gid)) return true;
  return false;
}

/**
 * 세션을 가르는 단위.
 *
 * 라우트가 콕 집은 채널은 그 라우트의 고정 세션을 쓴다. 그 밖의 채널과 스레드는
 * 각자 자기 세션을 받아 서로 맥락이 섞이지 않고 나란히 돈다.
 */
function scopeFor(route, cid, pid) {
  if (route.channelIds.includes(cid)) return null;

  const isThread = pid !== null;
  if (!isThread) return route.perChannel === false ? null : cid;

  if (route.perThread !== false) return cid;

  // 스레드를 부모 채널과 한 세션으로 묶는 경우
  if (route.channelIds.includes(pid)) return null;
  return route.perChannel === false ? null : pid;
}

/** 세션 키. 채널·스레드마다 다른 키를 써야 세션이 갈린다. */
export const sessionKey = (route, scopeId) => (scopeId ? `${route.key}#${scopeId}` : route.key);
