import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runConversation, parseSeatReview, RepairableArtifactError, MAX_ARTIFACT_REPAIRS, stanceRepairLines } from '../src/conversation.js';

test('writer contradictions revoke approval and feed the failure back before a new version is reviewed', async () => {
  const f=fixture({authors:[proposal(),proposal('fixed')]});
  let attempts=0;
  f.options.strategy.writeConverged=p=>{
    if(++attempts===1) throw new RepairableArtifactError('T1 and T2 form a dependency cycle');
    f.writes.push(p);
    return {written:true};
  };
  const result=await runConversation(f.options);
  assert.equal(result.approved,true);
  assert.equal(f.writes[0].plan,'fixed');
  assert.match(f.authorRequests[1].feedback,/T1 and T2 form a dependency cycle/);
  assert.notEqual(f.reviewerRequests[0].artifactDigest,f.reviewerRequests[1].artifactDigest);
});
test('parse and writer repairs share one budget and never retain a rejected approval', async () => {
  const f=fixture({authors:[proposal('MALFORMED'),proposal()],rounds:10});
  f.options.strategy.writeConverged=()=>{throw new RepairableArtifactError('writer rejects cycle');};
  const result=await runConversation(f.options);
  assert.equal(result.reason,'proposal-irreparable');
  assert.equal(result.approved,false);
  assert.equal(result.approval,null);
  assert.equal(result.roundHistory.filter(row=>row.repair).length,MAX_ARTIFACT_REPAIRS+1);
});
test('an empty author response terminates without a repair loop',async()=>{
  const f=fixture();
  f.options.seats.author=async()=>null;
  const result=await runConversation(f.options);
  assert.equal(result.reason,'author-unavailable');
  assert.equal(result.approved,false);
  assert.equal(result.messages.length,1);
});
test('a final ruling without a digest or a reason cannot approve',async()=>{
  for(const omission of ['artifactDigest','reason']){
    const f=fixture({interactionMode:'autonomous',review:r=>{
      const answer={...parseSeatReview('AGREE: no'),artifactDigest:r.artifactDigest,
        ...(r.finalDecision?{decision:'approve',reason:'Choose it'}:{})};
      if(r.finalDecision) delete answer[omission];
      return answer;
    }});
    const result=await runConversation(f.options);
    assert.equal(result.approved,false);
    assert.equal(f.writes.length,0);
  }
});
test('usage and complete transport failure details survive an unavailable reviewer',async()=>{
  const details='failure detail '.repeat(300);
  const f=fixture();
  f.options.seats.author=async()=>({...proposal(),usage:{inputTokens:10,outputTokens:5}});
  f.options.seats.reviewCodex=async()=>({unavailable:true,timedOut:true,stderr:details,
    content:'Partial delivered answer',usage:{inputTokens:7,outputTokens:3}});
  const result=await runConversation(f.options);
  assert.equal(result.approved,false);
  assert.equal(result.messages.at(-1).transport.stderr,details);
  assert.equal(result.messages.at(-1).content,'Partial delivered answer');
  assert.equal(result.checkpointState.usage.inputTokens,17);
});
test('original requirements and gate changes invalidate the artifact identity',async()=>{
  const first=fixture(),changed=fixture();
  changed.options.requirements='changed requirement bytes';
  const a=await runConversation(first.options),b=await runConversation(changed.options);
  assert.notEqual(a.approval.artifactDigest,b.approval.artifactDigest);
  const gate=fixture();
  gate.options.seats.author=async()=>({...proposal(),gate:[{bin:'node',args:['other.test.js']}]});
  const c=await runConversation(gate.options);
  assert.notEqual(a.approval.artifactDigest,c.approval.artifactDigest);
});


