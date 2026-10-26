import { outputConfig } from '../config.js';

export interface BufferedContentUpdate {
  text: string;
  thinking: string;
  replaceText?: string;
  replaceThinking?: string;
}

/** Apply authoritative replacements before fragments that arrived after the snapshot. */
export function applyBufferedContent(current: { text: string; thinking: string }, update: BufferedContentUpdate): { text: string; thinking: string } {
  return { text: (update.replaceText ?? current.text) + update.text, thinking: (update.replaceThinking ?? current.thinking) + update.thinking };
}

// 输出缓冲区（用于聚合输出后定时发送）
interface BufferedOutput {
  key: string;
  generation: number;
  deliveryFailures:number;
  chatId: string;
  messageId: string | null;
  thinkingMessageId: string | null;
  replyMessageId: string | null;
  sessionId: string;
  content: string[];
  thinking: string[]; // 存储思考片段
  textParts: Map<string, string>;
  thinkingParts: Map<string, string>;
  replaceText?: string;
  replaceThinking?: string;
  tools: Array<{
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    output?: string;
  }>;
  finalText: string;
  finalThinking: string;
  openCodeMsgId: string;
  showThinking: boolean;
  dirty: boolean;
  lastUpdate: number;
  timer: NodeJS.Timeout | null;
  status: 'running' | 'completed' | 'failed' | 'aborted';
}

class OutputBuffer {
  private buffers: Map<string, BufferedOutput> = new Map();
  private updateCallback: ((buffer: BufferedOutput) => Promise<void>) | null = null;
  private createCallback: ((key: string) => void) | null = null;
  private readonly updates = new Map<string, Promise<void>>();
  private generation = 0;

  // 设置更新回调
  setUpdateCallback(callback: (buffer: BufferedOutput) => Promise<void>): void {
    this.updateCallback = callback;
  }

  setCreateCallback(callback: (key: string) => void): void {
    this.createCallback = callback;
  }

  isCurrent(buffer: Pick<BufferedOutput, 'key' | 'generation'>): boolean {
    return this.buffers.get(buffer.key)?.generation === buffer.generation;
  }

  // 创建或获取缓冲区
  getOrCreate(key: string, chatId: string, sessionId: string, replyMessageId: string | null): BufferedOutput {
    let buffer = this.buffers.get(key);

    if (!buffer) {
      this.createCallback?.(key);
      buffer = {
        key,
        generation: ++this.generation,
        deliveryFailures:0,
        chatId,
        messageId: null,
        thinkingMessageId: null,
        replyMessageId,
        sessionId,
        content: [],
        thinking: [],
        textParts: new Map(),
        thinkingParts: new Map(),
        tools: [],
        finalText: '',
        finalThinking: '',
        openCodeMsgId: '',
        showThinking: false,
        dirty: false,
        lastUpdate: Date.now(),
        timer: null,
        status: 'running',
      };
      this.buffers.set(key, buffer);
    }

    return buffer;
  }

  // 追加内容
  append(key: string, text: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;

    buffer.content.push(text);
    buffer.dirty = true;
    this.scheduleUpdate(key);
  }

  // 追加思考内容
  appendThinking(key: string, text: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;

    buffer.thinking.push(text);
    buffer.dirty = true;
    this.scheduleUpdate(key);
  }

