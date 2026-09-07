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
   if(r.plan.includes('# STORM plan selection seat')) return {exitCode:0,lastMessage:'<SELECTED_CANDIDATE>candidate-3</SELECTED_CANDIDATE>'};
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
 assert.equal(result.candidates[0].attempts.length,6);
 assert.equal(result.tokens.total.inputTokens,66);
});


test('production final-ruling parser rejects echoed, conflicting, and malformed decision fields', async t => {
  const rulings = [
    'DECISION: approve, DECISION: revise, or DECISION: stop',
    'DECISION: approve\nDECISION: stop',
    'DECISION: approve\nDECISION: approve',
    'DECISION: approve if the revision works',
    'DECISION: stop\nDECISION: approve',
    'DECISION: approve\nDECISION : stop',
  ];
  for (const ruling of rulings) {
    const options = setup(t);
    let finalReply;
    const result = await runPlan({ ...options, interactionMode: 'autonomous', adapters: adapters({
      author: async () => ({ answer: artifact().replace('AGREE: yes', 'AGREE: no') }),
      review: async r => {
        const digest = /ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1];
        if (!r.plan.includes('Return DECISION:')) {
          return { exitCode: 0, lastMessage: 'AGREE: no\nS1 P1: Continuing dispute\nARTIFACT_DIGEST: ' + digest };
        }
        finalReply = ruling + '\nREASON: This resolves the dispute.\nARTIFACT_DIGEST: ' + digest;
        return { exitCode: 0, lastMessage: finalReply };
      },
    }) });
    assert.equal(result.approved, false, ruling);
    assert.equal(result.reason, 'decision-unreadable', ruling);
    assert.equal(result.messages.at(-1).content, finalReply);
    assert.equal(existsSync(join(options.out, 'plan.md')), false);
  }
});


test('production selector retains the delivered selection and all failed-call usage before classification', async t => {
  for (const outcome of ['valid', 'invalid', 'failed', 'timeout']) {
    await t.test(outcome, async () => {
    const options = { ...setup(t), candidates: 2 };
    const selectionText = outcome === 'invalid'
      ? 'Neither option addresses the invariant.\n<SELECTED_CANDIDATE>missing</SELECTED_CANDIDATE>'
      : 'Choose the second approach because it preserves compatibility.\n<SELECTED_CANDIDATE>candidate-2</SELECTED_CANDIDATE>';
    const stderr = 'Complete selector diagnostic: ' + outcome;
    let reviews = 0;
    const result = await runPlan({ ...options, adapters: adapters({
      author: async r => ({ answer: artifact(r.request.candidateId), usage: { inputTokens: 10, outputTokens: 2 } }),
      review: async r => {
        if (r.plan.includes('# STORM plan selection seat')) return {
          exitCode: outcome === 'failed' ? 1 : outcome === 'timeout' ? null : 0,
          timedOut: outcome === 'timeout', lastMessage: selectionText, stderr,
          usage: { inputTokens: 7, outputTokens: 1 },
        };
        reviews++;
        return { exitCode: 0, lastMessage: 'AGREE: yes\nARTIFACT_DIGEST: '
          + /ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1] };
      },
    }) });
    assert.equal(result.tokens.total.inputTokens, 27, outcome);
    assert.equal(result.checkpointState.candidateState.selection.lastMessage, selectionText, outcome);
    assert.equal(result.checkpointState.candidateState.selection.stderr, stderr, outcome);
    assert.equal(result.approved, outcome === 'valid', outcome);
    assert.equal(reviews, outcome === 'valid' ? 1 : 0, outcome);
    if (outcome !== 'valid') assert.equal(existsSync(join(options.out, 'plan.md')), false);
    });
  }
});