test('disagreeing reviewers cannot silently drop an earlier unresolved issue',async()=>{
 const f=fixture({review:(r,n)=>({...parseSeatReview(n===1?'AGREE: no\nS1 P1: Original issue':'AGREE: no\nS2 P2: New issue'),artifactDigest:r.artifactDigest})});
 const result=await runConversation(f.options);
 assert.deepEqual(result.checkpointState.openIssues.map(issue=>issue.id),['S1','S2']);
});
test('author proposal events bind the parsed artifact digest and retain full delivered content',async()=>{
 const events=[];
 const f=fixture();
 f.options.reporter=event=>events.push(event);
 const result=await runConversation(f.options);
 const authored=events.find(event=>event.stage==='plan'&&event.type==='proposal');
 assert.equal(authored.artifactDigest,result.approval.artifactDigest);
 assert.equal(authored.content,'AGREE: yes\nfirst');
});


test('a newly raised issue gets an author reply after the reviewer explicitly closes the previous issue',async()=>{
 const f=fixture({authors:[proposal(),proposal('second'),proposal('third')],review:(r,n)=>({
   ...parseSeatReview(n===1?'AGREE: no\nS1 P1: First issue':n===2?'AGREE: no\nS2 P1: Newly discovered issue':'AGREE: yes'),
   addressedIssueIds:n===2?['S1']:[],artifactDigest:r.artifactDigest,
 })});
 const result=await runConversation(f.options);
 assert.equal(result.approved,true);
 assert.equal(f.authorRequests.length,3);
});

