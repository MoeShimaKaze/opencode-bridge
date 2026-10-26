import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({fetch:vi.fn(),exec:vi.fn(),spawn:vi.fn(),stop:vi.fn()}));
vi.mock('node:child_process',()=>({execSync:mocks.exec,execFileSync:mocks.exec,spawn:mocks.spawn,spawnSync:mocks.spawn}));
vi.mock('../src/store/config-store.js',()=>({configStore:{get:()=>({})}}));
vi.mock('../src/store/log-store.js',()=>({logStore:{}}));
vi.mock('../src/opencode/client.js',()=>({opencodeClient:{}}));
vi.mock('../src/config.js',()=>({opencodeConfig:{host:'127.0.0.1',port:49374,baseUrl:'http://127.0.0.1:49374'}}));
vi.mock('../src/opencode/shared-transport.js',()=>({getOpenCodeProtocol:()=> 'v2',fetchOpenCode:mocks.fetch}));
vi.mock('../src/admin/utils.js',()=>({probeTcpPort:vi.fn(),resolveProcessManagerPath:vi.fn(),toRecord:vi.fn(),parseOptionalBoolean:vi.fn(),buildOpencodeAuthHeaders:vi.fn()}));
import { createOpencodeRoutes } from '../src/admin/routes/opencode.js';
import { createAdminRoutes } from '../src/admin/routes/admin.js';
let server:Server;let base:string;
beforeEach(async()=>{
  vi.clearAllMocks();vi.stubEnv('NATIVE_OPENCODE_URL','http://127.0.0.1:49374');
  mocks.fetch.mockResolvedValue(Response.json({healthy:true,version:'2.0.24'}));
  const app=express();app.use(express.json());app.use('/api/opencode',createOpencodeRoutes({version:'3.1.6'}));
  app.use('/api/admin',createAdminRoutes({version:'3.1.6',startedAt:new Date(),cronJobCount:0,bridgeManager:{stop:mocks.stop} as any}));
  server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${(server.address() as any).port}/api/opencode`;
});
afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
it('reports the actual shared service version and port without invoking a CLI',async()=>{
  expect(await (await fetch(base+'/status')).json()).toMatchObject({installed:true,version:'2.0.24',port:49374,portOpen:true,management:'external',apiVersion:'v2'});
  expect(mocks.exec).not.toHaveBeenCalled();
});
it.each(['install','upgrade','start','stop','attach'].flatMap(action=>[action,action+'/',action.toUpperCase()]))('keeps the shared service outside the legacy %s process manager',async action=>{
  expect((await fetch(base+'/'+action,{method:'POST'})).status).toBe(409);
  expect(mocks.exec).not.toHaveBeenCalled();expect(mocks.spawn).not.toHaveBeenCalled();
});
it('does not offer an OpenCode 1 upgrade for the shared OpenCode 2 service',async()=>{
  expect(await (await fetch(base+'/check-update')).json()).toMatchObject({latestVersion:null,managedExternally:true});
});
it('shuts down Bridge and its panel while preserving the shared native service',async()=>{
  const exited=new Promise<void>(resolve=>vi.spyOn(process,'exit').mockImplementation(()=>{resolve();return undefined as never;}));
  expect((await fetch(base.replace('/api/opencode','/api/admin')+'/shutdown',{method:'POST'})).status).toBe(200);
  await exited;
  expect(mocks.stop).toHaveBeenCalledTimes(1);expect(mocks.spawn).not.toHaveBeenCalled();
});
