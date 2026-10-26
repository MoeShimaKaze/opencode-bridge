import { afterEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({fetch:vi.fn(),protocol:vi.fn()}));
vi.mock('../src/config.js',()=>({opencodeConfig:{baseUrl:'http://127.0.0.1:49374'}}));
vi.mock('../src/opencode/shared-transport.js',()=>({fetchOpenCode:mocks.fetch,getOpenCodeProtocol:mocks.protocol}));
import { getNativeModelGroups } from '../src/opencode/native-models.js';
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
it('reads configured models over the native service without starting another CLI service',async()=>{
  vi.stubEnv('NATIVE_OPENCODE_URL','http://127.0.0.1:49374');mocks.protocol.mockReturnValue(undefined);
  mocks.fetch.mockResolvedValue(Response.json({providers:[{id:'custom',models:{one:{id:'one'},two:{id:'two'}}}]}));
  expect(await getNativeModelGroups()).toEqual(new Map([['custom',['one','two']]]));
  expect(mocks.fetch).toHaveBeenCalledWith('http://127.0.0.1:49374/config/providers');
});
it('leaves legacy CLI discovery unchanged',async()=>{
  vi.stubEnv('NATIVE_OPENCODE_URL','');mocks.protocol.mockReturnValue('v1');
  expect(await getNativeModelGroups()).toBeUndefined();expect(mocks.fetch).not.toHaveBeenCalled();
});
it('does not fall back to spawning a native CLI after an authentication error',async()=>{
  mocks.protocol.mockReturnValue('v2');mocks.fetch.mockResolvedValue(new Response(null,{status:401}));
  await expect(getNativeModelGroups()).rejects.toThrow('401');
});
