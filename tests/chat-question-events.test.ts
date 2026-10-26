import { expect, it } from 'vitest';
import { ChatEventBus } from '../src/admin/chat/event-bus.js';
import { ChatEventNormalizer } from '../src/admin/chat/event-normalizer.js';
import { opencodeClient } from '../src/opencode/client.js';
import { EventStreamManager } from '../src/opencode/event-stream.js';
it.each(['question.replied','question.rejected'])('normalizes legacy %s requestID so another client can clear the Web question',type=>{
  const bus=new ChatEventBus();const normalizer=new ChatEventNormalizer(bus);normalizer.install();
  const stream=new EventStreamManager({getClient:()=>null,emitEvent:(event,payload)=>{opencodeClient.emit(event,payload);}});
  try{
    stream.handleEvent({type,properties:{sessionID:'ses_legacy',requestID:'que_legacy',answers:[['Yes']]}});
    expect(bus.snapshot('ses_legacy').map(value=>value.event)).toEqual([
      {type:'question_resolved',reqId:'que_legacy',status:type==='question.replied'?'answered':'cancelled'},
    ]);
  }finally{normalizer.uninstall();}
});
it('publishes pending questions and answers from OpenCode through the browser SSE event bus',()=>{
  const bus=new ChatEventBus();const normalizer=new ChatEventNormalizer(bus);normalizer.install();
  const question={id:'frm_one',sessionID:'ses_one',questions:[{header:'Login',question:'Continue?',options:[{label:'Yes',description:'Proceed'}],custom:true}]};
  try{
    opencodeClient.emit('questionAsked',question);
    opencodeClient.emit('questionResolved',{sessionID:'ses_one',id:'frm_one',status:'answered'});
    expect(bus.snapshot('ses_one').map(e=>e.event)).toEqual([{type:'question_ask',req:question},{type:'question_resolved',reqId:'frm_one',status:'answered'}]);
  }finally{normalizer.uninstall();}
});