test('default candidate drafts repair delivered malformed artifacts before selection without spending a round', async t => {
  const options = { ...setup(t), candidates: undefined, rounds: 1 };
  const attempts = new Map(), brokenReplies = [];
  let authors = 0, reviews = 0;
  const result = await runPlan({ ...options, adapters: adapters({
    author: async r => {
      authors++;
      const id = r.request.candidateId, attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      const broken = '<PLAN_MD>' + id + ' missing gate</PLAN_MD>';
      if (attempt === 1) {
        brokenReplies.push(broken);
        return { answer: broken, usage: { inputTokens: 10 } };
      }
      assert.match(r.prompt, /planner did not return PLAN_MD and GATE_JSON artifacts/);
      assert.ok(r.prompt.includes(broken));
      return { answer: artifact(id + ' repaired'), usage: { inputTokens: 10 } };
    },
    review: async r => {
      reviews++;
      if (r.plan.includes('# STORM plan selection seat')) return {
        exitCode: 0, lastMessage: '<SELECTED_CANDIDATE>candidate-2</SELECTED_CANDIDATE>',
        usage: { inputTokens: 7 },
      };
      assert.match(r.plan, /candidate-2 repaired/);
      return { exitCode: 0, lastMessage: 'AGREE: yes\nARTIFACT_DIGEST: '
        + /ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1], usage: { inputTokens: 3 } };
    },
  }) });
  assert.equal(result.approved, true);
  assert.equal(result.rounds, 1);
  assert.equal(authors, 6);
  assert.equal(reviews, 2);
  assert.equal(result.tokens.total.inputTokens, 70);
  for (const reply of brokenReplies) assert.ok(result.messages.some(message => message.content === reply));
  assert.equal(result.messages.filter(message => message.role === 'author').length, 6);
  assert.equal(result.checkpointState.artifactRepairs, 3);
});
test('default perpetually malformed candidates exhaust one shared repair budget and retain delivered evidence', async t => {
  const options = { ...setup(t), candidates: undefined };
  let authors = 0, reviews = 0;
  const result = await runPlan({ ...options, adapters: adapters({
    author: async () => {
      authors++;
      return { answer: '<PLAN_MD>Missing evidence artifact</PLAN_MD>', usage: { inputTokens: 10 } };
    },
    review: async () => { reviews++; return { exitCode: 0, lastMessage: 'unused' }; },
  }) });
  assert.equal(result.reason, 'proposal-irreparable');
  assert.equal(result.approved, false);
  assert.equal(authors, 8, 'three initial candidates and at most five repair calls');
  assert.equal(reviews, 0);
  assert.equal(result.tokens.total.inputTokens, 80);
  assert.equal(result.messages.length, 8);
  assert.equal(result.checkpointState.artifactRepairs, 6);
  assert.ok(result.messages.every(message => message.content === '<PLAN_MD>Missing evidence artifact</PLAN_MD>'));
  assert.equal(existsSync(join(options.out, 'plan.md')), false);
});
test('candidate repairs and later proposal repairs consume the same five-repair allowance', async t => {
  const options = { ...setup(t), candidates: undefined };
  let candidateOneCalls = 0, authorCalls = 0, reviews = 0;
  const result = await runPlan({ ...options, adapters: adapters({
    author: async r => {
      authorCalls++;
      if (r.request.previousProposal) return { answer: '<PLAN_MD>Malformed revision</PLAN_MD>' };
      if (r.request.candidateId === 'candidate-1' && ++candidateOneCalls <= 4) {
        return { answer: '<PLAN_MD>Malformed first alternative</PLAN_MD>' };
      }
      return { answer: artifact(r.request.candidateId) };
    },
    review: async r => {
      if (r.plan.includes('# STORM plan selection seat')) return {
        exitCode: 0, lastMessage: '<SELECTED_CANDIDATE>candidate-1</SELECTED_CANDIDATE>',
      };
      reviews++;
      return { exitCode: 0, lastMessage: 'AGREE: no\nS1 P1: Revise it\nARTIFACT_DIGEST: '
        + /ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1] };
    },
  }) });
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'proposal-irreparable');
  assert.equal(result.checkpointState.artifactRepairs, 6);
  assert.equal(authorCalls, 9);
  assert.equal(reviews, 1);
});

const superpowers = { seats: { codex: { verified:true }, claude: { verified:true } } };
test('autonomous planning final decision uses terminal stop despite earlier delivered approve marker', async t => {
  let finals = 0;
  const first = 'DECISION: approve\nREASON: Preliminary approval before checking the disputed branch.';
  const result = await runPlan({ ...setup(t), interactionMode: 'autonomous', adapters: adapters({ review: async r => {
    const digest = /ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1];
    const final = r.plan.includes('Return DECISION: approve');
    if (final) finals++;
    const terminal = final ? `DECISION: stop\nREASON: The requested behavior cannot be met.\nARTIFACT_DIGEST: ${digest}`
      : `AGREE: no\nS1 P1: Unresolved behavior.\nARTIFACT_DIGEST: ${digest}`;
    return { exitCode: 0, lastMessage: terminal, agentMessages: [first, terminal] };
  } }) });
  assert.equal(finals, 1);
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'reviewer-stopped');
  assert.equal(result.messages.at(-1).decision, 'stop');
  assert.ok(result.messages.at(-1).content.startsWith(first));
});
for (const failed of [false, true]) test(`planning retains every delivered Codex argument and terminal authority (failed=${failed})`, async t => {
  const prompts = [];
  const first = 'AGREE: yes\nDECISION: approve\nFirst delivered argument: preserve the original empty-input contract.';
  let reviews = 0;
  const result = await runPlan({ ...setup(t), adapters: adapters({
    author: async r => { prompts.push(r.prompt); return { answer: artifact('stable plan') }; },
    review: async r => {
      reviews++;
      const terminal = 'AGREE: no\nS1 P1: The boundary is unresolved.\nARTIFACT_DIGEST: '
        + /ARTIFACT_DIGEST: ([a-f0-9]{64})/.exec(r.plan)?.[1];
      return { exitCode: failed ? 1 : 0, timedOut: false, lastMessage: terminal,
        agentMessages: [first, terminal], stdout: 'complete captured stream', stderr: failed ? 'quota diagnostic' : '',
        usage: { inputTokens: 7, outputTokens: 3 } };
    },
  }) });
  assert.equal(result.approved, false);
  const retained = result.messages.filter(message => message.speaker === 'codex');
  assert.equal(retained.length, reviews);
  assert.ok(retained.every(message => message.content.indexOf(first) === 0));
  assert.ok(retained.every(message => message.transport.agentMessages[0] === first));
  assert.equal(result.tokens.total.inputTokens, reviews * 7);
  assert.equal(result.tokens.total.outputTokens, reviews * 3);
  if (failed) {
    assert.equal(result.reason, 'reviewer-unavailable');
    assert.equal(retained[0].transport.stderr, 'quota diagnostic');
  } else {
    assert.equal(result.reason, 'needs-decision');
    assert.ok(prompts[1].includes(first));
    assert.ok(retained.every(message => message.stance === 'disagree'));
  }
});
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
