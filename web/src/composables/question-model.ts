import type {ChatEvent,ChatQuestionRequest} from '../api';
import {parseQuestionAnswerText} from '../../../src/opencode/question-parser';

export function applyQuestionEvent(queue:ChatQuestionRequest[],event:ChatEvent,sessionId:string):ChatQuestionRequest[]{
  if(event.type==='questions_snapshot')return event.requests.filter(request=>request.sessionID===sessionId);
  if(event.type==='question_resolved')return queue.filter(request=>request.id!==event.reqId);
  if(event.type==='question_ask' && event.req.sessionID===sessionId){
    const index=queue.findIndex(request=>request.id===event.req.id);
    return index<0?[...queue,event.req]:queue.map((request,i)=>i===index?event.req:request);
  }
  return queue;
}
export function answersForQuestionText(request:ChatQuestionRequest,text:string):string[][]|null{
  if(request.questions.length!==1)return null;
  const question=request.questions[0];const parsed=parseQuestionAnswerText(text,question);
  if(!parsed || (parsed.type==='custom' && question.custom===false))return null;
  return [parsed.type==='skip'?[]:parsed.type==='custom'?[parsed.custom!]:parsed.values!];
}
