/**
 * 钉钉 WebSocket 连接管理
 *
 * 职责：
 * - 管理单个钉钉账号的 WebSocket 连接
 * - 实现应用层心跳检测
 * - 处理连接重连逻辑，带指数退避
 * - 消息去重
 *
 * 基于 dingtalk-stream SDK，轻量化实现
 */

import type { DingtalkConfig, DingtalkRawMessage, DingtalkCallbackData } from './dingtalk-types.js';
import { HEARTBEAT_INTERVAL, TIMEOUT_THRESHOLD, BACKOFF_BASE_MS, BACKOFF_MAX_MS } from './dingtalk-types.js';

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
  private lastSocketAvailableTime = Date.now();
  private connectionEstablishedTime = Date.now();
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private keepAliveTimer: NodeJS.Timeout | null = null;

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
      keepAlive: false, // 使用自定义心跳
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

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }

    if (this.client?.socket) {
      this.client.socket.removeAllListeners();
    }

    console.log(`[钉钉][${this.accountId}] 连接已停止`);
  }

  /**
   * 建立连接
   */
  private async connect(): Promise<void> {
    const TOPIC_ROBOT = this.topicRobot || 'dingtalk.robotoam.message';
    let receivedCount = 0;
    let processedCount = 0;
    let lastMessageTime = Date.now();

    console.log(`[钉钉][${this.accountId}] 注册消息回调，主题: ${TOPIC_ROBOT}`);

    // 注册消息回调
    this.client.registerCallbackListener(TOPIC_ROBOT, async (res: DingtalkCallbackData) => {
      receivedCount++;
      lastMessageTime = Date.now();
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
      this.connectionEstablishedTime = Date.now();
      this.lastSocketAvailableTime = Date.now();

      console.log(`[钉钉][${this.accountId}] 连接成功`);

      // 启动心跳
      this.startKeepAlive();
    } catch (error: any) {
      this.handleConnectionError(error);
      throw error;
    }
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    // pong 响应
    this.client.socket?.on('pong', () => {
      this.lastSocketAvailableTime = Date.now();
    });

    // disconnect 消息
    this.client.socket?.on('message', (data: any) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'SYSTEM' && msg.headers?.topic === 'disconnect') {
          if (!this.isStopped && !this.isReconnecting) {
            this.doReconnect(true).catch(err => {
              console.error(`[钉钉][${this.accountId}] 重连失败:`, err.message);
            });
          }
        }
      } catch {
        // ignore
      }
    });

    // close 事件
    this.client.socket?.on('close', (code: number, reason: string) => {
      console.log(`[钉钉][${this.accountId}] WebSocket 已关闭: code=${code}, reason=${reason}`);

      if (this.isStopped) return;

      setTimeout(() => {
        this.doReconnect(true).catch(err => {
          console.error(`[钉钉][${this.accountId}] 重连失败:`, err.message);
        });
      }, 0);
    });

    // error 事件
    this.client.on('error', (err: Error) => {
      console.error(`[钉钉][${this.accountId}] 连接错误:`, err.message);
    });
  }

  /**
   * 启动心跳检测
   */
  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(async () => {
      if (this.isStopped) {
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        return;
      }

      try {
        const elapsed = Date.now() - this.lastSocketAvailableTime;

        // 超时检测
        if (elapsed > TIMEOUT_THRESHOLD) {
          console.log(`[钉钉][${this.accountId}] 检测到超时，正在重连...`);
          await this.doReconnect();
          return;
        }

        // 检查 socket 状态
        const socketState = this.client?.socket?.readyState;
        const timeSinceConnection = Date.now() - this.connectionEstablishedTime;

        // 15 秒宽限期
        if (socketState !== 1) {
          if (timeSinceConnection < 15_000) return;

          console.log(`[钉钉][${this.accountId}] Socket 状态=${socketState}，正在重连...`);
          await this.doReconnect(true);
          return;
        }

        // 发送 ping
        try {
          this.client?.socket?.ping();
        } catch (err: any) {
          console.warn(`[钉钉][${this.accountId}] Ping 失败:`, err.message);
        }
      } catch (err: any) {
        console.error(`[钉钉][${this.accountId}] 心跳检测错误:`, err.message);
      }
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * 执行重连
   */
  private async doReconnect(immediate = false): Promise<void> {
    if (this.isReconnecting || this.isStopped) return;

    this.isReconnecting = true;

    if (!immediate && this.reconnectAttempts > 0) {
      const delay = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts - 1) + Math.random() * 1000,
        BACKOFF_MAX_MS
      );
      console.log(`[钉钉][${this.accountId}] 等待 ${Math.round(delay / 1000)} 秒后重连 (第 ${this.reconnectAttempts + 1} 次)`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
      // 断开旧连接
      if (this.client?.socket?.readyState === 1 || this.client?.socket?.readyState === 3) {
        await this.client.disconnect();
      }

      // 重新连接
      await this.client.connect();

      this.lastSocketAvailableTime = Date.now();
      this.connectionEstablishedTime = Date.now();
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
