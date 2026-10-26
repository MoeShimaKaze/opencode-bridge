import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { OpenCodeTransport } from '../src/opencode/transport.js';
import { createOpencodeClient } from '@opencode-ai/sdk';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } });
async function fixture(handler: (req: IncomingMessage, body: any, res: ServerResponse) => void) {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.24' })); return; }
    handler(req, text ? JSON.parse(text) : undefined, res);
  });
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as {port: number}).port}`;
}
const send = (res: ServerResponse, data: unknown) => res.end(JSON.stringify(data));

describe('native OpenCode compatibility transport', () => {
  it('collects all session pages and preserves native IDs and directories', async () => {
    const calls: string[] = [];
    const baseUrl = await fixture((req, _body, res) => {
      calls.push(req.url!); const url = new URL(req.url!, 'http://fixture');
      if (url.pathname !== '/api/session') { res.statusCode = 404; send(res, {}); return; }
      const second = url.searchParams.get('cursor') === 'page2';
      send(res, {data:[{id:second?'ses_second':'ses_shared',location:{directory:'C:/Project'},time:{created:1,updated:2}}],cursor:second?{}:{next:'page2'}});
    });
    const transport = new OpenCodeTransport({baseUrl});
    const sdk=createOpencodeClient({baseUrl,fetch:transport.fetch});
    const result = (await sdk.session.list({query:{directory:'C:/Project'}})).data as any[];
    expect(result.map((s: any) => s.id)).toEqual(['ses_shared','ses_second']);
    expect(result[0].directory).toBe('C:/Project');
    expect(calls).toHaveLength(2); expect(calls[1]).toContain('cursor=page2');
  });

  it('continues the same session, translates files and applies only explicit selections', async () => {
    const calls: Array<{path:string;body:any}> = [];
    const baseUrl = await fixture((req, body, res) => {calls.push({path:req.url!,body});send(res,{data:{id:'msg_prompt'}});});
    const transport = new OpenCodeTransport({baseUrl});
    const post = (body: any) => transport.fetch(`${baseUrl}/session/ses_shared/prompt_async`,{method:'POST',body:JSON.stringify(body)});
    expect((await post({parts:[{type:'text',text:'continue'}]})).status).toBe(204);
    expect(calls).toEqual([{path:'/api/session/ses_shared/prompt',body:{text:'continue'}}]);
    calls.length=0;
    await post({parts:[{type:'text',text:'question'},{type:'file',url:'data:text/plain;base64,SGk=',filename:'note.txt'}],agent:'review',model:{providerID:'custom',modelID:'model-a'},variant:'high'});
    expect(calls).toEqual([
      {path:'/api/session/ses_shared/agent',body:{agent:'review'}},
      {path:'/api/session/ses_shared/model',body:{model:{providerID:'custom',id:'model-a',variant:'high'}}},
      {path:'/api/session/ses_shared/prompt',body:{text:'question',files:[{uri:'data:text/plain;base64,SGk=',name:'note.txt'}]}},
    ]);
  });

  it('maps permission decisions without accepting HTML or changing failed requests', async () => {
    let actual: any;
    const baseUrl = await fixture((req,body,res) => {actual={path:req.url,body};res.statusCode=403;send(res,{message:'denied'});});
    const transport = new OpenCodeTransport({baseUrl});
    const response=await transport.fetch(`${baseUrl}/session/ses_shared/permissions/per_one`,{method:'POST',body:JSON.stringify({response:'once'})});
    expect(response.status).toBe(403);
    expect(actual).toEqual({path:'/api/session/ses_shared/permission/per_one/reply',body:{decision:'once'}});
  });

  it('loads history pages in chronological order and converts native content', async () => {
    const baseUrl=await fixture((req,_body,res)=>{
      const page2=new URL(req.url!,'http://fixture').searchParams.has('cursor');
      send(res,{data:page2?[{id:'msg_reply',type:'assistant',time:{created:20},content:[{type:'text',text:'answer'}]}]:[{id:'msg_user',type:'user',time:{created:10},text:'question'}],cursor:page2?{}:{next:'next'}});
    });
    const transport=new OpenCodeTransport({baseUrl});
    const messages=await(await transport.fetch(`${baseUrl}/session/ses_shared/message`)).json();
    expect(messages.map((m:any)=>[m.info.id,m.info.sessionID])).toEqual([['msg_user','ses_shared'],['msg_reply','ses_shared']]);
    expect(messages[1].parts[0].text).toBe('answer');
  });

  it('uses native location query syntax for Agents and retains IDs instead of display names',async()=>{
    const baseUrl=await fixture((req,_body,res)=>{expect(new URL(req.url!,'http://fixture').searchParams.get('location[directory]')).toBe('C:/Project');send(res,{location:{directory:'C:/Project'},data:[{id:'review',name:'Review Agent',mode:'primary'}]});});
    const transport=new OpenCodeTransport({baseUrl,defaultDirectory:'C:/Project'});
    expect(await(await transport.fetch(`${baseUrl}/agent`)).json()).toMatchObject([{name:'review',mode:'primary'}]);
  });

  it('translates fragmented native SSE and releases the underlying stream on cancel',async()=>{
    const baseUrl=await fixture((_req,_body,res)=>{
      res.setHeader('content-type','text/event-stream');
      const events=[{id:'evt_start',created:1,type:'session.text.started',data:{sessionID:'ses_shared',assistantMessageID:'msg_reply',ordinal:0}},{id:'evt_delta',created:2,type:'session.text.delta',data:{sessionID:'ses_shared',assistantMessageID:'msg_reply',ordinal:0,delta:'hello'}},{id:'evt_end',created:3,type:'session.text.ended',data:{sessionID:'ses_shared',assistantMessageID:'msg_reply',ordinal:0,text:'hello'}}];
      const data=events.map(e=>`data: ${JSON.stringify(e)}\r\n\r\n`).join('');res.write(data.slice(0,47));res.end(data.slice(47));
    });
    const transport=new OpenCodeTransport({baseUrl});const response=await transport.fetch(`${baseUrl}/event`);
    const text=await response.text();expect(text).toContain('message.part.updated');expect(text).toContain('ses_shared');expect(text).not.toContain('session.text.delta');
  });

  it('fails on authentication errors instead of falling back to the legacy API',async()=>{
    const transport=new OpenCodeTransport({baseUrl:'http://fixture',fetch:async()=>new Response('{}',{status:401,headers:{'content-type':'application/json'}})});
    await expect(transport.fetch('http://fixture/session')).rejects.toThrow(/401/);
  });

  it('preserves legacy server requests and does not forward credentials across origins',async()=>{
    const seen:string[]=[];
    const transport=new OpenCodeTransport({baseUrl:'http://fixture',fetch:async input=>{const url=String(input instanceof Request?input.url:input);seen.push(url);return url.endsWith('/api/info')?new Response('{}',{status:404}):Response.json([{id:'ses_legacy'}]);}});
    expect(await(await transport.fetch('http://fixture/session')).json()).toEqual([{id:'ses_legacy'}]);
    await expect(transport.fetch('https://elsewhere.invalid/session')).rejects.toThrow(/origin/i);expect(seen).toHaveLength(2);
  });
});