const proposal = (plan = 'first', stance = 'yes') => ({
  plan, gate: [], content: 'AGREE: ' + stance + '\n' + plan, agree: stance === 'yes', readable: true,
});
function fixture({ authors = [proposal()], review, interactionMode = 'manual', rounds = 3 } = {}) {
  let turn = 0;
  const authorRequests = [], reviewerRequests = [], writes = [];
  return {
    authorRequests, reviewerRequests, writes,
    options: {
      tier: 'plan', runId: 'conversation-test', requirements: 'requirement bytes\n', interactionMode, rounds,
      seats: {
        author: async (request) => { authorRequests.push(request); return authors[Math.min(turn++, authors.length - 1)]; },
        reviewCodex: async (request) => {
          reviewerRequests.push(request);
          return review ? review(request, reviewerRequests.length) :
            { content: 'AGREE: yes', agree: true, readable: true, artifactDigest: request.artifactDigest };
        },
      },
      strategy: {
        draftRequest: () => ({ claudeRequest: { type: 'draft' } }),
        proposeRequest: (request) => ({ type: 'propose', ...request }),
        parseProposal: (value) => {
          if (!value || value.unavailable) throw new Error('no author artifact');
          if (value.plan === 'MALFORMED') throw new RepairableArtifactError('missing GATE_JSON');
          return { plan: value.plan, gate: value.gate };
        },
        reviewRequests: ({ proposal }) => ({ codex: { plan: proposal.plan, gate: proposal.gate } }),
        reviewRepairRequest: ({ request, content }) => ({ ...request, repairContent: content }),
        writeConverged: (value) => { writes.push(value); return { written: true }; },
      },
    },
  };
}
test('Claude revision and verbatim Codex objections reach the next turn; approval binds exact canonical bytes', async () => {
  const objection = 'AGREE: no\nS1 P1: Preserve "quotes"\nand this second line.\nQ1: Why change it?';
  const f = fixture({ authors: [proposal(), proposal('revised')], review: (r, n) =>
    ({ ...parseSeatReview(n === 1 ? objection : 'AGREE: yes'), artifactDigest: r.artifactDigest }) });
  const result = await runConversation(f.options);
  assert.equal(result.approved, true);
  assert.equal(result.converged, true);
  assert.equal(f.writes[0].plan, 'revised');
  assert.match(f.authorRequests[1].feedback, /Preserve "quotes"\nand this second line/);
  assert.equal(f.reviewerRequests[1].plan, 'revised');
  assert.ok(f.reviewerRequests[1].messages.some(m => m.content === objection));
  assert.notEqual(f.reviewerRequests[0].artifactDigest, f.reviewerRequests[1].artifactDigest);
  assert.equal(result.approval.artifactDigest,
    createHash('sha256').update('{"proposal":{"gate":[],"plan":"revised"},"requirements":"requirement bytes\\n"}').digest('hex'));
  assert.equal(result.approval.basis, 'consensus');
  assert.deepEqual(result.messages.map(m => m.speaker), ['claude', 'codex', 'claude', 'codex']);
});
test('manual dispute stops after substantive replies and preserves a serializable pending artifact', async () => {
  const f = fixture({ review: r => ({ ...parseSeatReview('AGREE: no\nS1 P1: Still unsafe'), artifactDigest: r.artifactDigest }) });
  const result = await runConversation(f.options);
  assert.equal(result.reason, 'needs-decision');
  assert.equal(result.approved, false);
  assert.equal(result.converged, false);
  assert.equal(f.writes.length, 0);
  const state = JSON.parse(JSON.stringify(result.checkpointState));
  assert.equal(state.interactionMode, 'manual');
  assert.equal(state.authority, 'human');
  assert.equal(state.proposal.plan, 'first');
  assert.equal(state.pendingDecision.artifactDigest, state.artifactDigest);
  assert.match(state.pendingDecision.question, /approve|revision/i);
  assert.equal(state.messages.length, 4);
});
test('autonomous reviewer approves retained author dissent without claiming consensus', async () => {
  const f = fixture({ interactionMode: 'autonomous', authors: [proposal('first', 'no')],
    review: r => ({ ...parseSeatReview('AGREE: no\nS1 P1: Choose current draft'), artifactDigest: r.artifactDigest,
      ...(r.finalDecision ? { decision: 'approve', reason: 'The evidence supports this approach.' } : {}) }) });
  const result = await runConversation(f.options);
  assert.equal(result.approved, true);
  assert.equal(result.converged, false);
  assert.equal(result.approval.decidedBy, 'codex');
  assert.equal(result.approval.basis, 'reviewer');
  assert.ok(result.messages.some(m => m.speaker === 'claude' && m.stance === 'disagree'));
  assert.equal(result.messages.at(-1).role, 'reviewer');
});
test('a final revision invalidates approval until Claude changes and Codex reviews the artifact', async () => {
  const f = fixture({ interactionMode: 'autonomous', authors: [proposal(), proposal(), proposal('fixed')],
    review: r => ({ ...parseSeatReview(r.plan === 'fixed' ? 'AGREE: yes' : 'AGREE: no\nS1 P1: Fix it'),
      artifactDigest: r.artifactDigest, ...(r.finalDecision ? { decision: 'revise', reason: 'Add the missing check' } : {}) }) });
  const result = await runConversation(f.options);
  assert.equal(result.approved, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].plan, 'fixed');
  assert.ok(f.authorRequests[2].messages.some(m => m.decision === 'revise'));
});
test('a stale reviewer digest cannot approve a changed artifact', async () => {
  let oldDigest;
  const f = fixture({ authors: [proposal(), proposal('revised')], review: (r,n) => {
    oldDigest ??= r.artifactDigest;
    return { ...parseSeatReview(n === 1 ? 'AGREE: no' : 'AGREE: yes'), artifactDigest: oldDigest };
  } });
  const result = await runConversation(f.options);
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'stale-review');
  assert.equal(f.writes.length, 0);
});
test('unavailable author or reviewer never becomes agreement and preserves the transport error', async () => {
  for (const speaker of ['author', 'reviewCodex']) {
    const f = fixture();
    f.options.seats[speaker] = async () => { throw new Error('quota exhausted: complete failure detail'); };
    const result = await runConversation(f.options);
    assert.equal(result.approved, false);
    assert.match(result.reason, /unavailable/);
    assert.match(JSON.stringify(result.messages), /quota exhausted: complete failure detail/);
    assert.equal(f.writes.length, 0);
  }
});
test('unreadable reviews receive one verbatim repair then remain unavailable for approval', async () => {
  const f = fixture({ review: () => 'Maybe this works\n"uncertain"' });
  const result = await runConversation(f.options);
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'stance-unreadable');
  assert.equal(f.reviewerRequests.length, 2);
  assert.equal(f.reviewerRequests[1].repairContent, 'Maybe this works\n"uncertain"');
  assert.equal(result.messages.filter(m => m.speaker === 'codex').length, 2);
});
test('malformed author artifacts are repaired without spending a deliberation round', async () => {
  const f = fixture({ authors: [proposal('MALFORMED'), proposal('fixed')], rounds: 1 });
  const result = await runConversation(f.options);
  assert.equal(result.approved, true);
  assert.equal(result.rounds, 1);
  assert.match(f.authorRequests[1].feedback, /missing GATE_JSON/);
  assert.equal(result.messages[0].content, 'AGREE: yes\nMALFORMED');
});
test('perpetual artifact repair is bounded, with no write or approval', async () => {
  const f = fixture({ authors: [proposal('MALFORMED')] });
  const result = await runConversation(f.options);
  assert.equal(result.reason, 'proposal-irreparable');
  assert.equal(result.approved, false);
  assert.equal(f.authorRequests.length, MAX_ARTIFACT_REPAIRS + 1);
  assert.equal(f.writes.length, 0);
});
test('the configured round limit cannot manufacture a final decision or approval', async () => {
  const f = fixture({ rounds: 1, interactionMode: 'autonomous',
    review: r => ({ ...parseSeatReview('AGREE: no'), artifactDigest: r.artifactDigest }) });
  const result = await runConversation(f.options);
  assert.equal(result.reason, 'rounds-exhausted');
  assert.equal(result.approved, false);
  assert.equal(f.reviewerRequests.length, 1);
});
test('a markdown-emphasized stance is a stance; prose is still silence', () => {
  // Dogfood run 2 (2026-09-02): Cursor stated AGREE: no in every round and all
  // three were read as silence, because cursor-agent wraps the marker in
  // markdown emphasis. Tolerance lives in reading only — meaning stays strict.
  const emphasized = parseSeatReview('**AGREE: no**\nS1 P0: bound the reads');
  assert.equal(emphasized.readable, true);
  assert.equal(emphasized.agree, false);
  assert.equal(emphasized.suggestions[0].id, 'S1');
  assert.equal(parseSeatReview('**AGREE:** yes').agree, true);
  assert.equal(parseSeatReview('`AGREE: yes`').agree, true);
  assert.equal(parseSeatReview('AGREE: yes').agree, true, 'plain form keeps working');
  assert.equal(parseSeatReview('I broadly agree with these tasks').readable, false,
    'prose agreement is not a stance');
  assert.equal(parseSeatReview('').readable, false);

  // Verbatim from dogfood run 3's terminal record: cursor-agent glues its
  // narration to its answer with no separator, leaving the stance behind a
  // colon mid-string. Three rounds of real stances were read as silence.
  const glued = parseSeatReview(
    'Checking the live row template one more time:AGREE: no\nS3 P0: define the omission metric precisely',
  );
  assert.equal(glued.readable, true, 'a stance glued behind narration is still a stance');
  assert.equal(glued.agree, false);
  assert.equal(glued.suggestions[0].id, 'S3');
  assert.equal(parseSeatReview('DISAGREE: yes').readable, false,
    'DISAGREE must never read as AGREE');
  const echoed = parseSeatReview(
    'AGREE: no\nRecall the contract: AGREE: yes means you are satisfied these tasks achieve the goal.',
  );
  assert.equal(echoed.agree, false,
    'the contract\'s own "AGREE: yes means" echo is not a stance');
});


