import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan, runPlanCandidateSet } from '../src/plan.js';
import { applySuperpowersRequirement } from '../src/superpowers.js';

test('candidate token totals include every authored alternative and the reviewer selection',async t=>{
 const options=setup(t);
 const result=await runPlanCandidateSet({...options,count:2,interactionMode:'autonomous',
  draft:async r=>({plan:r.candidateId,gate:[],agree:true,readable:true,content:'AGREE: yes',
    usage:{inputTokens:10,outputTokens:2}}),
  select:async()=>({selectedCandidateId:'candidate-2',usage:{inputTokens:5,outputTokens:1}}),
  review:async r=>({agree:true,readable:true,content:'AGREE: yes',artifactDigest:r.artifactDigest,
    usage:{inputTokens:3,outputTokens:1}}),
 });
 assert.equal(result.tokens.total.inputTokens,28);
 assert.equal(result.tokens.total.outputTokens,6);
});
test('candidate approval identity ignores transport usage but includes artifact bytes',async t=>{
 const options=setup(t);
 const make=usage=>runPlanCandidateSet({...options,count:1,
  draft:async()=>({plan:'same plan',gate:[],agree:true,readable:true,content:'AGREE: yes',usage}),
  review:async r=>({agree:true,readable:true,content:'AGREE: yes',artifactDigest:r.artifactDigest}),
 });
 const first=await make({inputTokens:10}),second=await make({inputTokens:20});
 assert.equal(first.approval.artifactDigest,second.approval.artifactDigest);
});
test('a failed or unreadable candidate selection never silently chooses the first alternative',async t=>{
 const options=setup(t);
 for(const select of [async()=>({}),async()=>{throw new Error('offline');}]){
  const result=await runPlanCandidateSet({...options,count:2,
   draft:async r=>({plan:r.candidateId,gate:[],agree:true,readable:true,content:'AGREE: yes'}),
   select,review:async()=>assert.fail('No selected artifact exists'),
  });
  assert.equal(result.approved,false);
  assert.equal(result.selected,null);
 }
});


test('standalone candidate count authors distinct alternatives and reviews the Codex-selected artifact',async t=>{
 let authors=0;
 const result=await runPlan({...setup(t),candidates:3,adapters:adapters({
  author:async r=>{
   authors++;
   assert.equal(r.request.candidateCount,3);
   return {answer:artifact('Approach '+r.request.candidateId)};
  },
  review:async r=>{
   if(r.plan.includes('SELECTED_CANDIDATE')) return {exitCode:0,lastMessage:'<SELECTED_CANDIDATE>candidate-3</SELECTED_CANDIDATE>'};
   assert.match(r.plan,/Approach candidate-3/);
   return {exitCode:0,lastMessage:'AGREE: yes\nARTIFACT_DIGEST: '+/ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1]};
  },
 })});
 assert.equal(result.approved,true);
 assert.equal(authors,3);
 assert.match(readFileSync(result.planPath,'utf8'),/Approach candidate-3/);
});


test('standalone autonomous planning routes a dissenting final decision to Codex',async t=>{
 let reviews=0;
 const result=await runPlan({...setup(t),interactionMode:'autonomous',adapters:adapters({
  author:async()=>({answer:artifact().replace('AGREE: yes','AGREE: no')}),
  review:async r=>{
   reviews++;
   const digest=/ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1];
   return {exitCode:0,lastMessage:(r.plan.includes('Return DECISION:')
     ?'DECISION: approve\nREASON: The current approach meets the requirements.'
     :'AGREE: no\nS1 P1: Discuss the approach')+'\nARTIFACT_DIGEST: '+digest};
  },
 })});
 assert.equal(result.approved,true);
 assert.equal(result.converged,false);
 assert.equal(result.approval.decidedBy,'codex');
 assert.equal(reviews,3);
});
test('a timed-out planning reviewer retains partial output and never writes a plan',async t=>{
 const opts=setup(t);
 const result=await runPlan({...opts,executorTimeout:12,adapters:adapters({
  review:async r=>{
   assert.equal(r.timeoutMs,12);
   return {exitCode:null,timedOut:true,stderr:'complete timeout explanation',
    lastMessage:'Partial review'};
  },
 })});
 assert.equal(result.reason,'reviewer-unavailable');
 assert.equal(result.messages.at(-1).content,'Partial review');
 assert.match(result.messages.at(-1).error,/complete timeout explanation/);
 assert.equal(existsSync(join(opts.out,'plan.md')),false);
});


test('failed candidate selection retains all consumed usage and raw authored alternatives',async t=>{
 const result=await runPlanCandidateSet({...setup(t),count:2,
  draft:async r=>({plan:r.candidateId,gate:[],content:'AGREE: yes\n'+r.candidateId,
    agree:true,readable:true,usage:{inputTokens:10,outputTokens:2}}),
  select:async()=>({selectedCandidateId:'missing',answer:'No usable selection',usage:{inputTokens:5,outputTokens:1}}),
 });
 assert.equal(result.approved,false);
 assert.equal(result.tokens.total.inputTokens,25);
 assert.equal(result.checkpointState.candidateState.selection.answer,'No usable selection');
 assert.equal(result.checkpointState.candidateState.candidates[0].response.content,'AGREE: yes\ncandidate-1');
});


