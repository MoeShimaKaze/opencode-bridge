import {expect,it} from 'vitest';
import {applyQuestionEvent,answersForQuestionText} from '../web/src/composables/question-model';
const question={id:'frm_one',sessionID:'ses_one',questions:[{header:'Login',question:'Continue?',options:[{label:'Open login window',description:'Proceed'}],custom:true}]};
it('updates one pending question through SSE snapshots and clears it when another client answers',()=>{
  let queue=applyQuestionEvent([], {type:'questions_snapshot',requests:[question]},'ses_one');
  queue=applyQuestionEvent(queue,{type:'question_ask',req:question},'ses_one');expect(queue).toHaveLength(1);
  expect(applyQuestionEvent(queue,{type:'question_resolved',reqId:'frm_one',status:'answered'},'ses_one')).toEqual([]);
  expect(applyQuestionEvent(queue,{type:'questions_snapshot',requests:[]},'ses_one')).toEqual([]);
  expect(applyQuestionEvent([],{type:'question_ask',req:{...question,sessionID:'ses_other'}},'ses_one')).toEqual([]);
});
it('treats composer text as the pending question answer instead of another queued prompt',()=>{
  expect(answersForQuestionText(question,'登录')).toEqual([['登录']]);
  expect(answersForQuestionText(question,'1')).toEqual([['Open login window']]);
  expect(answersForQuestionText({...question,questions:[{...question.questions[0],custom:false}]},'unlisted')).toBeNull();
  expect(answersForQuestionText({...question,questions:[...question.questions,...question.questions]},'登录')).toBeNull();
});
