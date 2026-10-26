import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime=process.env.BRIDGE_RUNTIME_ROOT;
const source=process.env.BRIDGE_SOURCE_ROOT;
if(!runtime || !source)throw new Error('BRIDGE_RUNTIME_ROOT and BRIDGE_SOURCE_ROOT are required');
const url=new URL(process.env.NATIVE_OPENCODE_URL ?? '');
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.protocol!=='http:')throw new Error('The native Windows deployment requires a loopback service URL');
for(const folder of ['data','logs','profile'])fs.mkdirSync(path.join(runtime,folder),{recursive:true});
process.env.OPENCODE_BRIDGE_CONFIG_DIR=path.join(runtime,'data');
const {configStore}=await import(pathToFileURL(path.join(source,'dist/store/config-store.js')).href);
configStore.merge({OPENCODE_HOST:url.hostname,OPENCODE_PORT:url.port,OPENCODE_SERVER_USERNAME:'opencode',
  OPENCODE_SERVER_PASSWORD:process.env.OPENCODE_SERVER_PASSWORD,OPENCODE_AUTO_START:'false',OPENCODE_AUTO_START_FOREGROUND:'false',
  ENABLE_MANUAL_SESSION_BIND:'true',ENABLED_PLATFORMS:'dingtalk',DINGTALK_ENABLED:'true',FEISHU_ENABLED:'false',
  ADMIN_PORT:process.env.ADMIN_PORT ?? '4098',WEB_ADMIN_DISABLED:'false'});
configStore.markMigrated();
fs.writeFileSync(path.join(runtime,'data/.env'),'ADMIN_PORT='+(process.env.ADMIN_PORT ?? '4098')+'\n');
console.log('Bridge configured to use the existing native OpenCode service.');
process.exit(0);
