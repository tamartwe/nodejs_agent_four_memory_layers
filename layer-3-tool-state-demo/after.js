import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LEDGER_PATH = join(process.cwd(), 'tool-state.json');

function log(message) {
  console.log(message);
}

function now() {
  return new Date('2026-09-15T10:00:00.000Z').toISOString();
}

function readLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  return JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
}

function writeLedger(records) {
  writeFileSync(LEDGER_PATH, `${JSON.stringify(records, null, 2)}\n`);
}

function upsertRecord(record) {
  const records = readLedger();
  const index = records.findIndex((item) => item.callId === record.callId);
  if (index === -1) {
    records.push(record);
  } else {
    records[index] = { ...records[index], ...record, updatedAt: now() };
  }
  writeLedger(records);
}

function createExecutionRecord() {
  const callId = 'call-001';
  const workflowId = 'workflow-42';
  const toolName = 'reserveFlight';

  return {
    callId,
    workflowId,
    toolName,
    status: 'running',
    attempt: 1,
    idempotencyKey: `${workflowId}:${toolName}:F-17`,
    resultRef: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

function handleRequest() {
  log('1. request started');
  const record = createExecutionRecord();

  log(`2. tool call submitted: ${record.toolName} (${record.callId})`);
  upsertRecord(record);
  log('3. durable execution record written to tool-state.json');

  log('4. response returned: 202 Accepted - tool call is still running');
  log('5. request ended');

  return record.callId;
}

function completeTool(callId) {
  const record = readLedger().find((item) => item.callId === callId);
  if (!record) throw new Error(`cannot complete unknown call ${callId}`);

  const resultRef = `results/${callId}.json`;
  upsertRecord({
    ...record,
    status: 'completed',
    resultRef,
    updatedAt: now(),
  });

  return resultRef;
}

function resumeWorker() {
  log('\n8. new worker starts and reads tool-state.json');
  const records = readLedger();
  const resumable = records.filter((record) => record.status === 'completed');

  resumable.forEach((record) => {
    log(`   resume ${record.workflowId}: ${record.toolName} completed`);
    log(`   callId=${record.callId}`);
    log(`   resultRef=${record.resultRef}`);
    log(`   idempotencyKey=${record.idempotencyKey}`);
  });
}

async function runDemo() {
  console.log('\nAFTER: durable execution record owns the tool call\n');

  if (existsSync(LEDGER_PATH)) rmSync(LEDGER_PATH);

  const callId = handleRequest();

  log('\n6. process restarted: memory is gone, JSON ledger remains');
  log(`   ledger records = ${readLedger().length}`);

  log('\n7. fake tool completes after the request is gone');
  const resultRef = completeTool(callId);
  log(`   tool completed: ${callId} -> ${resultRef}`);

  resumeWorker();

  log('\n9. workflow can continue because ownership is durable');
}

await runDemo();
