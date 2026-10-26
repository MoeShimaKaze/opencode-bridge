import express, {type Application} from 'express';
import {opencodeClient} from '../../opencode/client.js';
import {chatAuthMiddleware} from './chat-auth.js';

export function registerChatQuestionRoutes(app:Application):void {
  const router=express.Router();router.use(chatAuthMiddleware);
  router.get('/questions',async(req,res)=>{
    const sessionId=typeof req.query.sessionId==='string'?req.query.sessionId.trim():'';
    if(!sessionId){res.status(400).json({error:'缺少 sessionId'});return;}
    try{
      const questions=await opencodeClient.listPendingQuestions({sessionId});
      res.json({questions:questions.filter(question=>question.sessionID===sessionId)});
    }catch(error){res.status(502).json({error:error instanceof Error?error.message:'读取待回答问题失败'});}
  });
  router.post('/questions/:id/:action',async(req,res)=>{
    const id=typeof req.params.id==='string'?req.params.id.trim():'';
    const sessionId=typeof req.body?.sessionId==='string'?req.body.sessionId.trim():'';
    const action=req.params.action;
    if(!['reply','reject'].includes(String(action))){res.sendStatus(404);return;}
    const answers=req.body?.answers;
    if(!id || !sessionId || (action==='reply' && (!Array.isArray(answers) || !answers.every((row:unknown)=>Array.isArray(row)&&row.every(value=>typeof value==='string'))))){
      res.status(400).json({error:'缺少会话或有效的问题答案'});return;
    }
    try{
      const pending=(await opencodeClient.listPendingQuestions({sessionId})).find(question=>question.id===id && question.sessionID===sessionId);
      if(!pending){res.status(404).json({error:'问题已处理或不属于当前会话',expired:true});return;}
      if(action==='reply' && (answers.length!==pending.questions.length || pending.questions.some((question,index)=>{
        const values=answers[index] as string[];
        return (!question.multiple && values.length>1) || (question.custom===false && values.some(value=>!question.options.some(option=>option.label===value)));
      }))){res.status(400).json({error:'请按题目要求选择或填写答案'});return;}
      const result=action==='reply'?await opencodeClient.replyQuestion(id,answers):await opencodeClient.rejectQuestion(id);
      if(!result.ok){res.status(result.expired?410:502).json({error:result.expired?'问题已处理或过期':'回答提交失败，请重试',expired:result.expired===true});return;}
      opencodeClient.emit('questionResolved',{sessionID:sessionId,id,status:action==='reply'?'answered':'cancelled'});
      res.json({ok:true});
    }catch(error){res.status(502).json({error:error instanceof Error?error.message:'回答提交失败'});}
  });
  app.use('/api/chat',router);
}
