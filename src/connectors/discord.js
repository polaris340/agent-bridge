import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';

const LIMIT = 1900; // 2000 자 제한에 여유를 둔다

export function splitForDiscord(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf('\n', LIMIT);
    if (cut < LIMIT * 0.5) cut = LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** 멘션할 사람을 글 앞에 붙인다. */
const withMentions = (content, ids = []) =>
  ids.length > 0 ? `${ids.map((id) => `<@${id}>`).join(' ')} ${content}` : content;

/**
 * 보낼 조각들. 알림은 첫 조각에만 건다(같은 답에서 여러 번 울리지 않게). 글에서 멘션을
 * 읽어 내는 건 막아서, 에이전트가 쓴 @everyone 같은 것으로는 아무도 안 울린다.
 * 파일은 마지막 조각에 붙인다 — 글보다 먼저 뜨면 맥락 없이 그림만 보인다.
 */
export function buildPayloads(content, files = [], { ping = false, mention = [] } = {}) {
  const chunks = splitForDiscord(withMentions(content, mention));
  return chunks.map((chunk, index) => {
    const first = index === 0;
    const payload = {
      content: chunk,
      allowedMentions: { parse: [], users: first ? mention : [], repliedUser: first && ping },
    };
    if (files.length > 0 && index === chunks.length - 1) payload.files = files;
    return payload;
  });
}

/**
 * 커넥터가 지켜야 할 약속
 *   start(), stop()
 *   send(channelId, text, files, { mention }) — 누가 말을 걸지 않아도 먼저 보낼 때
 *   생성자의 onMessage 로
 *     { channelId, parentId, guildId, mentioned, isDirect, attachments,
 *       userId, userName, displayName, text,
 *       reply(text, files, { ping, mention }), react, unreact } 를 넘긴다
 * 이 규약만 맞추면 슬랙이든 뭐든 같은 자리에 끼워 넣을 수 있다.
 */
export class DiscordConnector {
  name = 'discord';
  #client;
  #token;
  #onMessage;

  constructor({ token, onMessage }) {
    this.#token = token;
    this.#onMessage = onMessage;
    this.#client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
  }

  async start() {
    const ready = new Promise((resolve) => {
      this.#client.once(Events.ClientReady, (client) => {
        console.log(`[discord] ${client.user.tag} 로 접속`);
        for (const guild of client.guilds.cache.values()) {
          console.log(`[discord] 서버: ${guild.name} (${guild.id})`);
        }
        resolve();
      });
    });

    this.#client.on(Events.MessageCreate, (message) => {
      if (message.author.bot) return;
      const text = message.content?.trim();
      const attachments = [...message.attachments.values()].map((file) => ({
        name: file.name ?? 'file',
        url: file.url,
        size: file.size ?? 0,
      }));
      // 글이 없어도 파일만 던질 수 있다.
      if (!text && attachments.length === 0) return;

      // 일반 채널의 parentId 는 카테고리다. 스레드일 때만 부모 채널로 쓴다.
      const isThread = message.channel?.isThread?.() ?? false;
      const parentId = isThread ? (message.channel.parentId ?? null) : null;

      // @everyone 이나 역할 멘션은 나를 부른 게 아니다. 사용자 멘션만 센다.
      const mentioned = message.mentions.users.has(this.#client.user.id);
      const mention = new RegExp(`<@!?${this.#client.user.id}>`, 'g');

      void this.#onMessage({
        channelId: message.channelId,
        parentId,
        guildId: message.guildId ?? null,
        mentioned,
        isDirect: message.guild === null,
        attachments,
        userId: message.author.id,
        userName: message.author.username,
        // 사람이 보는 이름. 서버 닉네임 → 전역 표시 이름 → 사용자명 순으로 고른다.
        displayName: message.member?.displayName || message.author.globalName || message.author.username,
        text: text.replace(mention, ' ').replace(/\s+/g, ' ').trim(),
        reply: (content, files, opts) => this.#reply(message, content, files, opts),
        react: (emoji) => this.#react(message, emoji),
        unreact: (emoji) => this.#unreact(message, emoji),
      });
    });

    await this.#client.login(this.#token);
    await ready;
  }

  async stop() {
    await this.#client.destroy();
  }

  /**
   * 먼저 말 걸기 (세션이 정리됐다는 알림 등).
   * 멘션은 따로 넘긴 사람만 울린다. 에이전트가 쓴 글에 @everyone 이나 남의 멘션이 섞여
   * 있어도 아무도 안 울리게, 글에서 멘션을 읽어 내는 건 막아 둔다.
   * @param {{mention?: string[]}} opts
   */
  async send(channelId, content, files = [], { mention = [] } = {}) {
    try {
      const channel = await this.#client.channels.fetch(channelId);
      if (!channel?.isTextBased?.()) return;
      for (const payload of buildPayloads(content, files, { mention })) await channel.send(payload);
    } catch (err) {
      console.error(`[discord] ${channelId} 로 보내기 실패: ${err.message}`);
    }
  }

  /**
   * ping 이면 답장 대상에게 알림이 간다(채널에 빨간 점). 최종 답에만 켠다 — 중간 설명까지
   * 울리면 빨간 점이 "끝났다" 는 신호가 못 된다.
   */
  async #reply(message, content, files = [], opts = {}) {
    for (const [index, payload] of buildPayloads(content, files, opts).entries()) {
      if (index === 0) await message.reply(payload);
      else await message.channel.send(payload);
    }
  }

  async #react(message, emoji) {
    try {
      await message.react(emoji);
    } catch {
      /* 리액션 실패는 본질이 아니다 */
    }
  }

  async #unreact(message, emoji) {
    try {
      await message.reactions.cache.get(emoji)?.users.remove(this.#client.user.id);
    } catch {
      /* 무시 */
    }
  }
}
