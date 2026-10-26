import { directoryConfig, opencodeConfig } from '../config.js';
import { withOpencodeAuthorizationHeaders } from './client-helpers.js';
import { OpenCodeTransport } from './transport.js';
import { readJsonEvents } from './sse.js';

let shared: OpenCodeTransport | undefined;
let connectionKey: string | undefined;

export function getOpenCodeTransport(): OpenCodeTransport {
  const key=JSON.stringify([opencodeConfig.baseUrl,opencodeConfig.serverUsername,opencodeConfig.serverPassword,directoryConfig.defaultWorkDirectory]);
  if (!shared || key !== connectionKey) {
    connectionKey=key;
    shared=new OpenCodeTransport({baseUrl:opencodeConfig.baseUrl,headers:withOpencodeAuthorizationHeaders(),defaultDirectory:directoryConfig.defaultWorkDirectory ?? process.cwd()});
  }
  return shared;
}

export const fetchOpenCode: typeof fetch = (input,init) => getOpenCodeTransport().fetch(input,init);
export function getOpenCodeProtocol(): 'v1' | 'v2' | undefined {return shared?.protocol;}
export async function subscribeNativeEvents(signal: AbortSignal): Promise<{stream: AsyncGenerator<any>}> {
  const response=await fetchOpenCode(`${opencodeConfig.baseUrl}/event`,{signal});
  return {stream:readJsonEvents(response)};
}