test('the F20 seat answer is absence, not a parseable stance variant', () => {
  // Verbatim from the peer run at 63c788f (G-NIW1 round 2): meta-commentary
  // about the required block, block never emitted — including the missing
  // sentence boundary and the U+FFFD where an em dash was. Tolerance lives in
  // READING, so this shape must keep reading as no-stance: it is the exact
  // input the bounded re-ask exists to answer, and a parser that "helpfully"
  // found consent in it would consent on the seat's behalf.
  const f20 = [
    'Reading the goal spec, proposed tasks, and repo map to independently review this decomposition.Verifying cited seams and whether the decomposition covers the goal without gaps.Verified the cited seams (`_multi_table_sql_failure` mask, AST drop at `8256-8265`, `policy_metadata` omitting `candidate_origin`, `graph.py` forced `break` + stale `exact_compute_clarification` final override, `MODEL_ERROR_LIMIT=512` on `row["error"]`). The decomposition covers the goal; composing T9 without T4 is the main structural gap.',
    '# Seat review only',
    '',
    'Round-2 goal-decomposition review seat output only \uFFFD no implementation. Final user-visible answer is the required AGREE/S/Q block.',
    '',
    '# Round 2 decomposition review (seat output)',
    '',
    'This seat does not implement code. Independent review of [PROPOSED_TASKS.md](C:\\Users\\aiuser4\\AppData\\Local\\Temp\\uro-plan-seat-h9Az3L\\PROPOSED_TASKS.md) against [GOAL_SPEC.md](C:\\Users\\aiuser4\\AppData\\Local\\Temp\\uro-plan-seat-h9Az3L\\GOAL_SPEC.md).',
    '',
    'Evidence checked: `_multi_table_sql_failure` regex mask; AST rejection return; `policy_metadata` without `candidate_origin`; `graph.py` post-failure `break` and final `exact_compute_clarification` override; `MODEL_ERROR_LIMIT=512` on `row["error"]` vs `ERROR_CHARS=1500` in `react_context`.',
    '',
    'User-facing response for this seat is only the AGREE / S* / Q* block required by INSTRUCTIONS.md.',
  ].join('\n');
  const review = parseSeatReview(f20);
  assert.equal(review.readable, false, 'a promise of the block is not the block');
  assert.equal(review.agree, false, 'silence is never consent');
  assert.equal(review.content, f20, 'the whole answer is retained, untrimmed');
});


