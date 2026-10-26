import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {effectScope,nextTick,ref} from '../web/node_modules/vue/index.js';
const state=vi.hoisted(()=>({onEvent:undefined as any,respond:vi.fn()}));
vi.mock('../web/src/api/index.ts',()=>({chatApi:{getMessages:async()=>({messages:[],tasks:[],total:0,totalTurns:0,hasMore:false,nextCursor:null}),respondQuestion:state.respond}}));
vi.mock('../web/src/composables/useChatStream',async()=>{
  const {ref}=await import('../web/node_modules/vue/index.js');
  return {useChatStream:(_id:any,options:any)=>{state.onEvent=options.onEvent;return {state:ref('connected'),lastError:ref(null),reconnect:vi.fn()};}};
});
import {useChatMessages} from '../web/src/composables/useChatMessages';
let scope:ReturnType<typeof effectScope>;let session:ReturnType<typeof ref<string|null>>;let model:ReturnType<typeof useChatMessages>;
const question={id:'frm_one',sessionID:'ses_one',questions:[{header:'Confirm',question:'Continue?',options:[],custom:true}]};
beforeEach(async()=>{vi.clearAllMocks();scope=effectScope();session=ref<string|null>('ses_one');model=scope.run(()=>useChatMessages(session))!;await nextTick();state.onEvent({type:'question_ask',req:question});});
afterEach(()=>scope.stop());
it('clears an expired question even if its resolution SSE event was lost',async()=>{
  state.respond.mockRejectedValue({response:{status:410,data:{expired:true,error:'Question settled'}}});
  expect(await model.answerQuestion([['Continue']])).toBe(true);
  expect(model.activeQuestion.value).toBeNull();expect(model.questionBusy.value).toBe(false);
});
it('retains a temporary failed answer for retry',async()=>{
  state.respond.mockRejectedValue(new Error('Synthetic network interruption'));
  expect(await model.answerQuestion([['Continue']])).toBe(false);
  expect(model.activeQuestion.value?.id).toBe('frm_one');expect(model.questionError.value).toContain('interruption');
});
it('does not let an earlier answer overwrite a newly opened session question',async()=>{
  let reject!: (reason:unknown)=>void;state.respond.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
  const old=model.answerQuestion([['Old answer']]);session.value='ses_other';await nextTick();session.value='ses_one';await nextTick();
  state.onEvent({type:'question_ask',req:{...question,id:'frm_new'}});
  reject(new Error('Old request failed'));await old;
  expect(model.activeQuestion.value?.id).toBe('frm_new');expect(model.questionError.value).toBeNull();
});