test('a malformed candidate keeps its delivered artifact and usage for diagnosis',async t=>{
 const result=await runPlanCandidateSet({...setup(t),count:1,
  draft:async()=>({answer:'Broken <PLAN_MD> with no gate',usage:{inputTokens:11,outputTokens:3}}),
 });
 assert.equal(result.approved,false);
 assert.equal(result.candidates[0].response.answer,'Broken <PLAN_MD> with no gate');
 assert.equal(result.tokens.total.inputTokens,11);
});

const superpowers = { seats: { codex: { verified:true }, claude: { verified:true } } };
const artifact = (text = 'Plan with "quotes"\nand newlines') =>
  'AGREE: yes\n<PLAN_MD>' + text + '</PLAN_MD>\n<GATE_JSON>[{"bin":"node","args":["--test"]}]</GATE_JSON>';
function setup(t) {
  const target = mkdtempSync(join(tmpdir(),'two-agent-plan-'));
  t.after(() => rmSync(target,{recursive:true,force:true}));
  return { target, out:join(target,'out'), goal:'Deliver the requested behavior', superpowers, candidates:1 };
}
function adapters({ author, review } = {}) {
  return {
    runArbiter: author ?? (async () => ({ answer:artifact() })),
    runExecutor: review ?? (async r => ({
      exitCode:0, lastMessage:'AGREE: yes\nARTIFACT_DIGEST: ' + /ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1],
    })),
  };
}
test('plan uses Claude author and Codex read-only review with intact artifact bytes and writes approved files', async t => {
  const options = setup(t), seen = [];
  const result = await runPlan({...options, adapters:adapters({
    author:async r => { seen.push(['claude',r]); return {answer:artifact()}; },
    review:async r => { seen.push(['codex',r]); return {
      exitCode:0,lastMessage:'AGREE: yes\nARTIFACT_DIGEST: ' + /ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1],
    }; },
  })});
  assert.equal(result.approved,true);
  assert.deepEqual(seen.map(([provider])=>provider),['claude','codex']);
  assert.equal(seen[1][1].sandbox,'read-only');
  assert.match(seen[1][1].plan,/Plan with "quotes"\nand newlines/);
  assert.equal(readFileSync(result.planPath,'utf8'),'Plan with "quotes"\nand newlines\n');
  assert.deepEqual(JSON.parse(readFileSync(result.gatePath,'utf8')),[{bin:'node',args:['--test']}]);
  assert.match(result.approval.artifactDigest,/^[a-f0-9]{64}$/);
});
test('plan feedback reaches the real author prompt and review sees its revision', async t => {
  let authors = 0, reviews = 0;
  const result = await runPlan({...setup(t),adapters:adapters({
    author:async r => {
      authors++;
      if(authors===2) assert.match(r.prompt,/S1 P1: Preserve "A"\nSecond objection line/);
      return {answer:artifact(authors===1?'old':'revised')};
    },
    review:async r => {
      reviews++;
      if(reviews===2) assert.match(r.plan,/revised/);
      return {exitCode:0,lastMessage:(reviews===1?'AGREE: no\nS1 P1: Preserve "A"\nSecond objection line':'AGREE: yes')
        +'\nARTIFACT_DIGEST: '+/ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1]};
    },
  })});
  assert.equal(result.approved,true);
  assert.equal(authors,2);
});
test('standalone manual disputes expose pending state and do not write approved artifacts', async t => {
  const options=setup(t);
  const result=await runPlan({...options,adapters:adapters({
    review:async r=>({exitCode:0,lastMessage:'AGREE: no\nS1 P1: unresolved\nARTIFACT_DIGEST: '
      +/ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1]}),
  })});
  assert.equal(result.reason,'needs-decision');
  assert.equal(result.checkpointState.interactionMode,'manual');
  assert.equal(existsSync(join(options.out,'plan.md')),false);
});
test('dry run and missing provider verification never launch model CLIs', async t => {
  const options=setup(t);
  const boundary={runArbiter:()=>assert.fail('paid author call'),runExecutor:()=>assert.fail('paid review call')};
  const dry=await runPlan({...options,dryRun:true,adapters:boundary});
  assert.equal(dry.dryRun,true);
  await assert.rejects(runPlan({...options,superpowers:{seats:{codex:{verified:true}}},adapters:boundary}),/Claude|claude/);
});
test('planning preflight checks the actual two providers without inventing Cursor evidence', () => {
  const result=applySuperpowersRequirement(superpowers,{}, {requiredSeats:['codex','claude']});
  assert.equal(result.ok,true);
  assert.deepEqual(Object.keys(result.verification.seats).sort(),['claude','codex']);
});
test('candidate alternatives use Claude authorship and Codex reviews exact selected approach', async t => {
  const options=setup(t);
  const result=await runPlanCandidateSet({...options,count:2,interactionMode:'autonomous',
    draft:async r=>({plan:r.candidateId,gate:[],agree:true,readable:true,content:'AGREE: yes'}),
    select:async r=>({selectedCandidateId:'candidate-2',reason:'Better compatibility'}),
    review:async r=>({...{agree:true,readable:true,content:'AGREE: yes'},artifactDigest:r.artifactDigest}),
  });
  assert.equal(result.selected.id,'candidate-2');
  assert.equal(result.approved,true);
  assert.equal(result.approval.decidedBy,'codex');
  assert.equal(result.selected.author,'claude');
});
