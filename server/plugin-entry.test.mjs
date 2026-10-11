// Lifecycle regression through the real plugin entry: the completion gate must actually be
// registered, otherwise a gate-enabled role's yielded turn is silently accepted as complete.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

registerHooks({resolve(specifier, context, next) {
 try { return next(specifier, context); }
 catch (error) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier+'.ts',context);
  throw error;
 }
}});
const home = await mkdtemp(join(tmpdir(),'plugin-entry-test-'));
process.env.PASEO_HOME = home;
await mkdir(join(home,'plugin-data'));
const gated = '11111111-1111-4111-8111-111111111111';
const ungated = '22222222-2222-4222-8222-222222222222';
const role=(id,gate)=>({id,name:'r'+gate,provider:'test',model:'model',description:'',systemPrompt:'',thinkingOptionId:null,modeId:null,delegation:{enabled:false,allowedRoleIds:[],completionGateEnabled:gate},createdAt:'now',updatedAt:'now'});
await writeFile(join(home,'plugin-data/role-orchestrator.json'), JSON.stringify({roles:[role(gated,true),role(ungated,false)]}));
const JUDGE_PROMPT='Configured judge prompt';
await writeFile(join(home,'plugin-data/role-orchestrator-completion-gate.json'), JSON.stringify({provider:'test',model:'judge',thinkingOptionId:'high',modeId:null,prompt:JUDGE_PROMPT}));
const { default: contribute } = await import('../index.server.ts');
after(()=>rm(home,{recursive:true,force:true}));

function load({reply,roleId=gated,live=[]}={}) {
 const hooks=new Map(), sent=[], created=[];
 const server={handle(){},on:(name,fn)=>{hooks.set(name,fn);return ()=>hooks.delete(name)}};
 const unload=contribute(server);
 const agent={id:'sup',cwd:home,workspaceId:'ws',labels:{'paseo-role-orchestrator.role-id':roleId}};
 const paseo={providers:{listModels:async()=>({models:[{id:'judge'}]})},
  agents:{list:async()=>({entries:[{agent},...live.map(a=>({agent:a}))]}),ref:()=>({refresh:async()=>({agent}),send:async t=>sent.push(t)})},
  workspaces:{ref:()=>({agents:{create:async o=>{created.push(o);return {id:'j'+created.length,archive:async()=>{},send:async()=>{},
   waitForFinish:async()=>typeof reply==='function'?reply():{status:'idle',lastMessage:reply}}}}})}};
 const end=()=>hooks.get('agent.turn_ended')({agent:{id:'sup',workspaceId:'ws',parentAgentId:null,title:'Supervisor'},turnId:'t1',outcome:{kind:'completed'},
  timeline:[{type:'user_message',text:'Fix the Java importer and prove it with tests'},{type:'assistant_message',text:'Progress report: I reviewed the code and will fix it next.'}]},{paseo});
 return {hooks,sent,created,end,unload};
}
const settle=()=>new Promise(r=>setTimeout(r,1500));
const incomplete='{"verdict":"continue","remainingTasks":["Implement the importer fix","Run the tests"]}';

test('the entry registers the completion gate hooks',async()=>{
 const h=load({reply:incomplete});try{
  for (const name of ['agent.turn_ended','agent.turn_started','agent.created','agent.archived']) assert.ok(h.hooks.has(name),name);
 }finally{await h.unload()}
});
test('an incomplete yielded turn is sent back to work using the configured judge',async()=>{
 const h=load({reply:incomplete});try{
  await h.end();await settle();
  assert.equal(h.created.length,1);
  assert.equal(h.created[0].config.provider,'test/judge');
  assert.equal(h.created[0].config.thinkingOptionId,'high');
  assert.equal(h.created[0].config.systemPrompt,JUDGE_PROMPT);
  assert.match(h.created[0].prompt,/Fix the Java importer/);
  assert.equal(h.sent.length,1);assert.match(h.sent[0],/Implement the importer fix/);
 }finally{await h.unload()}
});
test('a genuinely complete turn is accepted without nagging',async()=>{
 const h=load({reply:'{"verdict":"pass"}'});try{await h.end();await settle();assert.equal(h.created.length,1);assert.equal(h.sent.length,0)}finally{await h.unload()}
});
test('an unparseable judge fails closed; a dead judge stays quiet instead of looping',async()=>{
 const bad=load({reply:'no idea'});try{await bad.end();await settle();assert.equal(bad.sent.length,1);assert.match(bad.sent[0],/unconfirmed/)}finally{await bad.unload()}
 const dead=load({reply:()=>({status:'error',error:'provider down'})});
 const errors=console.error;console.error=()=>{};
 try{await dead.end();await settle();assert.equal(dead.created.length,1,'no judge retry storm');assert.equal(dead.sent.length,0)}finally{console.error=errors;await dead.unload()}
});
test('a supervisor waiting on a running child is neither judged nor nagged',async()=>{
 const h=load({reply:incomplete,live:[{id:'kid',status:'running',labels:{'paseo.parent-agent-id':'sup'}}]});try{
  await h.end();await settle();assert.equal(h.created.length,0);assert.equal(h.sent.length,0);
 }finally{await h.unload()}
});
test('a duplicate turn-ended event yields one judge and one continuation',async()=>{
 const h=load({reply:incomplete});try{
  await Promise.all([h.end(),h.end()]);await settle();
  assert.equal(h.created.length,1);assert.equal(h.sent.length,1);
 }finally{await h.unload()}
});
test('reload: the old registration is removed and the new one judges alone',async()=>{
 const old=load({reply:incomplete});const fresh=load({reply:incomplete});
 await old.unload();
 assert.equal(old.hooks.size,0);
 try{await fresh.end();await settle();assert.equal(fresh.created.length,1);assert.equal(fresh.sent.length,1)}finally{await fresh.unload()}
});
test('a role with the gate disabled is never judged',async()=>{
 const h=load({reply:incomplete,roleId:ungated});try{await h.end();await settle();assert.equal(h.created.length,0);assert.equal(h.sent.length,0)}finally{await h.unload()}
});