test('the required-structure instruction echoed back is not a stance', () => {
  // The repair paragraph and every review contract carry the literal
  // "AGREE: yes or AGREE: no". A seat prone to meta-commentary quotes the
  // instruction back instead of answering it — and under last-stance-wins that
  // echo used to land as a REAL disagreement. Reading is tolerant; it must not
  // invent a stance the seat never took.
  const echoed = parseSeatReview(
    'Understood. I will respond again in EXACTLY the required structure: AGREE: yes or AGREE: no, then the S<id> lines.',
  );
  assert.equal(echoed.readable, false, 'quoting the instruction is not answering it');
  assert.equal(echoed.agree, false, 'and it is never consent');
  assert.equal(parseSeatReview(stanceRepairLines('nothing parseable here').join('\n')).readable, false,
    'the repair paragraph itself carries no stance a seat could be credited with');

  // A real stance stated beside the echo still wins.
  const both = parseSeatReview('AGREE: yes\nThe instruction said: AGREE: yes or AGREE: no.');
  assert.equal(both.readable, true);
  assert.equal(both.agree, true);
  const objecting = parseSeatReview('The structure is AGREE: yes or AGREE: no.\nAGREE: no\nS1 P0: unresolved');
  assert.equal(objecting.readable, true);
  assert.equal(objecting.agree, false, 'a stated refusal after the echo is still a refusal');
});


test('the stance repair paragraph feeds the failure back and never re-asks for meaning', () => {
  const lines = stanceRepairLines('AGREE line? I simply never wrote one.');
  const text = lines.join('\n');
  assert.match(text, /did not contain a parseable stance/);
  assert.ok(text.includes('AGREE line? I simply never wrote one.'), 'verbatim, untrimmed');
  assert.match(text, /AGREE: yes or AGREE: no/);
  assert.match(text, /does not ask you to change what you judged/);
});
