import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionEvidence, reduceEvidence } from './completion-evidence.ts';

test('preserves clarification chain and subsequent responses, excluding generated prompts and legacy summaries', () => {
 const result = completionEvidence([
  {type:'user_message',text:'Implement deletion'},
  {type:'assistant_message',text:'Retain receipts for seven years?'},
  {type:'user_message',text:'yes'},
  {type:'tool_call',text:'HUGE RAW TOOL OUTPUT'},
  {type:'user_message',text:'<paseo-system>Child finished</paseo-system>'},
  {type:'assistant_message',text:'Tests passed in tests/deletion.ts'},
  {type:'user_message',text:'This is a plugin-internal context-preparation turn'},
  {type:'assistant_message',text:'LEGACY WALL'},
  {type:'user_message',text:"The completion gate judged that you didn't complete the user ask."},
  {type:'assistant_message',text:'Remaining work fixed'},
 ]);
 for (const text of ['Implement deletion','Retain receipts','yes','Tests passed','Remaining work fixed']) assert.ok(result.includes(text));
 for (const text of ['HUGE RAW','paseo-system','LEGACY WALL','plugin-internal','completion gate judged']) assert.ok(!result.includes(text));
});
test('coalesces streamed same-type deltas into one labeled block', () => {
 const result = completionEvidence([
  {type:'user_message',text:'Verify the quota logic'},
  {type:'assistant_message',text:'daily-write '},
  {type:'assistant_message',text:'quota '},
  {type:'assistant_message',text:'(`7500`) prevents overuse'},
 ]);
 assert.equal((result.match(/ASSISTANT EVIDENCE \(claims to verify\):/g)||[]).length, 1);
 assert.equal((result.match(/USER REQUEST \/ CLARIFICATION:/g)||[]).length, 1);
 assert.ok(result.includes('daily-write quota (`7500`) prevents overuse'));
});
test('no identifiable user ask refuses to judge', () => {
 assert.throws(() => completionEvidence([{type:'assistant_message',text:'done'}]), /No identifiable/);
});
test('fitting evidence is untouched and never summarized', async () => {
 assert.equal(await reduceEvidence('unchanged',1024,async()=>{throw Error('unexpected')}),'unchanged');
});
test('hierarchical summaries cover every input character and merge without splitting Unicode', async () => {
 const original='🦙'.repeat(1500);
 const calls=[];
 const result=await reduceEvidence(original,1024,async part=>{ calls.push(part); return 's'.repeat(250); });
 assert.equal(calls.slice(0,6).join(''),original);
 assert.ok(calls.every(p=>Buffer.byteLength(p)<=1024 && !p.includes('\uFFFD')));
 assert.ok(calls.length>6);
 assert.ok(Buffer.byteLength(result)<=1024);
});
test('failure, empty output and non-shrinking summaries never silently lose evidence', async () => {
 const text='x'.repeat(2000);
 await assert.rejects(reduceEvidence(text,1024,async()=>{throw Error('provider failed')}),/provider failed/);
 await assert.rejects(reduceEvidence(text,1024,async()=>''),/Empty/);
 await assert.rejects(reduceEvidence(text,1024,async p=>p),/no progress/);
});
