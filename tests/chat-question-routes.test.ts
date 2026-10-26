import express from 'express';
import { createServer,type Server } from 'node:http';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const client=vi.hoisted(()=>({listPendingQuestions:vi.fn(),replyQuestion:vi.fn(),rejectQuestion:vi.fn(),emit:vi.fn()}));
vi.mock('../src/opencode/client.js',()=>({opencodeClient:client}));
vi.mock('../src/admin/routes/chat-auth.js',()=>({chatAuthMiddleware:(_req:any,_res:any,next:any)=>next()}));
import { registerChatQuestionRoutes } from '../src/admin/routes/chat-question.js';
import { registerChatEventsRoutes } from '../src/admin/routes/chat-events.js';
import { chatEventBus } from '../src/admin/chat/event-bus.js';
let server:Server;let base:string;
const question={id:'frm_one',sessionID:'ses_one',questions:[{header:'Login',question:'Continue?',options:[],custom:true}]};
beforeEach(async()=>{
  vi.clearAllMocks();client.listPendingQuestions.mockResolvedValue([question]);client.replyQuestion.mockResolvedValue({ok:true});client.rejectQuestion.mockResolvedValue({ok:true});
  const app=express();app.use(express.json());registerChatQuestionRoutes(app);registerChatEventsRoutes(app);server=createServer(app);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as any).port}/api/chat`;
});
afterEach(async()=>{chatEventBus.clearSession('ses_one');server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
const answer=(id='frm_one',body:any={sessionId:'ses_one',answers:[['Login']]})=>fetch(base+`/questions/${id}/reply`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
it('lists pending questions and replies using the exact request ID and structured answer',async()=>{
  expect(await(await fetch(base+'/questions?sessionId=ses_one')).json()).toEqual({questions:[question]});
  expect((await answer()).status).toBe(200);
  expect(client.replyQuestion).toHaveBeenCalledWith('frm_one',[['Login']]);
  expect(client.emit).toHaveBeenCalledWith('questionResolved',{sessionID:'ses_one',id:'frm_one',status:'answered'});
});
it('rejects a request belonging to a different session instead of answering it',async()=>{
  client.listPendingQuestions.mockResolvedValue([{...question,sessionID:'ses_other'}]);
  expect((await answer()).status).toBe(404);expect(client.replyQuestion).not.toHaveBeenCalled();
});
it.each([{}, {sessionId:'ses_one',answers:['Login']},{sessionId:'ses_one',answers:[[false]]}])('rejects malformed answers without changing the pending question',async body=>{
  expect((await answer('frm_one',body)).status).toBe(400);expect(client.replyQuestion).not.toHaveBeenCalled();
});
it('keeps failed answers pending for retry and reports an expired request separately',async()=>{
  client.replyQuestion.mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:false,expired:true});
  expect((await answer()).status).toBe(502);expect(client.emit).not.toHaveBeenCalled();
  expect((await answer()).status).toBe(410);
});
it('hydrates a pending question through SSE even when its creation event was missed',async()=>{
  const response=await fetch(base+'/events?session_id=ses_one');const reader=response.body!.getReader();let text='';
  try{while(!text.includes('event: questions_snapshot')){const next=await reader.read();text+=new TextDecoder().decode(next.value);}}
  finally{await reader.cancel();}
  expect(text).toContain('"requests":[{"id":"frm_one"');
});
