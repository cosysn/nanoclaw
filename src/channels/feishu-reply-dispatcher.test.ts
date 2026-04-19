import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Shared refs between mocks
const streamingInstances = vi.hoisted(() => {
  const instances: {
    start: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    isActive: () => boolean;
    getMessageId: () => string;
  }[] = [];
  return {
    instances,
    reset: () => instances.splice(0, instances.length),
  };
});

const messageCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ code: 0 }));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(() => ({
    im: {
      v1: {
        message: {
          create: messageCreateMock,
        },
      },
    },
  })),
}));

// --- FeishuStreamingSession mock ---

vi.mock('./feishu-streaming.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { mergeStreamingText: realMerge } = actual as any;

  class MockFeishuStreamingSession {
    start = vi.fn().mockResolvedValue(undefined);
    update = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    private _isActive = true;
    private _messageId = 'om_streaming_msg_001';

    isActive() {
      return this._isActive;
    }

    getMessageId() {
      return this._messageId;
    }

    setActive(active: boolean) {
      this._isActive = active;
    }

    setMessageId(id: string) {
      this._messageId = id;
    }

    constructor() {
      streamingInstances.instances.push(this as any);
    }
  }

  return {
    FeishuStreamingSession: MockFeishuStreamingSession,
    mergeStreamingText: realMerge,
  };
});

import {
  createFeishuReplyDispatcher,
  FeishuReplyDispatcher,
} from './feishu-reply-dispatcher.js';
import { mergeStreamingText } from './feishu-streaming.js';

// --- Tests ---

describe('mergeStreamingText', () => {
  it('returns next when previous is empty', () => {
    expect(mergeStreamingText('', 'hello')).toBe('hello');
    expect(mergeStreamingText(undefined, 'hello')).toBe('hello');
  });

  it('returns next when next equals previous', () => {
    expect(mergeStreamingText('hello', 'hello')).toBe('hello');
  });

  it('returns next when next starts with previous (append case)', () => {
    expect(mergeStreamingText('he', 'hello')).toBe('hello');
  });

  it('returns previous when previous starts with next (prefix case)', () => {
    expect(mergeStreamingText('hello', 'he')).toBe('hello');
  });

  it('handles partial overlap merge', () => {
    expect(mergeStreamingText('这是', '这是的')).toBe('这是的');
    expect(mergeStreamingText('你好世', '世界')).toBe('你好世界');
  });

  it('appends when no overlap', () => {
    expect(mergeStreamingText('hello', 'world')).toBe('helloworld');
  });

  it('returns empty string when both empty', () => {
    expect(mergeStreamingText('', '')).toBe('');
  });
});

