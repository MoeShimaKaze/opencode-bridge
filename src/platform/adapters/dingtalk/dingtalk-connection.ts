/**
 * 钉钉 WebSocket 连接管理
 *
 * 职责：
 * - 管理单个钉钉账号的 WebSocket 连接
 * - 使用 SDK 原生心跳检测
 * - 处理连接重连逻辑，带指数退避
 * - 消息去重
 *
 * 基于 dingtalk-stream SDK，轻量化实现
 */

import type { DingtalkConfig, DingtalkRawMessage, DingtalkCallbackData } from './dingtalk-types.js';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from './dingtalk-types.js';

// ──────────────────────────────────────────────
// 消息处理器类型
// ──────────────────────────────────────────────

export type DingtalkMessageHandler = (params: {
  accountId: string;
  data: DingtalkRawMessage;
  sessionWebhook: string;
}) => Promise<void>;

// ──────────────────────────────────────────────
// 连接配置
// ──────────────────────────────────────────────

export interface DingtalkConnectionOpts {
  accountId: string;
  config: DingtalkConfig;
  messageHandler: DingtalkMessageHandler;
  abortSignal?: AbortSignal;
}

// ──────────────────────────────────────────────
// 消息去重
// ──────────────────────────────────────────────

const processedMessages = new Map<string, number>();
const DEDUP_TTL = 5 * 60 * 1000; // 5 分钟

function isMessageProcessed(messageId: string): boolean {
  const now = Date.now();
  const lastTime = processedMessages.get(messageId);
  if (lastTime && now - lastTime < DEDUP_TTL) {
    return true;
  }
  // 清理过期记录
  if (processedMessages.size > 1000) {
    for (const [id, time] of processedMessages) {
      if (now - time > DEDUP_TTL) {
        processedMessages.delete(id);
      }
    }
  }
  return false;
}

function markMessageProcessed(messageId: string): void {
  processedMessages.set(messageId, Date.now());
}

// ──────────────────────────────────────────────
// 连接管理类
// ──────────────────────────────────────────────

export class DingtalkConnection {
  private readonly accountId: string;
  private readonly config: DingtalkConfig;
  private readonly messageHandler: DingtalkMessageHandler;
  private readonly abortSignal?: AbortSignal;

  private client: any = null;
  private topicRobot: string | undefined;
  private isStopped = false;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private observedSocket: any = null;

  constructor(opts: DingtalkConnectionOpts) {
    this.accountId = opts.accountId;
    this.config = opts.config;
    this.messageHandler = opts.messageHandler;
    this.abortSignal = opts.abortSignal;
  }

