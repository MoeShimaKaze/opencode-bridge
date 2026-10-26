import { opencodeConfig } from '../config.js';
import { fetchOpenCode, getOpenCodeProtocol } from './shared-transport.js';

/** Native deployments must query their existing service, never spawn `opencode models`. */
export async function getNativeModelGroups(): Promise<Map<string, string[]> | undefined> {
  if (getOpenCodeProtocol() !== 'v2' && !process.env.NATIVE_OPENCODE_URL) return undefined;
  const response=await fetchOpenCode(`${opencodeConfig.baseUrl}/config/providers`);
  if(!response.ok)throw new Error(`Native model discovery failed (HTTP ${response.status})`);
  const data=await response.json() as {providers?: Array<{id:string;models:Record<string,{id?:string}>|Array<{id:string}>}>};
  if(!Array.isArray(data.providers))throw new Error('Invalid native model inventory');
  return new Map(data.providers.map(provider=>[provider.id,
    Array.isArray(provider.models)?provider.models.map(model=>model.id):Object.entries(provider.models ?? {}).map(([id,model])=>model.id ?? id)]));
}