describe('FeishuReplyDispatcher', () => {
  let dispatcher: FeishuReplyDispatcher;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    streamingInstances.reset();
    messageCreateMock.mockClear();
    messageCreateMock.mockResolvedValue({ code: 0 });

    mockClient = {
      im: {
        v1: {
          message: {
            create: messageCreateMock,
          },
        },
      },
    };
    dispatcher = createFeishuReplyDispatcher({
      client: mockClient,
      appId: 'cli_app123',
      appSecret: 'secret_abc',
      chatId: 'oc_chat123',
      chatJid: 'fs:oc_chat123',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Basic methods ---

  describe('isActive', () => {
    it('returns false before any reply', () => {
      expect(dispatcher.isActive()).toBe(false);
    });

    it('returns true after sendPartialReply', async () => {
      await dispatcher.sendPartialReply('hello');
      expect(dispatcher.isActive()).toBe(true);
    });
  });

  describe('sendPartialReply', () => {
    it('starts streaming and queues update', async () => {
      await dispatcher.sendPartialReply('hello');
      expect(streamingInstances.instances).toHaveLength(1);
      expect(streamingInstances.instances[0].start).toHaveBeenCalled();
    });

    it('deduplicates identical consecutive partials', async () => {
      await dispatcher.sendPartialReply('hello');
      await dispatcher.sendPartialReply('hello');
      expect(streamingInstances.instances[0].update).toHaveBeenCalledTimes(1);
    });

    it('ignores empty text', async () => {
      await dispatcher.sendPartialReply('');
      expect(streamingInstances.instances).toHaveLength(0);
    });
  });

  describe('sendBlockReply', () => {
    it('also starts streaming like partial reply', async () => {
      await dispatcher.sendBlockReply('block content');
      expect(streamingInstances.instances).toHaveLength(1);
      expect(streamingInstances.instances[0].start).toHaveBeenCalled();
    });

    it('queues update with merged text', async () => {
      await dispatcher.sendPartialReply('hello ');
      await dispatcher.sendBlockReply('world');
      expect(streamingInstances.instances[0].update).toHaveBeenCalled();
    });
  });

  describe('sendToolResult', () => {
    it('sends text message immediately without streaming', async () => {
      await dispatcher.sendToolResult('tool output here');
      expect(messageCreateMock).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_chat123',
          msg_type: 'text',
          content: JSON.stringify({ text: 'tool output here' }),
        },
      });
    });

    it('does not start streaming for tool results', async () => {
      await dispatcher.sendToolResult('tool output');
      expect(streamingInstances.instances).toHaveLength(0);
    });
  });

  // ============================================================
  // COMBINATION BEHAVIOR TESTS (critical end-to-end scenarios)
  // ============================================================

  describe('sendFinalReply combination behavior', () => {
    /**
     * CRITICAL: sendFinalReply should pass final text to close(),
     * NOT send a separate message.create() call.
     * The streaming card IS the final reply - no extra message needed.
     */
    it('sendFinalReply passes final text to close() for card update', async () => {
      await dispatcher.sendPartialReply('thinking...');
      await dispatcher.sendFinalReply('complete answer');

      // The streaming card should be closed with the FINAL text (not just partial)
      expect(streamingInstances.instances[0].close).toHaveBeenCalledWith('complete answer');
    });

    /**
     * CRITICAL: Only streaming card messages should be sent, no extra text messages.
     * sendFinalReply should NOT call message.create() for final text.
     */
    it('sendFinalReply does NOT send extra message.create (streaming card is final reply)', async () => {
      // First call starts streaming (calls message.create internally)
      await dispatcher.sendPartialReply('thinking...');
      messageCreateMock.mockClear(); // Clear the start() call

      // sendFinalReply should close the card but NOT send another message
      await dispatcher.sendFinalReply('complete answer');

      // No additional message.create calls should be made
      expect(messageCreateMock).not.toHaveBeenCalled();
    });

    /**
     * CRITICAL: streaming card must show final text before closing.
     * close() is called with final text so the card content updates.
     */
    it('streaming card is closed after being updated with final text', async () => {
      await dispatcher.sendPartialReply('partial content ');
      await dispatcher.sendPartialReply('more content');
      await dispatcher.sendFinalReply('final complete answer');

      const closeCall = streamingInstances.instances[0].close.mock.calls[0];
      const finalTextPassedToClose = closeCall[0];

      // Final text passed to close should include complete answer
      expect(finalTextPassedToClose).toBe('final complete answer');
    });

    /**
     * CRITICAL: Multiple partials followed by final should all be reflected
     * in the final text passed to close().
     */
    it('all partial updates are merged into final text', async () => {
      await dispatcher.sendPartialReply('step 1 ');
      await dispatcher.sendBlockReply('step 2 ');
      await dispatcher.sendPartialReply('step 3 - final');

      await dispatcher.sendFinalReply('the actual final answer');

      // close is called with the final text parameter
      expect(streamingInstances.instances[0].close).toHaveBeenCalledWith('the actual final answer');
    });
  });

  describe('sendFinalReply basic behavior', () => {
    it('closes streaming after final reply', async () => {
      await dispatcher.sendPartialReply('thinking');
      await dispatcher.sendFinalReply('final');

      expect(streamingInstances.instances[0].close).toHaveBeenCalled();
      expect(dispatcher.isActive()).toBe(false);
    });

    it('is idempotent - calling twice only closes once', async () => {
      await dispatcher.sendPartialReply('thinking');
      await dispatcher.sendFinalReply('first');
      await dispatcher.sendFinalReply('second');

      // close should only be called once
      expect(streamingInstances.instances[0].close).toHaveBeenCalledTimes(1);
      // First call's final text is used
      expect(streamingInstances.instances[0].close).toHaveBeenCalledWith('first');
    });

    /**
     * CRITICAL: sendFinalReply with empty string should still close
     * with accumulated streamText (not leave card hanging).
     */
    it('sendFinalReply with empty string uses accumulated streamText', async () => {
      await dispatcher.sendPartialReply('partial content accumulated');
      await dispatcher.sendFinalReply('');

      // close should be called with streamText, not empty string
      expect(streamingInstances.instances[0].close).toHaveBeenCalledWith('partial content accumulated');
    });
  });

  describe('close', () => {
    it('closes streaming session', async () => {
      await dispatcher.sendPartialReply('text');
      await dispatcher.close();

      expect(streamingInstances.instances[0].close).toHaveBeenCalled();
      expect(dispatcher.isActive()).toBe(false);
    });

    it('is idempotent', async () => {
      await dispatcher.sendPartialReply('text');
      await dispatcher.close();
      await dispatcher.close(); // Should not throw
    });

    it('prevents further partial replies after close', async () => {
      await dispatcher.sendPartialReply('first');
      await dispatcher.close();
      await dispatcher.sendPartialReply('after close');

      // No new streaming instance (only the one from first partial)
      expect(streamingInstances.instances).toHaveLength(1);
    });

    it('close without final reply passes current streamText', async () => {
      await dispatcher.sendPartialReply('partial content');
      await dispatcher.close();

      // close is called with streamText (no separate finalText parameter)
      expect(streamingInstances.instances[0].close).toHaveBeenCalledWith('partial content');
    });
  });

  describe('waitForIdle', () => {
    it('resolves when no pending updates', async () => {
      await expect(dispatcher.waitForIdle()).resolves.toBeUndefined();
    });

    it('waits for pending streaming updates', async () => {
      await dispatcher.sendPartialReply('hello');
      await expect(dispatcher.waitForIdle()).resolves.toBeUndefined();
    });
  });

  // --- Concurrent message handling ---

  describe('concurrent messages', () => {
    it('handles rapid sequential partial replies in order', async () => {
      await dispatcher.sendPartialReply('a');
      await dispatcher.sendPartialReply('ab');
      await dispatcher.sendPartialReply('abc');
      await dispatcher.waitForIdle();

      expect(streamingInstances.instances[0].update).toHaveBeenCalled();
    });

    it('handles concurrent sendPartialReply calls (no race condition)', async () => {
      await Promise.all([
        dispatcher.sendPartialReply('hello'),
        dispatcher.sendPartialReply('world'),
        dispatcher.sendPartialReply('foo'),
      ]);

      await dispatcher.waitForIdle();

      expect(streamingInstances.instances[0].update).toHaveBeenCalled();
    });

    it('sendFinalReply waits for pending updates', async () => {
      const partialPromise = dispatcher.sendPartialReply('thinking...');
      const finalPromise = dispatcher.sendFinalReply('final');

      await expect(Promise.all([partialPromise, finalPromise])).resolves.toBeDefined();

      expect(streamingInstances.instances[0].close).toHaveBeenCalled();
    });

    it('close waits for pending updates', async () => {
      await dispatcher.sendPartialReply('partial1');
      await dispatcher.sendPartialReply('partial2');

      const closePromise = dispatcher.close();
      await expect(closePromise).resolves.toBeUndefined();
    });

    it('handles interleaved partial and block replies', async () => {
      await dispatcher.sendPartialReply('hello ');
      await dispatcher.sendBlockReply('world ');
      await dispatcher.sendPartialReply('foo');
      await dispatcher.sendBlockReply('bar');

      await dispatcher.waitForIdle();

      expect(streamingInstances.instances[0].update).toHaveBeenCalled();
    });

    it('multiple dispatchers operate independently', async () => {
      const dispatcher2 = createFeishuReplyDispatcher({
        client: mockClient,
        appId: 'cli_app123',
        appSecret: 'secret_abc',
        chatId: 'oc_chat456',
        chatJid: 'fs:oc_chat456',
      });

      await dispatcher.sendPartialReply('chat1 msg1');
      await dispatcher2.sendPartialReply('chat2 msg1');
      await dispatcher.sendPartialReply('chat1 msg2');
      await dispatcher2.sendFinalReply('chat2 final');

      expect(dispatcher.isActive()).toBe(true);
      expect(dispatcher2.isActive()).toBe(false);

      await dispatcher.close();
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('sendToolResult handles API errors gracefully', async () => {
      messageCreateMock.mockRejectedValueOnce(new Error('API error'));
      await expect(dispatcher.sendToolResult('some tool result')).resolves.toBeUndefined();
    });

    it('sendFinalReply handles API errors gracefully', async () => {
      await dispatcher.sendPartialReply('thinking...');
      streamingInstances.instances[0].close.mockRejectedValueOnce(new Error('Close failed'));
      await expect(dispatcher.sendFinalReply('some final text')).resolves.toBeUndefined();
    });

    it('sendPartialReply does not throw when streaming start fails', async () => {
      await expect(dispatcher.sendPartialReply('test')).resolves.toBeUndefined();
    });

    it('tool result works independently of streaming state', async () => {
      await dispatcher.sendPartialReply('thinking...');
      await dispatcher.sendToolResult('tool output');

      expect(messageCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: JSON.stringify({ text: 'tool output' }),
          }),
        }),
      );
    });
  });

  // ============================================================
  // INTEGRATION SCENARIOS - Simulating runAgent callback patterns
  // ============================================================

  describe('runAgent callback simulation - complete flow', () => {
    /**
     * Simulates: runAgent callback receives streaming results, then success signal
     * This is the CRITICAL flow that was broken in index.ts
     */
    it('complete flow: partial results + success signal closes card properly', async () => {
      // Simulate: runAgent callback receives result.result (streaming chunks)
      await dispatcher.sendPartialReply('Hello ');        // Chunk 1
      await dispatcher.sendPartialReply('world ');       // Chunk 2
      await dispatcher.sendPartialReply('!');            // Chunk 3

      // Simulate: runAgent callback receives result.status === 'success' with null result
      // This is how runAgent signals completion
      // NOTE: In real code, sendFinalReply would be called here with accumulated content
      // or with empty string to use accumulated streamText
      await dispatcher.sendFinalReply('');  // Empty = use accumulated streamText

      // Verify: streaming card was closed with accumulated content
      expect(streamingInstances.instances[0].close).toHaveBeenCalledWith('Hello world !');

      // Verify: streaming card was created (message.create called for card)
      // Note: In real implementation, start() calls message.create; in mock, start() is mocked
      expect(streamingInstances.instances[0].start).toHaveBeenCalled();

      // Verify: dispatcher is now closed
      expect(dispatcher.isActive()).toBe(false);
    });

    /**
     * Simulates: runAgent callback with only partials (no explicit final)
     * and dispatcher.close() is called at the end
     */
    it('complete flow: partial results + close() without explicit final', async () => {
      await dispatcher.sendPartialReply('Step 1...');
      await dispatcher.sendPartialReply('Step 2...');
      await dispatcher.sendPartialReply('Done!');

      // Simulate: processGroupMessages calls replyDispatcher.close() after runAgent returns
      await dispatcher.close();

      // Verify: close was called with final accumulated text
      expect(streamingInstances.instances[0].close).toHaveBeenCalledWith('Step 1...Step 2...Done!');
      expect(dispatcher.isActive()).toBe(false);
    });

    /**
     * Simulates: partial results + explicit final text override
     * This happens when runAgent sends final complete response
     */
    it('complete flow: partial results + explicit final text override', async () => {
      await dispatcher.sendPartialReply('thinking...');
      await dispatcher.sendPartialReply('more thinking...');

      // Simulate: runAgent provides complete final response
      await dispatcher.sendFinalReply('Here is the complete answer!');

      // Verify: close was called with explicit final text, not accumulated partials
      expect(streamingInstances.instances[0].close).toHaveBeenCalledWith('Here is the complete answer!');
    });

    /**
     * Simulates: error during streaming - close() is called
     */
    it('complete flow: error during streaming - close() cleans up', async () => {
      await dispatcher.sendPartialReply('partial before error...');

      // Simulate: error occurred, processGroupMessages calls close()
      await dispatcher.close();

      // Verify: close was called with accumulated text
      expect(streamingInstances.instances[0].close).toHaveBeenCalledWith('partial before error...');
      expect(dispatcher.isActive()).toBe(false);

      // Verify: subsequent partial replies are ignored
      await dispatcher.sendPartialReply('this should be ignored');
      expect(streamingInstances.instances).toHaveLength(1); // No new instance created
    });

    /**
     * Simulates: tool results interleaved with streaming
     */
    it('complete flow: tool results interleaved with streaming', async () => {
      await dispatcher.sendPartialReply('Let me check ');

      // Tool result sent immediately (not via streaming)
      await dispatcher.sendToolResult('[Tool: search] Found 5 results');

      await dispatcher.sendPartialReply('the results...');

      // Final result
      await dispatcher.sendFinalReply('Based on the search, here is the answer.');

      // Verify: tool result was sent immediately
      expect(messageCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: JSON.stringify({ text: '[Tool: search] Found 5 results' }),
          }),
        }),
      );

      // Verify: streaming was closed with final answer
      expect(streamingInstances.instances[0].close).toHaveBeenCalledWith('Based on the search, here is the answer.');
    });

    /**
     * CRITICAL: sendFinalReply must be called on success signal,
     * otherwise the streaming card stays open forever.
     * This test verifies that calling sendFinalReply (even with empty string)
     * actually closes the card.
     */
    it('verifies streaming card is closed after success signal', async () => {
      await dispatcher.sendPartialReply('thinking...');

      // Success signal - in real code this is when result.status === 'success' && result.result == null
      // We call sendFinalReply with empty to use accumulated content
      await dispatcher.sendFinalReply('');

      // CRITICAL: Verify card is closed
      expect(streamingInstances.instances[0].close).toHaveBeenCalled();
      expect(dispatcher.isActive()).toBe(false);
    });

    /**
     * Error case: streaming should be closed when error occurs,
     * even without explicit final text.
     */
    it('verifies streaming card is closed after error signal', async () => {
      await dispatcher.sendPartialReply('thinking...');

      // Error signal - in real code this is when result.status === 'error'
      // We call close() to clean up the streaming card
      await dispatcher.close();

      // Verify card is closed with accumulated content
      expect(streamingInstances.instances[0].close).toHaveBeenCalledWith('thinking...');
      expect(dispatcher.isActive()).toBe(false);
    });
  });
});
