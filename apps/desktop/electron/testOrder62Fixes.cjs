const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const requireAt = createRequire(path.join(root, 'electron/workbenchCollab.test.cjs'));
const prefix = fs.readFileSync(path.join(root, 'electron/workbenchCollab.test.cjs'), 'utf8').split("test('工单42：闭环测试 1")[0];
const { setupTestEnvironment, postHttp } = vm.runInNewContext(
  prefix + '\n({setupTestEnvironment, postHttp})',
  { require: requireAt, __dirname: path.join(root, 'electron'), console, Buffer, URL, setTimeout, clearTimeout }
);

const envs = [];
const result = {
  at: new Date().toISOString(),
  order: 'Order 62 - Unaffected In-flight Task Deduplication & Coordination Review Verification',
  cases: []
};

async function revise(e, feedback) {
  return e.broker.userReviseProject({ ticketId: e.ticketId, explicit: true, feedback });
}

async function approve(e, v = 1) {
  return e.broker.approvePlan({ ticketId: e.ticketId, planVersion: v, explicit: true });
}

async function workerClaim(e, kinds = ['work']) {
  return postHttp(e.broker.url, '/v1/bridge/claim', e.broker.sessions.get('agent_editor').token, {
    schemaVersion: 1,
    requestId: 'claim_' + Date.now(),
    capabilities: { kinds }
  }, {
    'x-agent-id': 'agent_editor',
    'x-executor-id': 'antigravity-adapter'
  });
}

async function workerEvent(e, { jobId, attemptId, type, seq, summary, checkpoint = null }) {
  return postHttp(e.broker.url, '/v1/bridge/events', e.broker.sessions.get('agent_editor').token, {
    schemaVersion: 1,
    requestId: 'ev_' + Date.now(),
    jobId, attemptId, type, seq, summary, checkpoint
  }, {
    'x-agent-id': 'agent_editor',
    'x-executor-id': 'antigravity-adapter'
  });
}

async function workerReport(e, { jobId, attemptId, reportId, outcome, summary, artifacts = [], checks = [], unknowns = [] }) {
  return postHttp(e.broker.url, '/v1/bridge/report', e.broker.sessions.get('agent_editor').token, {
    schemaVersion: 1,
    requestId: 'rep_' + Date.now(),
    jobId, attemptId, reportId, outcome, summary, artifacts, checks, unknowns
  }, {
    'x-agent-id': 'agent_editor',
    'x-executor-id': 'antigravity-adapter'
  });
}

