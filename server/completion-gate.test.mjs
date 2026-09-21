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
const childRoleId = '22222222-2222-4222-8222-222222222222';
const role=(id,gate)=>({id,name:'test',provider:'test',model:'model',description:'',systemPrompt:'',thinkingOptionId:null,modeId:null,delegation:{enabled:false,allowedRoleIds:[],completionGateEnabled:gate},createdAt:'now',updatedAt:'now'});
await writeFile(join(home,'plugin-data/role-orchestrator.json'), JSON.stringify({roles:[role(roleId,true),role(childRoleId,false)]}));
await saveCompletionGateSettings({provider:'test',model:'judge',thinkingOptionId:null,modeId:null,prompt:'Judge',context:'full'});
after(()=>rm(home,{recursive:true,force:true}));

function setup({verdict='pass',overflow=false,stale=false,judgeMessages=null,liveDescendants=[],listThrows=false}={}) {
 const hooks=new Map(), created=[], sent=[], archived=[], gateSends=[];
 const agent={id:'parent',provider:'test',model:'model',cwd:home,workspaceId:'workspace',labels:{'paseo-role-orchestrator.role-id':roleId}};
 const paseo={providers:{listModels:async()=>({models:[{id:'judge'}]})},agents:{list:async()=>{if(listThrows)throw new Error('daemon unreachable');return {entries:[{agent},...liveDescendants.map(a=>({agent:a}))]}},ref:()=>({refresh:async()=>({agent}),send:async text=>sent.push(text),run:()=>{throw Error('Supervisor must never summarize')}})},workspaces:{ref:()=>({agents:{create:async options=>{
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
for (const verdict of ['pass','blocked','waiting','continue']) test(`missing model-window metadata still judges; ${verdict} disposition`,async()=>{
 const h=setup({verdict});try {
  await h.fire();assert.equal(h.created.length,1);assert.equal(h.archived.length,1);
  assert.equal(h.sent.length,verdict==='continue'?1:0);
 }finally{h.cleanup()}
});
// waiting/blocked send nothing to the agent, so the daemon log is the only place the
// named in-flight processes / blockers can surface. A silent verdict must not be mute.
for (const verdict of ['blocked','waiting']) test(`a silent ${verdict} verdict names its remaining tasks in the log`,async()=>{
 const logs=[];const original=console.log;console.log=(...args)=>logs.push(args);
 const h=setup({verdict});try{
  await h.fire();
  assert.equal(h.sent.length,0,'silent toward the agent');
  const finished=logs.find(args=>args[0]==='Completion check finished');
  assert.ok(finished,'finished log entry exists');
  assert.deepEqual(finished[1].remainingTasks,['verify tests'],'log carries the named tasks');
 }finally{console.log=original;h.cleanup()}
});
// A supervisor babysitting a delegated child ends many short turns (approving the child's
// permissions, checking status). The in-memory child maps are lost on any plugin reload and never
// see children created before load, so the gate would nag "do not idle" on every such turn. Ground
// truth from agents.list + the paseo.parent-agent-id label is authoritative regardless of reloads.
test('an actively running descendant suppresses the gate even with no in-memory tracking',async()=>{
 const h=setup({verdict:'continue',liveDescendants:[{id:'child',status:'running',labels:{'paseo.parent-agent-id':'parent'}}]});try{
  await h.fire();
  assert.equal(h.created.length,0,'no judge is launched while a descendant works');
  assert.equal(h.sent.length,0,'the parent is not nagged');
 }finally{h.cleanup()}
});
test('a descendant awaiting a permission decision suppresses the gate',async()=>{
 const h=setup({verdict:'continue',liveDescendants:[{id:'child',status:'idle',pendingPermissions:[{id:'p'}],labels:{'paseo.parent-agent-id':'parent'}}]});try{
  await h.fire();assert.equal(h.created.length,0);assert.equal(h.sent.length,0);
 }finally{h.cleanup()}
});
test('a transitive grandchild still working suppresses the gate',async()=>{
 const h=setup({verdict:'continue',liveDescendants:[
  {id:'child',status:'idle',labels:{'paseo.parent-agent-id':'parent'}},
  {id:'grandchild',status:'running',labels:{'paseo.parent-agent-id':'child'}},
 ]});try{
  await h.fire();assert.equal(h.created.length,0);
 }finally{h.cleanup()}
});
test('an idle descendant does not suppress the gate',async()=>{
 const h=setup({verdict:'continue',liveDescendants:[{id:'child',status:'idle',labels:{'paseo.parent-agent-id':'parent'}}]});try{
  await h.fire();assert.equal(h.created.length,1);assert.equal(h.sent.length,1);
 }finally{h.cleanup()}
});
test('an archived descendant does not suppress the gate',async()=>{
 const h=setup({verdict:'continue',liveDescendants:[{id:'child',status:'running',archivedAt:'now',labels:{'paseo.parent-agent-id':'parent'}}]});try{
  await h.fire();assert.equal(h.created.length,1);
 }finally{h.cleanup()}
});
test('an unverifiable descendant tree fails safe and suppresses the gate',async()=>{
 const h=setup({verdict:'continue',listThrows:true});try{
  await h.fire();assert.equal(h.created.length,0,'a tree we cannot verify is never nagged or passed');
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
  assert.match(h.created[0].prompt,/perform ITSELF right now/);
  assert.match(h.created[0].prompt,/already in progress/i);
  assert.match(h.created[0].prompt,/waiting on the owner or an external/i);
  assert.match(h.created[0].prompt,/Return waiting when the remaining work is already in progress/);
  assert.match(h.created[0].prompt,/Return blocked only when/);
  assert.match(h.created[0].prompt,/Do not return blocked for work a running process is already performing/);
  assert.match(h.created[0].prompt,/paseo script ls/);
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

// The parent gate only runs on the PARENT's own turn_ended. A parent that ends its turn while a
// child works, and never resumes when the child finishes, is otherwise never revisited (confirmed
// stalling a real Supervisor run). The last descendant going idle must revisit the parent.
function wakeSetup() {
 const hooks=new Map(), sent=[], created=[];
 const parent={id:'parent',workspaceId:'ws',cwd:home,labels:{'paseo-role-orchestrator.role-id':roleId}};
 const child={id:'child',parentAgentId:'parent',workspaceId:'ws',cwd:home,labels:{'paseo-role-orchestrator.role-id':childRoleId}};
 const byId={parent,child};
 const paseo={providers:{listModels:async()=>({models:[{id:'judge'}]})},agents:{list:async()=>({entries:Object.values(byId).map(agent=>({agent}))}),ref:id=>({refresh:async()=>({agent:byId[id]}),send:async t=>sent.push({id,t})})},workspaces:{ref:()=>({agents:{create:async o=>{created.push(o);return{archive:async()=>{},waitForFinish:async()=>({status:'idle',lastMessage:'{"verdict":"continue","remainingTasks":["x"]}'})}}}})}};
 const cleanup=installCompletionGate({on:(name,fn)=>{hooks.set(name,fn);return ()=>hooks.delete(name)}});
 const childEnded=()=>hooks.get('agent.turn_ended')({agent:{id:'child',parentAgentId:'parent',workspaceId:'ws'},outcome:{kind:'completed'},timeline:[]},{paseo});
 return {hooks,sent,created,cleanup,childEnded,
  woke:()=>sent.filter(s=>s.id==='parent' && /did not resume|not monitoring/i.test(s.t)).length};
}

test('a parent that never resumes after its last child finishes is woken', async()=>{
 const h=wakeSetup();try{
  await h.hooks.get('agent.created')({agent:{id:'child',parentAgentId:'parent'}});
  await h.childEnded();
  await new Promise(r=>setTimeout(r,1300));
  assert.equal(h.woke(),1);
 }finally{h.cleanup()}
});

test('a parent that resumes on its own is not woken', async()=>{
 const h=wakeSetup();try{
  await h.hooks.get('agent.created')({agent:{id:'child',parentAgentId:'parent'}});
  const ended=h.childEnded();
  // The parent starts its own turn during quiescence — its generation moves, so no nudge.
  await new Promise(r=>setTimeout(r,150));
  h.hooks.get('agent.turn_started')({agent:{id:'parent'}});
  await ended; await new Promise(r=>setTimeout(r,1300));
  assert.equal(h.woke(),0);
 }finally{h.cleanup()}
});

test('a parent with another child still working is not woken early', async()=>{
 const h=wakeSetup();try{
  await h.hooks.get('agent.created')({agent:{id:'child',parentAgentId:'parent'}});
  await h.hooks.get('agent.created')({agent:{id:'child2',parentAgentId:'parent'}});
  await h.childEnded();  // one finishes; a sibling is still active
  await new Promise(r=>setTimeout(r,1300));
  assert.equal(h.woke(),0);
 }finally{h.cleanup()}
});
