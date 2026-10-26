import { beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({protocol:'v2',prompt:vi.fn()}));
vi.mock('../src/config.js',()=>({opencodeConfig:{baseUrl:'http://localhost'},modelConfig:{defaultProvider:'legacy-provider',defaultModel:'legacy-model'}}));
vi.mock('../src/opencode/shared-transport.js',()=>({getOpenCodeProtocol:()=>state.protocol,fetchOpenCode:vi.fn()}));
import { MessagesManager } from '../src/opencode/messages.js';
describe('native session default selection',()=>{
  beforeEach(()=>{state.prompt.mockReset();state.prompt.mockResolvedValue({data:{info:{},parts:[]}});state.protocol='v2';});
  const manager=()=>new MessagesManager({getClient:()=>({session:{prompt:state.prompt}} as any),ensureDirectoryEventStream:async()=>{},normalizeDirectory:value=>value});
  it('leaves native session model and Agent unchanged without an explicit selection',async()=>{
    await manager().sendMessage('ses_shared','continue');
    expect(state.prompt.mock.calls[0][0].body).toEqual({parts:[{type:'text',text:'continue'}]});
  });
  it('honors an explicit selection and retains legacy default behavior',async()=>{
    await manager().sendMessage('ses_shared','continue',{providerId:'selected',modelId:'model'});
    expect(state.prompt.mock.calls[0][0].body.model).toEqual({providerID:'selected',modelID:'model'});
    state.protocol='v1';await manager().sendMessage('ses_old','continue');
    expect(state.prompt.mock.calls[1][0].body.model).toEqual({providerID:'legacy-provider',modelID:'legacy-model'});
  });
});