  /**
   * 启动连接
   */
  async start(): Promise<void> {
    console.log(`[钉钉][${this.accountId}] 正在建立连接...`);

    // 禁用 axios 全局代理
    try {
      const axios = (await import('axios')).default;
      if (axios.defaults) {
        axios.defaults.proxy = false;
      }
    } catch {
      // ignore
    }

    // 动态导入 dingtalk-stream
    const dingtalkStreamModule = await import('dingtalk-stream');
    const DWClient = dingtalkStreamModule.DWClient;
    const TOPIC_ROBOT = dingtalkStreamModule.TOPIC_ROBOT;

    if (!DWClient) {
      throw new Error('无法导入 dingtalk-stream 模块中的 DWClient');
    }

    // 存储 TOPIC_ROBOT 供 connect 方法使用
    this.topicRobot = TOPIC_ROBOT;

    // 创建客户端
    this.client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      debug: this.config.debug,
      endpoint: this.config.endpoint || 'https://api.dingtalk.com',
      autoReconnect: false, // 使用自定义重连
      keepAlive: true, // 使用 SDK 心跳，兼容 DingTalk 的 SYSTEM/KEEPALIVE 与 WebSocket pong
    } as any);

    // 设置事件监听
    this.setupEventListeners();

    // 建立连接
    await this.connect();
  }

  /**
   * 停止连接
   */
  stop(): void {
    this.isStopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.client?.disconnect();

    if (this.client?.socket) {
      this.client.socket.removeAllListeners();
    }
    this.observedSocket = null;

    console.log(`[钉钉][${this.accountId}] 连接已停止`);
  }

  /**
   * 建立连接
   */
  private async connect(): Promise<void> {
    const TOPIC_ROBOT = this.topicRobot || 'dingtalk.robotoam.message';
    let receivedCount = 0;
    let processedCount = 0;

    console.log(`[钉钉][${this.accountId}] 注册消息回调，主题: ${TOPIC_ROBOT}`);

    // 注册消息回调
    this.client.registerCallbackListener(TOPIC_ROBOT, async (res: DingtalkCallbackData) => {
      receivedCount++;
      const messageId = res.headers?.messageId;
      const receivedAt = new Date().toISOString();
      const messageLabel = messageId || 'unknown';

      console.log(`[钉钉][${this.accountId}][${receivedAt}] 收到消息回调: messageId=${messageLabel}, topic=${res.headers?.topic || TOPIC_ROBOT}`);

      // 立即确认回调
      if (messageId) {
        try {
          this.client.socketCallBackResponse(messageId, { success: true });
          console.log(`[钉钉][${this.accountId}][${new Date().toISOString()}] 已发送消息确认: messageId=${messageLabel}`);
        } catch (error: any) {
          console.error(`[钉钉][${this.accountId}][${new Date().toISOString()}] 消息确认失败: messageId=${messageLabel}, error=${error?.message || String(error)}`);
        }
      }

      // 消息去重
      if (messageId && isMessageProcessed(messageId)) {
        processedCount++;
        console.log(`[钉钉][${this.accountId}][${new Date().toISOString()}] 跳过重复消息: messageId=${messageLabel}`);
        return;
      }

      if (messageId) {
        markMessageProcessed(messageId);
      }

      const processingStartedAt = Date.now();
      let processingResult: 'success' | 'error' = 'success';
      try {
        // 解析消息数据
        const data = JSON.parse(res.data) as DingtalkRawMessage;

        console.log(`[钉钉][${this.accountId}][${new Date().toISOString()}] 开始处理消息: messageId=${messageLabel}, msgId=${data.msgId || 'unknown'}, 类型=${data.msgtype || 'unknown'}`);

        await this.messageHandler({
          accountId: this.accountId,
          data,
          sessionWebhook: data.sessionWebhook,
        });

        processedCount++;
      } catch (error: any) {
        processingResult = 'error';
        processedCount++;
        console.error(`[钉钉][${this.accountId}][${new Date().toISOString()}] 消息处理错误: messageId=${messageLabel}, error=${error?.message || String(error)}`);
      } finally {
        const durationMs = Date.now() - processingStartedAt;
        console.log(`[钉钉][${this.accountId}][${new Date().toISOString()}] 消息处理完成: messageId=${messageLabel}, result=${processingResult}, durationMs=${durationMs}`);
      }
    });

    // 连接
    try {
      await this.client.connect();
      if (!this.client.connected) {
        throw new Error('钉钉 Stream SDK 未能建立 WebSocket 连接');
      }
      this.attachSocketListeners();

      console.log(`[钉钉][${this.accountId}] 连接成功`);
    } catch (error: any) {
      this.handleConnectionError(error);
      throw error;
    }
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    this.client.on('error', (err: Error) => {
      console.error(`[钉钉][${this.accountId}] 连接错误:`, err.message);
    });
  }

  /** SDK 在 connect() 内才创建 socket，必须在连接建立后绑定 socket 事件。 */
  private attachSocketListeners(): void {
    const socket = this.client?.socket;
    if (!socket || this.observedSocket === socket) return;
    this.observedSocket = socket;

    socket.on('message', (data: any) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'SYSTEM' && msg.headers?.topic === 'disconnect') {
          this.scheduleReconnect(true);
        }
      } catch {
        // ignore
      }
    });

    socket.on('close', (code: number, reason: Buffer) => {
      console.log(`[钉钉][${this.accountId}] WebSocket 已关闭: code=${code}, reason=${reason?.toString() || ''}`);
      if (this.observedSocket === socket) this.observedSocket = null;
      this.scheduleReconnect(true);
    });

    socket.on('error', (err: Error) => {
      console.error(`[钉钉][${this.accountId}] WebSocket 错误:`, err.message);
    });
  }

  private scheduleReconnect(immediate = false): void {
    if (this.isStopped || this.isReconnecting || this.reconnectTimer) return;

    const delay = immediate || this.reconnectAttempts === 0
      ? 0
      : Math.min(
        BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts - 1) + Math.random() * 1000,
        BACKOFF_MAX_MS
      );
    if (delay > 0) {
      console.log(`[钉钉][${this.accountId}] 等待 ${Math.round(delay / 1000)} 秒后重连 (第 ${this.reconnectAttempts + 1} 次)`);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doReconnect().catch(err => {
        console.error(`[钉钉][${this.accountId}] 重连失败:`, err.message);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * 执行重连
   */
  private async doReconnect(): Promise<void> {
    if (this.isReconnecting || this.isStopped) return;

    this.isReconnecting = true;

    try {
      // 断开旧连接
      if (this.client?.socket?.readyState === 1 || this.client?.socket?.readyState === 3) {
        await this.client.disconnect();
      }

      // 重新连接
      await this.client.connect();
      if (!this.client.connected) {
        throw new Error('钉钉 Stream SDK 未能建立 WebSocket 连接');
      }
      this.attachSocketListeners();
      this.reconnectAttempts = 0;

      console.log(`[钉钉][${this.accountId}] 重连成功`);
    } catch (err: any) {
      this.reconnectAttempts++;
      console.error(`[钉钉][${this.accountId}] 重连失败 (第 ${this.reconnectAttempts} 次):`, err.message);
      throw err;
    } finally {
      this.isReconnecting = false;
    }
  }

  /**
   * 处理连接错误
   */
  private handleConnectionError(error: any): void {
    const status = error?.response?.status;

    if (status === 400 || error.message?.includes('400')) {
      throw new Error(
        `[钉钉][${this.accountId}] 请求格式错误 (400): clientId 或 clientSecret 格式无效`
      );
    }

    if (status === 401 || error.message?.includes('401')) {
      throw new Error(
        `[钉钉][${this.accountId}] 认证失败 (401): 凭据无效`
      );
    }

    throw new Error(
      `[钉钉][${this.accountId}] 连接失败: ${error.message}`
    );
  }
}
