import { toLegacyMessages, toLegacyProviders, toLegacySession, object } from './v2-records.js';
import { V2EventMapper } from './v2-events.js';

export interface TransportOptions {
  baseUrl: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  fetch?: typeof fetch;
  defaultDirectory?: string;
}
class NativeHttpError extends Error {
  constructor(readonly response: Response) {super(`OpenCode native request failed (HTTP ${response.status})`);}
}
const json = (value: unknown, status = 200) => Response.json(value, {status});
const noContent = () => new Response(null, {status: 204});

/** Translate the established SDK wire contract without copying or rewriting native storage. */
export class V2Transport {
  private readonly fetchImpl: typeof fetch;
  private readonly mapper = new V2EventMapper();
  constructor(private readonly options: TransportOptions) {this.fetchImpl = options.fetch ?? globalThis.fetch;}

  private async request(path: string, request: Request, options: {method?: string; body?: unknown; query?: URLSearchParams} = {}): Promise<Response> {
    const url = new URL(path, this.options.baseUrl);
    if (options.query) url.search = options.query.toString();
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.fetchImpl(url, {method: options.method ?? 'GET', headers, signal: request.signal,
      ...(options.body !== undefined ? {body: JSON.stringify(options.body)} : {})});
    if (!response.ok) throw new NativeHttpError(response);
    return response;
  }
  private async data(path: string, request: Request, options?: Parameters<V2Transport['request']>[2]): Promise<any> {
    const response = await this.request(path, request, options);
    if (response.status === 204) return undefined;
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new Error('Native OpenCode returned a non-JSON response');
    const body = await response.json() as any;
    return body && Object.hasOwn(body, 'data') ? body.data : body;
  }
  private location(directory?: string): URLSearchParams {
    const query = new URLSearchParams();
    if (directory ?? this.options.defaultDirectory) query.set('location[directory]', directory ?? this.options.defaultDirectory!);
    return query;
  }
  private async prepareLocation(request: Request, directory?: string): Promise<void> {
    // Metadata inventories are empty until the native location has been resolved.
    await this.data('/api/location',request,{query:this.location(directory)});
  }
  private async pages(path: string, request: Request, query = new URLSearchParams()): Promise<unknown[]> {
    const all: unknown[] = [];
    const cursors = new Set<string>();
    query.set('limit', '200');
    for (;;) {
      const response = await this.request(path, request, {query});
      const page = await response.json() as {data?: unknown; cursor?: {next?: string}};
      if (!Array.isArray(page.data)) throw new Error('Invalid native OpenCode list response');
      all.push(...page.data);
      const next = page.cursor?.next;
      if (!next) return all;
      if (cursors.has(next)) throw new Error('Native OpenCode returned a repeated pagination cursor');
      cursors.add(next); query.set('cursor', next); query.delete('order');
    }
  }
  private async history(session: string, request: Request): Promise<Array<{info: any; parts: any[]}>> {
    const query = new URLSearchParams({order:'asc'});
    return toLegacyMessages(decodeURIComponent(session), await this.pages(`/api/session/${session}/message`, request, query));
  }
  private async select(session: string, body: any, request: Request): Promise<void> {
    if (typeof body.agent === 'string' && body.agent) await this.request(`/api/session/${session}/agent`, request, {method:'POST',body:{agent:body.agent}});
    if (body.variant && !body.model) {
      const native=await this.data(`/api/session/${session}`,request);
      if(native.model) body={...body,model:native.model};
    }
    if (body.model?.providerID && (body.model.modelID || body.model.id)) {
      await this.request(`/api/session/${session}/model`, request, {method:'POST',body:{model:{providerID:body.model.providerID,id:body.model.modelID ?? body.model.id,
        ...(body.variant ?? body.model.variant ? {variant:body.variant ?? body.model.variant} : {})}}});
    }
  }
  private async prompt(session: string, body: any, request: Request, asynchronous: boolean): Promise<Response> {
    const parts = Array.isArray(body.parts) ? body.parts : [];
    if (parts.some((p: any) => !['text','file','agent'].includes(p.type))) return json({message:'Unsupported native prompt part'}, 400);
    const files = parts.filter((p: any) => p.type === 'file').map((p: any) => ({uri:p.url,...(p.filename ? {name:p.filename} : {})}));
    if (files.some((file: any) => typeof file.uri !== 'string')) return json({message:'File URI is required'},400);
    const agents = parts.filter((p: any) => p.type === 'agent').map((p: any) => ({id:p.name}));
    const payload = {text:parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'),
      ...(files.length ? {files} : {}), ...(agents.length ? {agents} : {})};
    await this.select(session,body,request);
    await this.request(`/api/session/${session}/prompt`,request,{method:'POST',body:payload});
    if (asynchronous) return noContent();
    await this.request(`/api/experimental/session/${session}/wait`,request,{method:'POST'});
    const messages = await this.history(session,request);
    const reply = messages.slice().reverse().find(message => message.info.role === 'assistant');
    if (!reply) throw new Error('Native prompt finished without an assistant message');
    return json(reply);
  }
  private stream(response: Response): Response {
    if (!response.body) throw new Error('Native event stream has no body');
    const mapper = this.mapper;
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); const encoder = new TextEncoder();
    let buffer = '';
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          for (;;) {
            const {value,done} = await reader.read();
            buffer = (buffer + decoder.decode(value,{stream:!done})).replace(/\r\n/g,'\n');
            let frameEnd: number; const frames: string[] = [];
            while ((frameEnd=buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0,frameEnd); buffer=buffer.slice(frameEnd+2);
              const data = frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
              if (!data) continue;
              const native = JSON.parse(data);
              for (const event of mapper.map(native)) frames.push(`data: ${JSON.stringify(event)}\n\n`);
            }
            if (frames.length) controller.enqueue(encoder.encode(frames.join('')));
            if (done) {controller.close(); return;}
            if (frames.length) return;
          }
        } catch (error) {controller.error(error); await reader.cancel().catch(()=>{});}
      },
      async cancel(reason) {await reader.cancel(reason);},
    });
    return new Response(body,{headers:{'content-type':'text/event-stream','cache-control':'no-cache'}});
  }

  fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url); const path=url.pathname; const method=request.method;
    const directory=url.searchParams.get('directory') ?? undefined;
    let body: any = {};
    try {
      if (!['GET','HEAD'].includes(method)) {const text=await request.text(); body=text ? JSON.parse(text) : {};}
      if (path.startsWith('/api/')) return this.request(path,request,{method,query:url.searchParams,...(method !== 'GET' && method !== 'HEAD' ? {body} : {})});
      if (path === '/event') return this.stream(await this.request('/api/event',request));
      if (path === '/global/health' || path === '/health') return json({healthy:true,...await this.data('/api/info',request)});
      if (path === '/session/status') {
        const active=await this.data('/api/session/active',request);return json(Object.fromEntries(Object.keys(active ?? {}).map(id=>[id,{type:'busy'}])));
      }
      if (path === '/session' && method === 'GET') {
        const query=new URLSearchParams(); if(directory)query.set('directory',directory);query.set('order','desc');
        const sessions=await this.pages('/api/session',request,query);return json(sessions.map(toLegacySession));
      }
      if (path === '/session' && method === 'POST') {
        const created=await this.data('/api/session',request,{method,body:{...body,...(directory ? {location:{directory}} : this.options.defaultDirectory ? {location:{directory:this.options.defaultDirectory}} : {})}});
        return json(toLegacySession(created));
      }
      if (path === '/agent') {
        await this.prepareLocation(request,directory);
        const agents=await this.data('/api/agent',request,{query:this.location(directory)});
        return json(agents.map((agent: any)=>({...agent,name:agent.id,displayName:agent.name})));
      }
      if (path === '/config/providers' || path === '/provider') {
        await this.prepareLocation(request,directory);
        const query=this.location(directory);
        const [providers,models]=await Promise.all([this.data('/api/provider',request,{query}),this.data('/api/model',request,{query})]);
        const converted=toLegacyProviders(providers,models);
        if (path==='/provider') return json({all:converted.providers,connected:converted.providers.map((p:any)=>p.id),default:converted.default});
        return json(converted);
      }
      if (path === '/command') {
        await this.prepareLocation(request,directory);
        const commands=await this.data('/api/command',request,{query:this.location(directory)});
        return json(commands.map((command: any)=>({...command,name:command.id ?? command.name,template:command.template ?? ''})));
      }
      if (path === '/project') {
        const projects=await this.data('/api/project',request);
        return json((Array.isArray(projects)?projects:[]).map((p:any)=>({...p,worktree:p.worktree ?? p.directory})));
      }
      if (path === '/config' && method === 'GET') {
        await this.prepareLocation(request,directory);
        const config=await this.data('/api/config',request,{query:this.location(directory)});
        return json(Array.isArray(config)?{}:config);
      }
      if (path === '/permission') return json(await this.data('/api/permission/request',request,{query:this.location(directory)}));
      if (path === '/question') {
        const forms=await this.data('/api/form',request,{query:this.location(directory)});
        return json(forms.flatMap((form:any)=>this.mapper.map({type:'form.created',data:{form}}).filter(event=>event.type==='question.asked').map(event=>event.properties)));
      }
      const question=path.match(/^\/question\/([^/]+)\/(reply|reject)$/);
      if(question && method === 'POST') {
        const form=this.mapper.getForm(decodeURIComponent(question[1]));
        if(!form)return json({message:'Native form is unknown or expired'},404);
        const endpoint=`/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(form.id)}`;
        if(question[2]==='reject')await this.request(endpoint,request,{method:'DELETE'});
        else {
          const answer: Record<string,unknown>={};
          for(let index=0;index<form.fields.length;index++){
            const field=form.fields[index]; const values=body.answers?.[index];
            if(!Array.isArray(values))return json({message:'Missing form answer'},400);
            const resolve=(label: string)=>field.type==='boolean' && label==='Yes'?true:field.type==='boolean' && label==='No'?false:field.options?.find((option:any)=>option.label===label)?.value ?? label;
            let value:unknown=field.type==='multiselect'?values.map(resolve):resolve(values[0] ?? '');
            if(field.type==='boolean'){if(!['true','false'].includes(String(value)))return json({message:'Invalid boolean answer'},400);value=String(value)==='true';}
            if(field.type==='number' || field.type==='integer'){value=Number(value);if(!Number.isFinite(value)||(field.type==='integer'&&!Number.isInteger(value)))return json({message:'Invalid numeric answer'},400);}
            answer[field.key]=value;
          }
          await this.request(`${endpoint}/reply`,request,{method:'POST',body:{answer}});
        }
        this.mapper.forgetForm(form.id);return json(true);
      }
      const match=path.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
      if(match) {
        const [,session,operation='']=match;const endpoint=`/api/session/${session}`;
        if(!operation){
          if(method==='DELETE'){await this.request(endpoint,request,{method});return json(true);}
          if(method==='PATCH')await this.request(endpoint,request,{method,body});
          return json(toLegacySession(await this.data(endpoint,request)));
        }
        if(operation==='message' && method==='GET')return json(await this.history(session,request));
        if(operation==='message' && method==='POST')return await this.prompt(session,body,request,false);
        if(operation==='prompt_async' && method==='POST')return await this.prompt(session,body,request,true);
        if(operation==='abort' && method==='POST'){await this.request(`${endpoint}/interrupt`,request,{method});return json(true);}
        if(operation==='summarize' && method==='POST'){await this.request(`${endpoint}/compact`,request,{method,body:{}});return json(true);}
        if(operation==='revert' && method==='POST'){await this.request(`${endpoint}/revert/stage`,request,{method,body:{messageID:body.messageID}});return json(toLegacySession(await this.data(endpoint,request)));}
        if(operation==='unrevert' && method==='POST'){await this.request(`${endpoint}/revert`,request,{method:'DELETE'});return json(toLegacySession(await this.data(endpoint,request)));}
        if(operation.startsWith('permissions/') && method==='POST'){
          const decision=body.response;
          if(!['once','always','reject'].includes(decision))return json({message:'Invalid permission decision'},400);
          await this.request(`${endpoint}/permission/${operation.slice(12)}/reply`,request,{method,body:{decision}});return json(true);
        }
        if(operation==='children' && method==='GET'){
          return json((await this.pages('/api/session',request,new URLSearchParams({parentID:decodeURIComponent(session)}))).map(toLegacySession));
        }
        if(operation==='fork' && method==='POST')return json(toLegacySession(await this.data(`${endpoint}/fork`,request,{method,body:body.messageID?{before:body.messageID}:{}})));
        if(operation==='diff' && method==='GET')return json(await this.data(`${endpoint}/diff`,request));
        if(operation==='todo' && method==='GET')return json([]);
      }
      return json({message:`OpenCode 2 adapter does not support ${method} ${path}`},501);
    } catch(error) {
      if(error instanceof NativeHttpError)return error.response;
      if(request.signal.aborted)throw error;
      return json({message:error instanceof Error?error.message:String(error)},502);
    }
  };
}
