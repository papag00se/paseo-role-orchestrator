import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Production uses extensionless imports resolved by Paseo's bundler.
registerHooks({resolve(specifier, context, next) {
 try { return next(specifier, context); }
 catch (error) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier+'.ts',context);
  throw error;
 }
}});
const home = await mkdtemp(join(tmpdir(),'completion-gate-test-'));
process.env.PASEO_HOME = home;
await mkdir(join(home,'plugin-data'));
const { installCompletionGate, saveCompletionGateSettings } = await import('./completion-gate.ts');
const roleId = '11111111-1111-4111-8111-111111111111';
await writeFile(join(home,'plugin-data/role-orchestrator.json'), JSON.stringify({roles:[{
 id:roleId,name:'test',provider:'test',model:'model',description:'',systemPrompt:'',thinkingOptionId:null,modeId:null,
 delegation:{enabled:false,allowedRoleIds:[],completionGateEnabled:true},createdAt:'now',updatedAt:'now'
}]}));
await saveCompletionGateSettings({provider:'test',model:'judge',thinkingOptionId:null,modeId:null,prompt:'Judge',context:'full'});
after(()=>rm(home,{recursive:true,force:true}));

function setup({verdict='pass',overflow=false,stale=false,judgeMessages=null}={}) {
 const hooks=new Map(), created=[], sent=[], archived=[], gateSends=[];
 const agent={id:'parent',provider:'test',model:'model',cwd:home,workspaceId:'workspace',labels:{'paseo-role-orchestrator.role-id':roleId}};
 const paseo={providers:{listModels:async()=>({models:[{id:'judge'}]})},agents:{ref:()=>({refresh:async()=>({agent}),send:async text=>sent.push(text),run:()=>{throw Error('Supervisor must never summarize')}})},workspaces:{ref:()=>({agents:{create:async options=>{
  created.push(options);
  assert.equal(options.parent,undefined);
  assert.equal(options.config.provider,'test/judge');
  return {archive:async()=>archived.push(options.title),send:async text=>gateSends.push(text),waitForFinish:async()=>{
   if (stale) hooks.get('agent.turn_started')({agent});
   if (overflow && created.length===1) return {status:'error',error:'Your input exceeds the context window of this model'};
   if (judgeMessages && options.title==='Completion gate') return {status:'idle',lastMessage:judgeMessages.shift()};
   return {status:'idle',lastMessage:options.title==='Completion evidence summary'?'User asked for tests. Tests passed; verify workspace.':JSON.stringify(verdict==='pass'?{verdict}:{verdict,remainingTasks:['verify tests']})};
  }};
 }}})}};
 const cleanup=installCompletionGate({on:(name,fn)=>{hooks.set(name,fn);return ()=>hooks.delete(name)}});
 return {hooks,created,sent,archived,gateSends,cleanup,async fire(kind='completed') {
  await hooks.get('agent.turn_ended')({agent,outcome:{kind},timeline:[{type:'user_message',text:'Verify tests'},{type:'assistant_message',text:'Evidence '+ 'x'.repeat(7000)}]}, {paseo});
  await new Promise(resolve=>setTimeout(resolve,100));
 }};
}
for (const verdict of ['pass','blocked','continue']) test(`missing model-window metadata still judges; ${verdict} disposition`,async()=>{
 const h=setup({verdict});try {
  await h.fire();assert.equal(h.created.length,1);assert.equal(h.archived.length,1);
  assert.equal(h.sent.length,verdict==='continue'?1:0);
 }finally{h.cleanup()}
});
test('context overflow creates isolated summaries and retries the judge',async()=>{
 const h=setup({overflow:true});try{
  await h.fire();assert.equal(h.created[0].title,'Completion gate');
  assert.ok(h.created.some(o=>o.title==='Completion evidence summary'));
  assert.equal(h.created.at(-1).title,'Completion gate');
  assert.equal(h.archived.length,h.created.length);
 }finally{h.cleanup()}
});
test('new parent turn invalidates the judge result',async()=>{
 const h=setup({verdict:'continue',stale:true});try{await h.fire();assert.equal(h.created.length,1);assert.equal(h.sent.length,0)}finally{h.cleanup()}
});
test('judge prompt reserves blocked for a globally blocked ledger',async()=>{
 const h=setup({verdict:'blocked'});try{
  await h.fire();
  assert.match(h.created[0].prompt,/inspect every incomplete requirement/i);
  assert.match(h.created[0].prompt,/blocked item does not block the whole request/i);
  assert.match(h.created[0].prompt,/Return blocked only when every incomplete requirement/i);
  assert.match(h.created[0].prompt,/Judge whether the recent strategy is converging/i);
  assert.match(h.created[0].prompt,/strategy-reset task/i);
 }finally{h.cleanup()}
});
test('failed parent turns do not launch judges',async()=>{
 const h=setup();try{await h.fire('failed');assert.equal(h.created.length,0)}finally{h.cleanup()}
});
test('a prose-wrapped verdict is still extracted',async()=>{
 const h=setup({judgeMessages:['I inspected the workspace.\n```json\n{"verdict":"continue","remainingTasks":["finish the ledger"]}\n```\nThat is my judgment.']});try{
  await h.fire();
  assert.equal(h.gateSends.length,0,'no retry needed');
  assert.equal(h.sent.length,1);
  assert.match(h.sent[0],/finish the ledger/);
 }finally{h.cleanup()}
});
test('a malformed verdict gets one constrained retry in the same gate session',async()=>{
 const h=setup({judgeMessages:['All six cells remain open; more work is required.','{"verdict":"continue","remainingTasks":["finish the ledger"]}']});try{
  await h.fire();
  assert.equal(h.gateSends.length,1);
  assert.match(h.gateSends[0],/Return only the JSON verdict object/);
  assert.equal(h.sent.length,1);
  assert.match(h.sent[0],/finish the ledger/);
 }finally{h.cleanup()}
});
test('a persistently malformed verdict fails closed to continue and preserves the raw output',async()=>{
 await rm(join(home,'plugin-data/role-orchestrator-gate-failures.jsonl'),{force:true});
 const h=setup({judgeMessages:['All six cells remain open.','Still prose, no JSON.']});try{
  await h.fire();
  assert.equal(h.gateSends.length,1);
  assert.equal(h.sent.length,1,'the parent must not be left idle');
  assert.match(h.sent[0],/could not produce a valid verdict/);
  assert.match(h.sent[0],/not yet complete/);
  const records=(await readFile(join(home,'plugin-data/role-orchestrator-gate-failures.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length,2);
  assert.equal(records[0].phase,'initial');
  assert.equal(records[0].raw,'All six cells remain open.');
  assert.equal(records[1].phase,'retry');
  assert.equal(records[1].raw,'Still prose, no JSON.');
 }finally{h.cleanup()}
});
