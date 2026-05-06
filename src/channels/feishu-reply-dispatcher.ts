/**
 * Feishu Reply Dispatcher - handles streaming and message delivery
 * Based on OpenClaw's implementation
 */

import * as lark from '@larksuiteoapi/node-sdk';

import { logger } from '../logger.js';
import {
  FeishuStreamingSession,
  mergeStreamingText,
} from './feishu-streaming.js';

export interface FeishuReplyDispatcherOptions {
  client: lark.Client;
  appId: string;
  appSecret: string;
  chatId: string;
  chatJid: string;
}

export interface FeishuReplyDispatcher {
  sendPartialReply: (text: string) => Promise<void>;
  sendFinalReply: (text: string) => Promise<void>;
  sendBlockReply: (text: string) => Promise<void>;
  sendToolResult: (text: string) => Promise<void>;
  waitForIdle: () => Promise<void>;
  close: () => Promise<void>;
  isActive: () => boolean;
}

/**
 * Create a Feishu reply dispatcher for handling streaming and non-streaming replies.
 * Each message gets its own dispatcher with its own streaming session.
 */
export function createFeishuReplyDispatcher(
  options: FeishuReplyDispatcherOptions,
): FeishuReplyDispatcher {
  const { client, appId, appSecret, chatId, chatJid } = options;

  // State lock to serialize concurrent operations
  let stateLock = Promise.resolve();
  let streaming: FeishuStreamingSession | null = null;
  let streamText = '';
  let lastPartial = '';
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let inflightUpdate: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let closed = false;

  // Execute state changes atomically with a lock
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prevLock = stateLock;
    let unlock: () => void = () => {};
    stateLock = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await prevLock;
    try {
      return await fn();
    } finally {
      unlock();
    }
  };

  const startStreaming = () => {
    logger.info(
      {
        chatJid,
        hasStreamingStartPromise: !!streamingStartPromise,
        hasStreaming: !!streaming,
      },
      'startStreaming called',
    );
    if (streamingStartPromise || streaming) {
      logger.info({ chatJid }, 'startStreaming early return - already started');
      return;
    }
    streamingStartPromise = (async () => {
      streaming = new FeishuStreamingSession(client, { appId, appSecret });
      try {
        await streaming.start(chatId, 'chat_id', {
          header: {
            title: '⏳ 正在思考...',
            template: 'blue',
          },
        });
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to start streaming');
        streaming = null;
        streamingStartPromise = null;
      }
    })();
  };

  const flushStreamingUpdate = (text: string): Promise<void> => {
    const thisUpdate = (async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        inflightUpdate = streaming.update(text);
        await inflightUpdate;
      }
    })();
    partialUpdateQueue = partialUpdateQueue
      .then(() => thisUpdate)
      .catch(() => {});
    return thisUpdate;
  };

  const queueStreamingUpdate = async (text: string): Promise<void> => {
    if (!text) return;
    if (text === lastPartial) return;
    lastPartial = text;
    streamText = mergeStreamingText(streamText, text);
    await flushStreamingUpdate(streamText);
  };

  const closeStreaming = async (finalText?: string) => {
    logger.info(
      {
        chatJid,
        finalText,
        hasStreaming: !!streaming,
        hasStreamingStartPromise: !!streamingStartPromise,
      },
      'closeStreaming called',
    );
    try {
      if (streamingStartPromise) {
        logger.info({ chatJid }, 'awaiting streamingStartPromise');
        await streamingStartPromise;
        logger.info({ chatJid }, 'streamingStartPromise resolved');
      }
      logger.info(
        { chatJid },
        'after await streamingStartPromise, awaiting partialUpdateQueue',
      );
      await partialUpdateQueue;
      logger.info(
        { chatJid },
        'after await partialUpdateQueue, awaiting inflightUpdate',
      );
      await inflightUpdate;
      logger.info(
        { chatJid, isActive: streaming?.isActive() },
        'after await inflightUpdate',
      );
      if (streaming?.isActive()) {
        const textToClose =
          finalText !== undefined && finalText !== '' ? finalText : streamText;
        logger.info({ chatJid, textToClose }, 'calling streaming.close()');
        await streaming.close(textToClose);
        logger.info({ chatJid }, 'streaming.close() done');
      } else {
        logger.info(
          { chatJid, streamingState: streaming?.isActive() },
          'streaming not active, skipping close',
        );
      }
    } catch (err) {
      logger.error({ err, chatJid }, 'Failed to close streaming');
    } finally {
      streaming = null;
      streamingStartPromise = null;
      streamText = '';
      lastPartial = '';
      inflightUpdate = Promise.resolve();
    }
  };

  const sendPartialReply = async (text: string): Promise<void> => {
    await withLock(async () => {
      logger.info(
        { chatJid, closed, textLength: text.length },
        'sendPartialReply ENTRY',
      );
      // Always reset state for new streaming to prevent mixing with previous streams
      if (closed || streaming?.isActive()) {
        logger.info(
          { chatJid, hadStreaming: !!streaming?.isActive() },
          'sendPartialReply - resetting state for new streaming',
        );
        closed = false;
        if (streaming) {
          try {
            await streaming.close();
          } catch {}
        }
        streaming = null;
        streamingStartPromise = null;
        streamText = '';
        lastPartial = '';
        inflightUpdate = Promise.resolve();
        partialUpdateQueue = Promise.resolve();
      }
      if (!text) {
        logger.info({ chatJid }, 'sendPartialReply skipped - empty text');
        return;
      }
      logger.info(
        { chatJid, textLength: text.length },
        'sendPartialReply starting streaming',
      );
      startStreaming();
      // Wait for streaming to actually start before queueing update
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      await queueStreamingUpdate(text);
      logger.info(
        { chatJid, textLength: text.length },
        'sendPartialReply done',
      );
    });
  };

  const sendFinalReply = async (text: string): Promise<void> => {
    await withLock(async () => {
      if (closed) return;
      logger.info(
        { chatJid, textLength: text.length },
        'sendFinalReply called',
      );
      // Flush any pending streaming updates first, then prevent new updates
      await closeStreaming(text); // Pass final text to update card with complete response
      closed = true;
      logger.info({ chatJid }, 'sendFinalReply done');
    });
  };

  const sendBlockReply = async (text: string): Promise<void> => {
    if (closed) return;
    if (!text) return;
    // For block replies, start streaming if not already
    startStreaming();
    await queueStreamingUpdate(text);
  };

  const sendToolResult = async (text: string): Promise<void> => {
    if (closed) return;
    // Tool results are sent immediately as text
    try {
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      logger.error({ err, chatJid }, 'Failed to send tool result');
    }
  };

  const waitForIdle = async (): Promise<void> => {
    await partialUpdateQueue;
  };

  const close = async (): Promise<void> => {
    await withLock(async () => {
      logger.info({ chatJid, closed }, 'close() called');
      closed = true;
      // Add timeout to prevent hanging if partialUpdateQueue is stuck
      await Promise.race([
        closeStreaming(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            logger.warn({ chatJid }, 'closeStreaming timeout - forcing close');
            resolve();
          }, 3000),
        ),
      ]);
      logger.info({ chatJid }, 'close() completed');
    });
  };

  const isActive = (): boolean => {
    return streaming?.isActive() ?? false;
  };

  return {
    sendPartialReply,
    sendFinalReply,
    sendBlockReply,
    sendToolResult,
    waitForIdle,
    close,
    isActive,
  };
}