  trackPart(key: string, type: 'text' | 'reasoning', id: string, text: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) (type === 'text' ? buffer.textParts : buffer.thinkingParts).set(id, text);
  }

  replacePart(key: string, type: 'text' | 'reasoning', id: string, text: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    this.trackPart(key, type, id, text);
    if (type === 'text') {
      buffer.replaceText = Array.from(buffer.textParts.values()).join('');
      buffer.content = [];
    } else {
      buffer.replaceThinking = Array.from(buffer.thinkingParts.values()).join('');
      buffer.thinking = [];
    }
    this.touch(key);
  }

  // 设置正文卡片消息ID
  setMessageId(key: string, messageId: string): void {

    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.messageId = messageId;
    }
  }

  // 设置思考卡片消息ID
  setThinkingMessageId(key: string, messageId: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.thinkingMessageId = messageId;
    }
  }

  // 设置工具状态快照
  setTools(
    key: string,
    tools: Array<{ name: string; status: 'pending' | 'running' | 'completed' | 'failed'; output?: string }>
  ): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.tools = [...tools];
      buffer.dirty = true;
      this.scheduleUpdate(key);
    }
  }

  touch(key: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    buffer.dirty = true;
    this.scheduleUpdate(key);
  }

  // 设置最终文本和思考快照
  setFinalSnapshot(key: string, text: string, thinking: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.finalText = text;
      buffer.finalThinking = thinking;
    }
  }

  // 设置 OpenCode 消息ID
  setOpenCodeMsgId(key: string, openCodeMsgId: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.openCodeMsgId = openCodeMsgId;
    }
  }

  // 设置思考展开状态
  setShowThinking(key: string, showThinking: boolean): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.showThinking = showThinking;
    }
  }

  // 设置状态
  setStatus(key: string, status: BufferedOutput['status']): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.status = status;
      buffer.dirty = true;
      // 状态变化时立即触发更新
      this.triggerUpdate(key);
    }
  }

  // 调度更新
  private scheduleUpdate(key: string, delay=outputConfig.updateInterval): void {
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.timer) return;

    buffer.timer = setTimeout(() => {
      // 再次检查 buffer 是否仍然存在（可能在定时器触发前被 clearAll 清理）
      const currentBuffer = this.buffers.get(key);
      if (currentBuffer !== buffer) return;
      this.triggerUpdate(key);
    }, delay);
  }

  // 触发更新
  private async triggerUpdate(key: string): Promise<void> {
    const buffer = this.buffers.get(key);
    if (!buffer) return;

    // 清除定时器
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    const previous = this.updates.get(key) ?? Promise.resolve();
    const update = previous.then(async () => {
      if (!this.isCurrent(buffer) || !this.updateCallback || (!buffer.dirty && buffer.status === 'running')) return;
      buffer.lastUpdate = Date.now();
      buffer.dirty = false;
      // Status must describe this flush, even if completion arrives while HTTP is pending.
      const snapshot = { ...buffer, tools: [...buffer.tools] };
      try { await this.updateCallback(snapshot); if(this.isCurrent(buffer))buffer.deliveryFailures=0; }
      catch (error) {
        if (this.isCurrent(buffer)) {
          buffer.dirty = true;
          if(buffer.status!=='running' && buffer.deliveryFailures<3){
            buffer.deliveryFailures+=1;
            this.scheduleUpdate(key,1000*Math.pow(2,buffer.deliveryFailures-1));
          }
        }
        console.error('[outputBuffer] 更新失败:', error);
      }
    });
    this.updates.set(key, update);
    await update;
    if (this.updates.get(key) === update) this.updates.delete(key);
  }

  // 获取并清空内容
  getAndClear(key: string): BufferedContentUpdate {
    const buffer = this.buffers.get(key);
    if (!buffer) return { text: '', thinking: '' };

    const text = buffer.content.join('');
    buffer.content = [];
    
    const thinking = buffer.thinking.join('');
    buffer.thinking = [];
    
    const update = { text, thinking,
      ...(buffer.replaceText !== undefined ? { replaceText: buffer.replaceText } : {}),
      ...(buffer.replaceThinking !== undefined ? { replaceThinking: buffer.replaceThinking } : {}) };
    buffer.replaceText = undefined;
    buffer.replaceThinking = undefined;
    return update;
  }


  // 清理缓冲区
  clear(key: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }
      this.buffers.delete(key);
    }
  }

  // 获取缓冲区
  get(key: string): BufferedOutput | undefined {
    return this.buffers.get(key);
  }

  // 中断输出
  abort(key: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
      buffer.status = 'aborted';
      // 触发最后一次更新
      void this.triggerUpdate(key).then(() => {
        if (this.isCurrent(buffer) && !buffer.dirty) this.clear(key);
      });
    }
  }

  // 清理所有缓冲区和定时器
  clearAll(): void {
    for (const buffer of this.buffers.values()) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
    }
    this.buffers.clear();
  }
}

// 单例导出
export const outputBuffer = new OutputBuffer();
