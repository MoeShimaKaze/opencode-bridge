/** Incremental SSE JSON reader; aborting/cancelling closes the underlying HTTP stream. */
export async function* readJsonEvents(response: Response): AsyncGenerator<any> {
  if(!response.ok || !response.body)throw new Error(`OpenCode event subscription failed (HTTP ${response.status})`);
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
  try {
    for(;;){
      const {value,done}=await reader.read();
      buffer=(buffer+decoder.decode(value,{stream:!done})).replace(/\r\n/g,'\n');
      let end:number;
      while((end=buffer.indexOf('\n\n'))>=0){
        const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
        const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(data)yield JSON.parse(data);
      }
      if(done)return;
    }
  } finally {await reader.cancel().catch(()=>{});}
}
