import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { FeishuStreamingSession } from './feishu-streaming.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;

  // Track typing indicator reactions per chat
  // Key: chatJid (e.g. "fs:oc_xxx"), Value: { messageId, reactionId }
  private typingReactions = new Map<
    string,
    { messageId: string; reactionId: string }
  >();

  // Track the last message ID per chat for typing indicator
  private lastMessageId = new Map<string, string>();

  // Track streaming sessions per chat
  // Key: chatJid, Value: { session, replyToMessageId }
  private streamingSessions = new Map<
    string,
    { session: FeishuStreamingSession; replyToMessageId?: string }
  >();

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Initialize Feishu client
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    // Initialize WebSocket client for event subscription
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    // Create event dispatcher
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        logger.info(
          { event: 'im.message.receive_v1', data },
          'Feishu message event received',
        );
        try {
          await this.handleMessage(data);
        } catch (err) {
          logger.error({ err }, 'Failed to handle Feishu message');
        }
      },
    });

    // Log all events for debugging
    logger.info(
      'Feishu event dispatcher registered for: im.message.receive_v1',
    );

    // Start WebSocket connection with event dispatcher
    await this.wsClient.start({ eventDispatcher });

    logger.info('Feishu bot connected via WebSocket');
    console.log('\n  Feishu bot connected');
    console.log('  Use chat IDs from Feishu to register groups\n');
  }

  private async handleMessage(data: any): Promise<void> {
    const message = data.message;
    logger.info({ messageId: message.message_id, chatId: message.chat_id }, 'handleMessage called');
    const sender = data.sender;

    // Ignore bot messages
    if (sender.sender_type === 'app') return;

    const chatId = message.chat_id;
    const chatJid = `fs:${chatId}`;
    const messageId = message.message_id;
    const senderId = sender.sender_id.open_id;
    const timestamp = new Date(parseInt(message.create_time)).toISOString();

    // Get message content
    let content = '';
    const msgType = message.message_type;

    if (msgType === 'text') {
      const textContent = JSON.parse(message.content);
      content = textContent.text || '';
    } else if (msgType === 'image') {
      content = '[图片]';
    } else if (msgType === 'file') {
      content = '[文件]';
    } else if (msgType === 'audio') {
      content = '[语音]';
    } else if (msgType === 'video') {
      content = '[视频]';
    } else {
      content = `[${msgType}]`;
    }

    // Get sender name
    let senderName = 'Unknown';
    try {
      const userInfo = await this.client!.contact.v3.user.get({
        path: { user_id: senderId },
        params: { user_id_type: 'open_id' },
      });
      senderName = userInfo.data?.user?.name || senderId;
    } catch (err) {
      logger.debug({ err, senderId }, 'Failed to get Feishu user info');
      senderName = senderId;
    }

    // Get chat name
    let chatName = 'Unknown Chat';
    let isGroup = false;
    try {
      const chatInfo = await this.client!.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      chatName = chatInfo.data?.name || chatId;
      isGroup = chatInfo.data?.chat_mode === 'group';
    } catch (err) {
      logger.debug({ err, chatId }, 'Failed to get Feishu chat info');
      chatName = chatId;
    }

    // Handle @mentions - check if bot is mentioned
    // Note: mentions info may be in the content or as separate field
    const mentions = data.mentions || [];
    if (mentions.length > 0) {
      const botMentioned = mentions.some(
        (mention: any) => mention.id?.open_id === this.appId,
      );
      if (botMentioned && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

    // Track last message ID for this chat (used by typing indicator)
    this.lastMessageId.set(chatJid, messageId);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Feishu chat',
      );
      return;
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Feishu message stored',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }

    try {
      const chatId = jid.replace(/^fs:/, '');

      // Send text message
      await this.client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.wsClient !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('fs:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      // WSClient doesn't have a stop method, just set to null
      this.wsClient = null;
    }
    this.client = null;
    logger.info('Feishu bot stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }

    const chatJid = jid;
    const messageId = this.lastMessageId.get(chatJid);

    if (!messageId) {
      logger.debug({ chatJid }, 'No message ID available for typing indicator');
      return;
    }

    const existingReaction = this.typingReactions.get(chatJid);

    if (isTyping) {
      // If already showing typing, don't add another reaction
      if (existingReaction) {
        return;
      }

      try {
        const response = await this.client.im.messageReaction.create({
          path: { message_id: messageId },
          data: {
            reaction_type: { emoji_type: 'Typing' },
          },
        });

        const reactionId = (response as any).data?.reaction_id;
        if (reactionId) {
          this.typingReactions.set(chatJid, { messageId, reactionId });
          logger.debug(
            { chatJid, messageId, reactionId },
            'Added typing indicator',
          );
        }
      } catch (err) {
        logger.debug({ err, messageId }, 'Failed to add typing indicator');
      }
    } else {
      // Remove typing indicator
      if (!existingReaction) {
        return;
      }

      try {
        await this.client.im.messageReaction.delete({
          path: {
            message_id: existingReaction.messageId,
            reaction_id: existingReaction.reactionId,
          },
        });
        logger.debug({ chatJid }, 'Removed typing indicator');
      } catch (err) {
        logger.debug({ err }, 'Failed to remove typing indicator');
      } finally {
        this.typingReactions.delete(chatJid);
      }
    }
  }

  async startStreaming(jid: string, replyToMessageId?: string): Promise<string> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      throw new Error('Feishu client not initialized');
    }

    logger.info({ jid, replyToMessageId }, 'Feishu.startStreaming called');

    const chatJid = jid;
    const chatId = jid.replace(/^fs:/, '');

    // Idempotent: if there's an active streaming session, return it instead of creating a new one
    const existing = this.streamingSessions.get(chatJid);
    if (existing?.session.isActive()) {
      const existingMessageId = existing.session.getMessageId();
      logger.info({ chatJid, existingMessageId }, 'Streaming already active, reusing existing session');
      return existingMessageId ?? '';
    }

    // Close any stale session that wasn't properly cleaned up
    if (existing) {
      try {
        await existing.session.close();
      } catch (err) {
        logger.debug({ err, chatJid }, 'Failed to close stale streaming session');
      }
      this.streamingSessions.delete(chatJid);
    }

    const session = new FeishuStreamingSession(this.client, {
      appId: this.appId,
      appSecret: this.appSecret,
    });

    try {
      await session.start(chatId, 'chat_id', {
        replyToMessageId,
        header: {
          title: '⏳ 正在思考...',
          template: 'blue',
        },
      });

      const messageId = session.getMessageId() ?? '';
      this.streamingSessions.set(chatJid, { session, replyToMessageId });

      logger.debug({ chatJid, messageId }, 'Started Feishu streaming');
      return messageId;
    } catch (err) {
      logger.error({ err, chatJid }, 'Failed to start Feishu streaming');
      throw err;
    }
  }

  async updateStreaming(sessionId: string, text: string): Promise<void> {
    // Find session by messageId (sessionId is actually the messageId)
    for (const [chatJid, { session }] of this.streamingSessions) {
      if (session.getMessageId() === sessionId) {
        try {
          await session.update(text);
        } catch (err) {
          logger.debug({ err, chatJid }, 'Failed to update Feishu streaming');
        }
        return;
      }
    }
    logger.debug({ sessionId }, 'No streaming session found for update');
  }

  getActiveStreamingSession(chatJid: string): string | null {
    const entry = this.streamingSessions.get(chatJid);
    if (entry?.session.isActive()) {
      return entry.session.getMessageId() ?? null;
    }
    return null;
  }

  hasActiveStreamingSession(chatJid: string): boolean {
    const entry = this.streamingSessions.get(chatJid);
    return entry?.session.isActive() ?? false;
  }

  async endStreaming(sessionId: string, finalText?: string): Promise<void> {
    // Find session by messageId
    for (const [chatJid, entry] of this.streamingSessions) {
      if (entry.session.getMessageId() === sessionId) {
        try {
          await entry.session.close(finalText);
          logger.debug({ chatJid }, 'Ended Feishu streaming');
        } catch (err) {
          logger.debug({ err, chatJid }, 'Failed to end Feishu streaming');
        } finally {
          this.streamingSessions.delete(chatJid);
        }
        return;
      }
    }
    logger.debug({ sessionId }, 'No streaming session found for end');
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';

  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }

  return new FeishuChannel(appId, appSecret, opts);
});
