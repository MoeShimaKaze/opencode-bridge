import { beforeEach, expect, it, vi } from 'vitest';
const client=vi.hoisted(()=>({sendMessage:vi.fn(),getProviders:vi.fn()}));
vi.mock('../src/opencode/client.js',()=>({opencodeClient:client}));
vi.mock('../src/store/config-store.js',()=>({configStore:{}}));
vi.mock('../src/opencode/output-buffer.js',()=>({outputBuffer:{get:()=>({status:'running'})}}));
vi.mock('../src/store/chat-session.js',()=>({chatSessionStore:{getKnownDirectories:()=>[]}}));
vi.mock('../src/permissions/handler.js',()=>({permissionHandler:{}}));
vi.mock('../src/handlers/platform-command.handler.js',()=>({PlatformCommandHandler:class {}}));
vi.mock('../src/utils/directory-policy.js',()=>({DirectoryPolicy:class {}}));
vi.mock('../src/commands/parser.js',()=>({parseCommand:vi.fn()}));
vi.mock('../src/utils/group-mention.js',()=>({shouldSkipGroupMessage:()=>false}));
import { DingtalkHandler } from '../src/handlers/dingtalk.js';
beforeEach(()=>{vi.clearAllMocks();client.sendMessage.mockResolvedValue({});client.getProviders.mockResolvedValue({providers:[]});});
it.each(['custom:model:revision','custom/model:revision'])('passes explicit DingTalk model and effort through the actual dispatch API (%s)',async(preferredModel)=>{
  const sender={sendText:vi.fn()};
  await (new DingtalkHandler() as any).processPrompt('ses_shared','continue','chat',
    {preferredModel,preferredAgent:'custom-agent',preferredEffort:'high',resolvedDirectory:'C:/project'},undefined,sender);
  expect(client.sendMessage).toHaveBeenCalledWith('ses_shared','continue',
    {providerId:'custom',modelId:'model:revision',agent:'custom-agent',variant:'high',directory:'C:/project'});
  expect(sender.sendText).not.toHaveBeenCalled();
});
it('leaves native model and Agent untouched when no DingTalk override was chosen',async()=>{
  await (new DingtalkHandler() as any).processPrompt('ses_shared','continue','chat',undefined,undefined,{sendText:vi.fn()});
  expect(client.sendMessage).toHaveBeenCalledWith('ses_shared','continue',{});
});
