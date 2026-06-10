/**
 * Feishu (飞书) channel adapter for NanoClaw v2.
 *
 * Uses @larksuiteoapi/node-sdk with WebSocket event subscription for
 * bidirectional messaging. Supports file attachments via message resource API.
 */
import * as lark from '@larksuiteoapi/node-sdk';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeishuConfig {
  appId: string;
  appSecret: string;
}

interface FileAttachment {
  file_key: string;
  file_name: string;
  file_size?: number;
}

// ---------------------------------------------------------------------------
// Feishu Channel Adapter
// ---------------------------------------------------------------------------

export class FeishuAdapter implements ChannelAdapter {
  name = 'feishu';
  channelType = 'fs';
  supportsThreads = false;

  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private channelSetup: ChannelSetup | null = null;
  private connected = false;

  // File storage directory for attachments
  private readonly attachmentsDir = '/workspace/agent/feishu-attachments';

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async setup(config: ChannelSetup): Promise<void> {
    this.channelSetup = config;

    const appId = process.env.FEISHU_APP_ID ?? readEnvFile(['FEISHU_APP_ID']).FEISHU_APP_ID ?? '';
    const appSecret = process.env.FEISHU_APP_SECRET ?? readEnvFile(['FEISHU_APP_SECRET']).FEISHU_APP_SECRET ?? '';

    if (!appId || !appSecret) {
      log.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
      return;
    }

    this.client = new lark.Client({
      appId,
      appSecret,
    });

    // Create event dispatcher
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        log.debug('Feishu message event received', { data });
        try {
          await this.handleMessage(data);
        } catch (err) {
          log.error('Feishu message handling failed', { err });
        }
      },
    });

    // Initialize WebSocket client
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    await this.wsClient.start({ eventDispatcher });
    this.connected = true;
    log.info('Feishu bot connected via WebSocket');
  }

  async teardown(): Promise<void> {
    this.wsClient = null;
    this.client = null;
    this.connected = false;
    log.info('Feishu bot stopped');
  }

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  // ---------------------------------------------------------------------------
  // Inbound handling
  // ---------------------------------------------------------------------------

  private async handleMessage(data: Record<string, unknown>): Promise<void> {
    if (!this.channelSetup || !this.client) return;

    const message = data.message as Record<string, unknown> | undefined;
    if (!message) return;

    const sender = data.sender as Record<string, unknown> | undefined;
    if (!sender) return;

    // Ignore bot messages
    if ((sender.sender_type as string) === 'app') return;

    const chatId = message.chat_id as string;
    const platformId = `fs:${chatId}`;
    const messageId = message.message_id as string;
    const senderId = (sender.sender_id as Record<string, unknown>)?.open_id as string;
    const msgType = message.message_type as string;
    const timestamp = new Date(parseInt(message.create_time as string)).toISOString();

    // Parse content based on message type
    let text = '';
    let content: Record<string, unknown> | null = null;

    if (msgType === 'text') {
      const parsed = JSON.parse(message.content as string);
      text = parsed.text || '';
      content = { text };
    } else if (msgType === 'file') {
      const parsed = JSON.parse(message.content as string) as FileAttachment;
      // Download file and provide path
      const filePath = await this.downloadFile(messageId, parsed);
      text = `📎 文件: feishu-attachments/${filePath.split('/').pop()}`;
      content = { text, file_key: parsed.file_key, file_name: parsed.file_name };
    } else if (msgType === 'image') {
      text = '[图片]';
      content = { text };
    } else if (msgType === 'audio') {
      text = '[语音]';
      content = { text };
    } else if (msgType === 'video') {
      text = '[视频]';
      content = { text };
    } else {
      text = `[${msgType}]`;
      content = { text };
    }

    // Get sender name
    let senderName = senderId;
    try {
      const userInfo = await this.client.contact.v3.user.get({
        path: { user_id: senderId },
        params: { user_id_type: 'open_id' },
      });
      senderName = ((userInfo.data?.user as Record<string, unknown>)?.name as string) || senderId;
    } catch {
      // Use open_id as fallback
    }

    // Get chat info
    let chatName = chatId;
    let isGroup = false;
    try {
      const chatInfo = await this.client.im.v1.chat.get({ path: { chat_id: chatId } });
      chatName = (chatInfo.data?.name as string) || chatId;
      isGroup = chatInfo.data?.chat_mode === 'group';
    } catch {
      // Use chatId as fallback
    }

    // Notify metadata
    this.channelSetup.onMetadata(platformId, chatName, isGroup);

    // Build inbound message
    const inbound: InboundMessage = {
      id: messageId,
      kind: 'chat-sdk',
      content: content || { text },
      timestamp,
      isGroup,
    };

    // Deliver to router
    await this.channelSetup.onInbound(platformId, null, inbound);
  }

  private async downloadFile(messageId: string, file: FileAttachment): Promise<string> {
    if (!this.client) return '';

    const { file_key, file_name } = file;
    const ext = file_name.split('.').pop() || '';
    const safeName = `${messageId}.${ext}`;
    const filePath = `${this.attachmentsDir}/${safeName}`;

    try {
      const res = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key },
        params: { type: 'file' },
      });

      await (res as unknown as { writeFile: (path: string) => Promise<void> }).writeFile(filePath);
      log.debug('Feishu file downloaded', { filePath });
    } catch (err) {
      log.error('Feishu file download failed', { err, messageId, file_key });
    }

    return filePath;
  }

  // ---------------------------------------------------------------------------
  // Outbound delivery
  // ---------------------------------------------------------------------------

  async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    if (!this.client) {
      log.warn('Feishu client not initialized');
      return undefined;
    }

    const chatId = platformId.replace(/^fs:/, '');
    const content = message.content as Record<string, unknown>;
    const text = typeof content === 'string' ? content : (content.text as string) || '';

    try {
      const res = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      const messageId = (res as unknown as { data?: { message_id?: string } })?.data?.message_id;
      log.debug('Feishu message sent', { platformId, messageId });
      return messageId;
    } catch (err) {
      log.error('Feishu message send failed', { err, platformId });
      return undefined;
    }
  }

  async setTyping(platformId: string, _threadId: string | null): Promise<void> {
    // Feishu doesn't support typing indicators via API
    // Could use message reactions as a workaround
  }

  // ---------------------------------------------------------------------------
  // Channel registry factory
  // ---------------------------------------------------------------------------

  static create(): FeishuAdapter {
    return new FeishuAdapter();
  }
}

registerChannelAdapter('fs', {
  factory: () => new FeishuAdapter(),
});