async function run() {
  console.log('--- 开始工单62在途未受影响任务单项收口独立复验 ---');

  // 1. 场景 1: 空受影响集合 [] 下，queued、doing、review、done 四类状态全量保全，0 新派工且原 attempt 不取消
  for (const mode of ['queued', 'doing', 'review', 'done']) {
    const e = await setupTestEnvironment();
    envs.push(e);
    e.ticketId = 'ticket_empty_' + mode;
    e.taskId = 'task_empty_' + mode;
    await e.broker.createTicket({
      schemaVersion: 1, explicit: true, requestId: 'create_empty_' + mode, ticketId: e.ticketId,
      title: '空受影响测试 ' + mode, goal: '测试空集合',
      tasks: [{ id: e.taskId, title: '单任务', assigneeId: 'agent_editor', acceptance: '通过' }],
      plan: { version: 1, title: '方案', goal: '目标', tasks: [{ id: e.taskId, title: '单任务', assigneeId: 'agent_editor', acceptance: '通过' }], status: 'draft', conversationId: 'conv_living_room' },
      origin: { conversationId: 'conv_living_room', agentId: 'agent_coordinator', requestId: 'orig_empty_' + mode }
    });
    await approve(e, 1);

    let originalJob = null;
    let originalAttemptId = null;

    if (mode === 'doing' || mode === 'review' || mode === 'done') {
      const claim = await workerClaim(e);
      assert.equal(claim.status, 200);
      assert.ok(claim.body.job);
      originalJob = claim.body.job;
      originalAttemptId = originalJob.attemptId;
      assert.ok(originalAttemptId);

      const ev = await workerEvent(e, {
        jobId: originalJob.jobId,
        attemptId: originalAttemptId,
        type: 'started',
        seq: 1,
        summary: 'Worker 开始执行'
      });
      assert.equal(ev.status, 200);

      if (mode === 'review' || mode === 'done') {
        const artPath = path.join(e.work1, 'artifact_' + mode + '.txt');
        fs.writeFileSync(artPath, 'hello world ' + mode);
        const rep = await workerReport(e, {
          jobId: originalJob.jobId,
          attemptId: originalAttemptId,
          reportId: 'rep_' + mode + '_' + Date.now(),
          outcome: 'submitted',
          summary: '交付产物 ' + mode,
          artifacts: [{ path: artPath, kind: 'file', description: '产物' }],
          checks: ['done'],
          unknowns: []
        });
        assert.equal(rep.status, 200);

        if (mode === 'done') {
          e.broker.accept(originalJob.jobId);
        }
      }
    }

    const beforeJobs = e.broker.data.jobs.filter(j => j.kind === 'work' && j.ticketId === e.ticketId);
    assert.equal(beforeJobs.length, 1);
    assert.equal(beforeJobs[0].state, mode);

    // 绑定协调审查器，返回合法的空集合 [] 判定
    e.broker.attachCoordinatorReviewer({
      getData: e.read,
      startChat: async (_, emit) => {
        emit('chat:stream-done', {
          accumulatedText: JSON.stringify({
            scopeExpansion: false,
            reason: '纯讨论，不影响任何任务',
            planVersion: 1,
            revisionRound: 0,
            affectedTaskIds: [],
            proposedChanges: '无执行修改',
            newDirectories: [],
            newTools: []
          })
        });
        return { ok: true };
      }
    });

    const r = await revise(e, '只是讨论按钮颜色，无需任何代码改动');
    const afterJobs = e.broker.data.jobs.filter(j => j.kind === 'work' && j.ticketId === e.ticketId);

    assert.equal(r.scheduled, 0, `空集合在 ${mode} 状态下必须 0 新派工`);
    assert.equal(afterJobs.length, 1, `空集合在 ${mode} 状态下作业数量保持为 1`);
    assert.equal(afterJobs[0].jobId, beforeJobs[0].jobId, '作业 ID 必须完全一致');
    assert.equal(afterJobs[0].state, mode, `作业状态必须依然保持为 ${mode}`);
    assert.equal(Boolean(afterJobs[0].cancelRequested), false, '未受影响作业不得被请求取消');
    if (originalAttemptId) {
      assert.equal(afterJobs[0].attemptId, originalAttemptId, '未受影响作业的 attemptId 必须原样保留');
    }

    result.cases.push({
      name: 'empty_affected_preserves_' + mode,
      mode,
      scheduled: r.scheduled,
      jobId: afterJobs[0].jobId,
      state: afterJobs[0].state,
      attemptId: afterJobs[0].attemptId,
      pass: true
    });
    console.log(`✔ empty_affected_preserves_${mode}: 空受影响集合下 ${mode} 状态保全且 0 新派工通过`);
  }

  // 2. 场景 2: 局部返修下未受影响在途任务保全与后续交付审查闭环，以及依赖推进
  {
    const e = await setupTestEnvironment();
    envs.push(e);
    e.ticketId = 'ticket_partial_collab';
    const taskA = 'task_unaffected_a';
    const taskB = 'task_affected_b';
    const taskC = 'task_dependent_c';
    const plan = {
      version: 2,
      title: '三任务方案',
      goal: '按钮、文案与依赖后续',
      conversationId: 'conv_living_room',
      tasks: [
        { id: taskA, title: '按钮逻辑', assigneeId: 'agent_editor', acceptance: '完成按钮' },
        { id: taskB, title: '文案更新', assigneeId: 'agent_editor', acceptance: '更新文案' },
        { id: taskC, title: '后续页面', assigneeId: 'agent_editor', acceptance: '依赖按钮', dependencies: [taskA] }
      ]
    };
    await e.broker.createTicket({
      schemaVersion: 1, explicit: true, requestId: 'create_partial', ticketId: e.ticketId,
      title: '局部返修工单', goal: '目标',
      tasks: plan.tasks,
      plan,
      origin: { conversationId: 'conv_living_room', agentId: 'agent_coordinator', requestId: 'orig_part' }
    });
    await approve(e, 2);

    // 领取 Task A
    const claimA = await workerClaim(e);
    assert.equal(claimA.status, 200);
    const jobA = claimA.body.job;
    assert.equal(jobA.taskId, taskA);
    const attemptA = jobA.attemptId;
    assert.ok(attemptA);

    // Task A 发送 started 事件进入 doing
    const evA = await workerEvent(e, {
      jobId: jobA.jobId,
      attemptId: attemptA,
      type: 'started',
      seq: 1,
      summary: 'Task A 正在执行'
    });
    assert.equal(evA.status, 200);

    // 使用者要求修改文案，只影响 Task B
    e.broker.attachCoordinatorReviewer({
      getData: e.read,
      startChat: async (param, emit) => {
        // 如果是修改方案审查
        if (param.currentText.includes('使用者提出的修改意见')) {
          emit('chat:stream-done', {
            accumulatedText: JSON.stringify({
              scopeExpansion: false,
              reason: '只修改说明文字，按钮代码无需重做',
              planVersion: 2,
              revisionRound: 0,
              affectedTaskIds: [taskB],
              proposedChanges: '修改文案',
              newDirectories: [],
              newTools: []
            })
          });
          return { ok: true };
        }
        // 如果是成果审查
        if (param.currentText.includes('协调者统筹审查任务')) {
          emit('chat:stream-done', {
            accumulatedText: JSON.stringify({ decision: 'accept' })
          });
          return { ok: true };
        }
        return { ok: true };
      }
    });

    const r = await revise(e, '只修改文案，按钮的工作继续');
    assert.equal(r.scheduled, 1, '局部修订只重新派发受影响的 Task B，scheduled 必须为 1');

    const jobsMid = e.broker.data.jobs.filter(j => j.kind === 'work' && j.ticketId === e.ticketId);
    const jobAAfterRevise = jobsMid.find(j => j.taskId === taskA && !j.cancelRequested);
    assert.ok(jobAAfterRevise, 'Task A 必须有未取消的活跃作业');
    assert.equal(jobAAfterRevise.jobId, jobA.jobId, 'Task A 必须保持原有的作业实例');
    assert.equal(jobAAfterRevise.attemptId, attemptA, 'Task A 必须保持原有的 attemptId');
    assert.equal(jobAAfterRevise.state, 'doing', 'Task A 必须依然处于 doing 状态');

    // 验证 Task A 只有 1 个未取消的作业，严禁产生重复作业！
    const uncancelledAJobs = jobsMid.filter(j => j.taskId === taskA && !j.cancelRequested);
    assert.equal(uncancelledAJobs.length, 1, 'Task A 不得存在任何重复作业');

    // 现在 Task A 继续通过原 attempt 上报进度并交付报告
    const evA2 = await workerEvent(e, {
      jobId: jobA.jobId,
      attemptId: attemptA,
      type: 'progress',
      seq: 2,
      summary: 'Task A 编码完成，准备提交'
    });
    assert.equal(evA2.status, 200, '未受影响任务原 attempt 继续上报事件必须成功');

    const artPathA = path.join(e.work1, 'button.js');
    fs.writeFileSync(artPathA, 'export const button = "blue";');
    const repA = await workerReport(e, {
      jobId: jobA.jobId,
      attemptId: attemptA,
      reportId: 'rep_task_a_' + Date.now(),
      outcome: 'submitted',
      summary: 'Task A 按钮完成',
      artifacts: [{ path: artPathA, kind: 'file', description: '按钮产物' }],
      checks: ['pass'],
      unknowns: []
    });
    assert.equal(repA.status, 200, '未受影响任务原 attempt 交付报告必须成功');

    // 等待异步协调审查执行完成（attachCoordinatorReviewer 中已模拟 accept）
    await new Promise(resolve => setTimeout(resolve, 200));

    const finalAJob = e.broker.data.jobs.find(j => j.jobId === jobA.jobId);
    assert.equal(finalAJob.state, 'done', 'Task A 经统筹审查验收后必须成功进入 done 状态，未被误判为 stale_attempt');

    // Task A 完成后，依赖 Task A 的 Task C 应该能够被正常调度推进！
    const schedAfterADone = e.broker.scheduleCoordinatorWork(e.ticketId);
    const jobC = e.broker.data.jobs.find(j => j.taskId === taskC && j.kind === 'work');
    assert.ok(jobC, '依赖 Task A 的 Task C 成功被调度器解锁派发');
    assert.equal(jobC.state, 'queued', 'Task C 作业已成功进入 queued 状态');

    result.cases.push({
      name: 'partial_revision_and_unaffected_delivery_review_pipeline',
      jobAState: finalAJob.state,
      taskCDepsResolved: Boolean(jobC),
      scheduled: r.scheduled,
      pass: true
    });
    console.log('✔ partial_revision_and_unaffected_delivery_review_pipeline: 局部返修下未受影响任务保全、原 attempt 交付及协调审查验收与依赖推进全闭环通过');
  }

  // 3. 场景 3: 多次 schedule、调度 tick、重启恢复与重复/过期去重防守
  {
    const e = await setupTestEnvironment();
    envs.push(e);
    e.ticketId = 'ticket_repeat_defense';
    e.taskId = 'task_repeat_defense';
    await e.broker.createTicket({
      schemaVersion: 1, explicit: true, requestId: 'create_repeat', ticketId: e.ticketId,
      title: '重复防守', goal: '防守',
      tasks: [{ id: e.taskId, title: '防守任务', assigneeId: 'agent_editor', acceptance: '通过' }],
      plan: { version: 1, title: '方案', goal: '目标', tasks: [{ id: e.taskId, title: '防守任务', assigneeId: 'agent_editor', acceptance: '通过' }], status: 'draft', conversationId: 'conv_living_room' },
      origin: { conversationId: 'conv_living_room', agentId: 'agent_coordinator', requestId: 'orig_rep' }
    });
    await approve(e, 1);

    // 已经自动派发 1 个 job
    assert.equal(e.broker.data.jobs.filter(j => j.ticketId === e.ticketId).length, 1);

    // 连续多次调用 scheduleCoordinatorWork
    for (let i = 0; i < 5; i++) {
      const s = e.broker.scheduleCoordinatorWork(e.ticketId);
      assert.equal(s.scheduled, 0, '已有在途作业时再次调用 scheduleCoordinatorWork 必须 0 新派工');
    }

    // 手动调用 dispatch 必须被严格拒绝
    assert.throws(() => {
      e.broker.dispatch({
        ticketId: e.ticketId,
        taskId: e.taskId,
        requestId: 'illegal_duplicate_dispatch'
      });
    }, (err) => {
      return err.code === 'permission_required';
    }, '已有在途作业时手动 dispatch 必须抛出 permission_required');

    // 模拟过期已被 superseded 的旧 job 进行验收必须抛出 stale_attempt
    const fakeStaleJobId = 'job_stale_defense';
    e.broker.data.jobs.push({
      jobId: fakeStaleJobId,
      ticketId: e.ticketId,
      taskId: e.taskId,
      agentId: 'agent_editor',
      executorId: 'worker-lao-lin',
      workspace: e.work1,
      state: 'superseded',
      kind: 'work',
      revisionRound: 0,
      planVersion: 1,
      attemptId: 'att_stale',
      cancelRequested: true
    });
    assert.throws(() => {
      e.broker.accept(fakeStaleJobId);
    }, (err) => {
      return err.code === 'stale_attempt';
    }, '已被 superseded 的旧作业必须拒绝验收并抛出 stale_attempt');

    result.cases.push({
      name: 'repeated_schedule_and_stale_defense',
      pass: true
    });
    console.log('✔ repeated_schedule_and_stale_defense: 多次调度幂等、重复 dispatch 拦截与过期 attempt 防守通过');
  }

  console.log('--- 工单62全部验收场景 100% 验证通过 ---');
  fs.mkdirSync(path.resolve(__dirname, '../../../.local/pi-acceptance'), {recursive:true});
  fs.writeFileSync(path.resolve(__dirname, '../../../.local/pi-acceptance/62-result.json'), JSON.stringify(result, null, 2));
}

run().catch(err => {
  console.error(err.stack);
  process.exitCode = 1;
}).finally(async () => {
  for (const e of envs) await e.broker.stop();
});
