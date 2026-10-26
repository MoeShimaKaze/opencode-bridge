import { Request, Response } from 'express';
import { chatEventBus } from '../chat/event-bus.js';
import type { AddressedChatEvent } from '../chat/types.js';
import { chatAuthMiddleware } from './chat-auth.js';
import { opencodeClient } from '../../opencode/client.js';
import type { ChatQuestionRequest } from '../chat/types.js';

interface SSEQuery {
  session_id?: string;
  since?: string;
}

function writeEvent(res: Response, addressedEvent: AddressedChatEvent): void {
  const data = JSON.stringify(addressedEvent.event);
  res.write(`id: ${addressedEvent.seq}\nevent: ${addressedEvent.event.type}\ndata: ${data}\n\n`);
}

function parseSinceSeq(req: Request): number | undefined {
  const query = req.query as SSEQuery;
  const candidates = [
    typeof query.since === 'string' ? query.since : undefined,
    typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined,
  ];

  for (const value of candidates) {
    if (!value) continue;
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

export async function sseHandler(req: Request, res: Response): Promise<void> {
  const query = req.query as SSEQuery;
  const sessionId = typeof query.session_id === 'string' ? query.session_id : undefined;
  const sinceSeq = parseSinceSeq(req);
  const clientId = Math.random().toString(36).substring(7);

  // Windows 上 Nagle + receive-buffer 聚合会让小 SSE 包延迟数秒后才送达浏览器，
  // 表现为「OpenCode 已经回包，但页面要刷新才看见」。这里强制 NoDelay 并启用
  // TCP keepalive，避免长连接中途被中间层静默关闭却没触发 close 事件。
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true, 15000);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(`id: 0\nevent: connected\ndata: {"clientId":"${clientId}"}\n\n`);
  let closed=false;
  let hydrated=false;
  const questionsDuringHydration=new Map<string,ChatQuestionRequest>();
  const resolvedDuringHydration=new Set<string>();

  const eventHandler = (addressedEvent: AddressedChatEvent) => {
    if (sessionId && addressedEvent.sessionId !== sessionId) {
      return;
    }
    if(!hydrated && addressedEvent.event.type==='question_resolved')resolvedDuringHydration.add(addressedEvent.event.reqId);
    if(!hydrated && addressedEvent.event.type==='question_ask')questionsDuringHydration.set(addressedEvent.event.req.id,addressedEvent.event.req);

    try {
      writeEvent(res, addressedEvent);
    } catch (err) {
      console.error('[Chat Events] Failed to write SSE event:', err, clientId);
    }
  };

  if (sessionId) {
    for (const snapshotEvent of chatEventBus.snapshot(sessionId, sinceSeq)) {
      writeEvent(res, snapshotEvent);
    }
  }

  const unsubscribe = sessionId
    ? chatEventBus.subscribe(sessionId, eventHandler)
    : (() => {
        chatEventBus.on('publish', eventHandler);
        return () => chatEventBus.off('publish', eventHandler);
      })();

  // 5s 心跳：足够穿透 Windows TCP keepalive/中间反代的空闲超时，又不会显著增加流量。
  const keepalive = setInterval(() => {
    res.write('event: keepalive\ndata: {"type":"keepalive"}\n\n');
  }, 5000);

  console.log('[Chat Events] SSE client connected:', clientId, sessionId);

  req.on('close', () => {
    closed=true;
    clearInterval(keepalive);
    unsubscribe();
    console.log('[Chat Events] SSE client disconnected:', clientId);
  });
  if(sessionId)void (async()=>{
    try{
      const pending=new Map((await opencodeClient.listPendingQuestions({sessionId})).map(question=>[question.id,question]));
      for(const [id,question] of questionsDuringHydration)pending.set(id,question);
      for(const id of resolvedDuringHydration)pending.delete(id);
      if(!closed)res.write(`event: questions_snapshot\ndata: ${JSON.stringify({type:'questions_snapshot',requests:[...pending.values()].filter(question=>question.sessionID===sessionId)})}\n\n`);
    }catch(error){
      console.warn('[Chat Events] 读取待回答问题失败:',error instanceof Error?error.message:String(error));
      if(!closed)res.write(`event: error\ndata: ${JSON.stringify({type:'error',message:'读取交互问题失败，请重新连接'})}\n\n`);
    }finally{hydrated=true;questionsDuringHydration.clear();resolvedDuringHydration.clear();}
  })();
}

export function registerChatEventsRoutes(app: any): void {
  app.get('/api/chat/events', chatAuthMiddleware, sseHandler);
  console.log('[Chat Routes] Chat events route registered: GET /api/chat/events');
}
