/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 * Ported from OpenClaw's implementation for NanoClaw
 */

import * as lark from '@larksuiteoapi/node-sdk';

import { logger } from '../logger.js';

type FeishuDomain = 'feishu' | 'lark';

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain };

type CardState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  hasNote: boolean;
};

// Token cache (keyed by domain + appId)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function resolveApiBase(domain?: FeishuDomain): string {
  if (domain === 'lark') {
    return 'https://open.larksuite.com/open-apis';
  }
  return 'https://open.feishu.cn/open-apis';
}

async function getToken(creds: Credentials): Promise<string> {
  const key = `${creds.domain ?? 'feishu'}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const response = await fetch(`${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    signal: AbortSignal.timeout(10000), // 10s timeout for token
  });

  if (!response.ok) {
    throw new Error(`Token request failed with HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }

  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });

  return data.tenant_access_token;
}

export function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === 'string' ? previousText : '';
  const next = typeof nextText === 'string' ? nextText : '';
  if (!next) {
    return previous;
  }
  if (!previous || next === previous) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    return previous;
  }
  if (next.includes(previous)) {
    return next;
  }
  if (previous.includes(next)) {
    return previous;
  }

  // Merge partial overlaps, e.g. "这" + "这是" => "这是".
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  // Fallback for fragmented partial chunks: append as-is to avoid losing tokens.
  return `${previous}${next}`;
}

function resolveStreamingCardSendMode(options?: { replyToMessageId?: string; rootId?: string }) {
  // Streaming cards are always independent messages, not replies
  // This avoids issues with P2P chats where message.reply may not work correctly
  if (options?.rootId) {
    return 'root_create';
  }
  return 'create';
}

export type StreamingCardOptions = {
  header?: {
    title: string;
    template?: string;
  };
  note?: string;
};

export type StreamingStartOptions = StreamingCardOptions & {
  replyToMessageId?: string;
  replyInThread?: boolean;
  rootId?: string;
};

/** Streaming card session manager */
export class FeishuStreamingSession {
  private client: lark.Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  private updateThrottleMs = 0; // Disable throttle for debugging

  constructor(client: lark.Client, creds: Credentials) {
    this.client = client;
    this.creds = creds;
  }

  async start(
    receiveId: string,
    receiveIdType: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id' = 'chat_id',
    options?: StreamingStartOptions,
  ): Promise<void> {
    if (this.state) {
      return;
    }

    const apiBase = resolveApiBase(this.creds.domain);
    const elements: Record<string, unknown>[] = [
      { tag: 'markdown', content: '⏳ Thinking...', element_id: 'content' },
    ];
    if (options?.note) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: `<font color='grey'>${options.note}</font>`,
        element_id: 'note',
      });
    }

    const cardJson: Record<string, unknown> = {
      schema: '2.0',
      config: {
        streaming_mode: true,
        summary: { content: '[Generating...]' },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 1 } },
      },
      body: { elements },
    };

    if (options?.header) {
      cardJson.header = {
        title: { tag: 'plain_text', content: options.header.title },
        template: options.header.template ?? 'blue',
      };
    }

    // Create card entity via CardKit API
    const token = await getToken(this.creds);
    const createRes = await fetch(`${apiBase}/cardkit/v1/cards`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'card_json', data: JSON.stringify(cardJson) }),
      signal: AbortSignal.timeout(10000), // 10s timeout for card creation
    });

    if (!createRes.ok) {
      throw new Error(`Create card request failed with HTTP ${createRes.status}`);
    }

    const createData = (await createRes.json()) as {
      code: number;
      msg: string;
      data?: { card_id: string };
    };

    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }

    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });

    // Send the card as an interactive message
    const sendOptions = options ?? {};
    const sendMode = resolveStreamingCardSendMode(sendOptions);
    let sendRes;

    if (sendMode === 'root_create' && sendOptions.rootId) {
      // root_id is undeclared in SDK types but accepted at runtime
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: Object.assign(
          { receive_id: receiveId, msg_type: 'interactive', content: cardContent },
          { root_id: sendOptions.rootId },
        ),
      });
    } else {
      // Default: create as independent message (not a reply)
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'interactive',
          content: cardContent,
        },
      });
    }

    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = {
      cardId,
      messageId: sendRes.data.message_id,
      sequence: 1,
      currentText: '',
      hasNote: !!options?.note,
    };

    logger.info({ messageId: sendRes.data.message_id, cardId, chatId: receiveId }, 'Streaming card created and sent');
  }

  private async updateCardContent(text: string): Promise<void> {
    if (!this.state) {
      return;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    this.state.sequence += 1;

    // Convert <internal>...</internal> blocks to visible format
    // Feishu markdown strips unknown tags, so we convert to quote format
    const visibleText = text.replace(
      /<internal>([\s\S]*?)<\/internal>/g,
      (_match, content) => `\n> ${content.trim().split('\n').join('\n> ')}\n`,
    );

    const updateRes = await fetch(
      `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: visibleText,
          sequence: this.state.sequence,
          uuid: `s_${this.state.cardId}_${this.state.sequence}`,
        }),
        signal: AbortSignal.timeout(5000), // 5s timeout
      },
    );
    if (!updateRes.ok) {
      logger.error({ status: updateRes.status, cardId: this.state.cardId }, 'Card content update failed - HTTP error');
    } else {
      const updateData = await updateRes.json() as { code: number; msg: string };
      if (updateData.code !== 0) {
        logger.error({ code: updateData.code, msg: updateData.msg, cardId: this.state.cardId }, 'Card content update failed - API error');
      } else {
        logger.info({ cardId: this.state.cardId, sequence: this.state.sequence }, 'Card content updated successfully');
      }
    }
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed) {
      logger.info({ state: this.state ? 'exists' : 'null', closed: this.closed }, 'update called but not active');
      return;
    }
    const mergedInput = mergeStreamingText(this.pendingText ?? this.state.currentText, text);
    if (!mergedInput || mergedInput === this.state.currentText) {
      logger.info({ text, currentText: this.state.currentText }, 'update skipped - no change');
      return;
    }
    logger.info({ messageId: this.state.messageId, textLength: text.length }, 'update queued');

    // Throttle: skip if updated recently, but remember pending text
    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      this.pendingText = mergedInput;
      return;
    }
    this.pendingText = null;
    this.lastUpdateTime = now;

    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }
      const mergedText = mergeStreamingText(this.state.currentText, mergedInput);
      if (!mergedText || mergedText === this.state.currentText) {
        return;
      }
      this.state.currentText = mergedText;
      await this.updateCardContent(mergedText);
    });
    await this.queue;
  }

  private async updateNoteContent(note: string): Promise<void> {
    if (!this.state || !this.state.hasNote) {
      return;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    this.state.sequence += 1;

    await fetch(
      `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/note/content`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: `<font color='grey'>${note}</font>`,
          sequence: this.state.sequence,
          uuid: `n_${this.state.cardId}_${this.state.sequence}`,
        }),
        signal: AbortSignal.timeout(5000), // 5s timeout
      },
    );
  }

  async close(finalText?: string, options?: { note?: string }): Promise<void> {
    if (!this.state || this.closed) {
      logger.info({ cardId: this.state?.cardId }, 'close called but already closed/inactive');
      return;
    }
    this.closed = true;
    logger.info({ messageId: this.state.messageId, cardId: this.state.cardId, finalText }, 'Closing streaming card with final text');
    await this.queue;

    const pendingMerged = mergeStreamingText(this.state.currentText, this.pendingText ?? undefined);
    const text = finalText ? mergeStreamingText(pendingMerged, finalText) : pendingMerged;
    const apiBase = resolveApiBase(this.creds.domain);

    // Only send final update if content differs from what's already displayed
    if (text && text !== this.state.currentText) {
      logger.info({ messageId: this.state.messageId, textLength: text.length }, 'Updating card with final content');
      await this.updateCardContent(text);
      this.state.currentText = text;
    } else {
      logger.info({ messageId: this.state.messageId, currentText: this.state.currentText, text }, 'Skipping update - content unchanged');
    }

    // Update note with final info
    if (options?.note) {
      await this.updateNoteContent(options.note);
    }

    // Close streaming mode
    this.state.sequence += 1;
    const closeRes = await fetch(
      `${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          settings: JSON.stringify({
            config: { streaming_mode: false, summary: { content: text?.slice(0, 50) ?? '' } },
          }),
          sequence: this.state.sequence,
          uuid: `c_${this.state.cardId}_${this.state.sequence}`,
        }),
        signal: AbortSignal.timeout(5000), // 5s timeout
      },
    );

    if (!closeRes.ok) {
      logger.error({ status: closeRes.status, cardId: this.state.cardId }, 'Failed to close streaming card - HTTP error');
    } else {
      const closeData = await closeRes.json() as { code: number; msg: string };
      if (closeData.code !== 0) {
        logger.error({ code: closeData.code, msg: closeData.msg, cardId: this.state.cardId }, 'Failed to close streaming card - API error');
      } else {
        logger.info({ cardId: this.state.cardId }, 'Streaming card closed successfully');
      }
    }

    this.state = null;
    this.pendingText = null;
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }

  getMessageId(): string | null {
    return this.state?.messageId ?? null;
  }
}
