<template>
  <section class="question-card" aria-label="待回答问题">
    <header><div><span class="eyebrow">需要你确认</span><h3>回答后继续当前任务</h3></div><span class="waiting">{{ busy ? '正在提交' : '等待回答' }}</span></header>
    <div class="question-fields">
      <div v-for="(question,index) in request.questions" :key="index" class="question-field">
        <h4>{{ request.questions.length > 1 ? `${index + 1}. ` : '' }}{{ question.header || '问题' }}</h4>
        <p>{{ question.question }}</p>
        <el-checkbox-group v-if="question.multiple" v-model="selections[index]" :disabled="busy" class="options">
          <el-checkbox v-for="option in question.options" :key="option.label" :value="option.label" border>
            <span>{{ option.label }}</span><small v-if="option.description">{{ option.description }}</small>
          </el-checkbox>
        </el-checkbox-group>
        <el-radio-group v-else :model-value="selections[index]?.[0]" :disabled="busy" class="options" @update:model-value="(value:unknown) => select(index,String(value))">
          <el-radio v-for="option in question.options" :key="option.label" :value="option.label" border>
            <span>{{ option.label }}</span><small v-if="option.description">{{ option.description }}</small>
          </el-radio>
        </el-radio-group>
        <el-input v-if="question.custom !== false" v-model="custom[index]" :disabled="busy" placeholder="也可以直接填写你的回答" @keyup.enter="submit" />
      </div>
    </div>
    <p v-if="error" class="answer-error" role="alert">{{ error }}</p>
    <footer><span>在其他客户端回答后，这里也会自动更新。</span><div><el-button :disabled="busy" text @click="$emit('cancel')">跳过提问</el-button><el-button type="primary" :disabled="!ready" :loading="busy" @click="submit">提交回答</el-button></div></footer>
  </section>
</template>
<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import type {ChatQuestionRequest} from '../../api'
const props=defineProps<{request:ChatQuestionRequest;busy:boolean;error:string|null}>()
const emit=defineEmits<{answer:[string[][]];cancel:[]}>()
const selections=ref<string[][]>([])
const custom=ref<string[]>([])
watch(()=>props.request.id,()=>{selections.value=props.request.questions.map(()=>[]);custom.value=props.request.questions.map(()=>'')},{immediate:true})
const answers=computed(()=>props.request.questions.map((_question,index)=>custom.value[index]?.trim()?[custom.value[index].trim()]:selections.value[index] || []))
const ready=computed(()=>!props.busy && answers.value.every(row=>row.length>0))
function select(index:number,value:string):void{selections.value[index]=[value];custom.value[index]=''}
function submit():void{if(ready.value)emit('answer',answers.value)}
</script>
<style scoped>
.question-card{flex-shrink:0;margin:10px 14px;padding:16px;border:1px solid #cbdcf6;border-radius:14px;background:#f8fbff;box-shadow:0 4px 16px #1e40af08;color:#24344d}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:12px}header{margin-bottom:12px}.eyebrow{font-size:11px;color:#4973aa}h3{font-size:14px;margin:3px 0 0}.waiting{font-size:11px;color:#856016;background:#fff0ca;border-radius:20px;padding:4px 9px;white-space:nowrap}.question-fields{max-height:260px;overflow:auto}.question-field+ .question-field{border-top:1px solid #dce6f3;padding-top:12px;margin-top:14px}h4{margin:0 0 6px;font-size:13px}p{font-size:13px;line-height:1.6;white-space:pre-wrap;margin:0 0 12px}.options{display:flex;flex-direction:column;align-items:stretch;gap:8px;margin-bottom:10px}.options :deep(.el-radio),.options :deep(.el-checkbox){height:auto;min-height:40px;margin:0;padding:10px 12px;background:#fff;white-space:normal}.options :deep(.el-radio__label),.options :deep(.el-checkbox__label){line-height:1.5;white-space:normal}small{display:block;font-size:11px;color:#7b8797;margin-top:3px}footer{margin-top:12px}footer>span{font-size:11px;color:#8794a6}.answer-error{color:#b42318;margin:10px 0 0}@media(max-width:680px){footer{align-items:flex-start;flex-direction:column}.question-card{margin:8px;padding:12px}}
</style>
