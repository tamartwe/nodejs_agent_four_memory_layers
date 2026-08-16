const pendingToolCalls = new Map();

function log(message) {
  console.log(message);
}

function createFakeToolCall({ callId, workflowId, toolName }) {
  let complete;
  const promise = new Promise((resolve) => {
    complete = () => resolve({
      callId,
      workflowId,
      toolName,
      result: 'flight F-17 reserved for approval',
    });
  });

  return { promise, complete };
}

function handleRequest() {
  const workflowId = 'workflow-42';
  const callId = 'call-001';
  const toolName = 'reserveFlight';

  log('1. request started');
  log(`2. tool call submitted: ${toolName} (${callId})`);

  const toolCall = createFakeToolCall({ callId, workflowId, toolName });

  pendingToolCalls.set(callId, {
    workflowId,
    toolName,
    promise: toolCall.promise,
  });

  log('3. pending promise stored in memory Map');
  log('4. response returned: 202 Accepted - tool call is still running');
  log('5. request ended');

  return toolCall;
}

async function runDemo() {
  console.log('\nBEFORE: in-memory promise owns the tool call\n');

  const toolCall = handleRequest();

  log('\n6. process restarted: in-memory Map was cleared');
  pendingToolCalls.clear();
  log(`   pendingToolCalls.size = ${pendingToolCalls.size}`);

  log('\n7. fake tool completes after the request is gone');
  const completed = toolCall.complete();
  const result = await toolCall.promise;
  void completed;

  log(`   tool completed: ${result.callId} -> ${result.result}`);

  log('\n8. lookup owner in memory');
  const owner = pendingToolCalls.get(result.callId);
  if (!owner) {
    log('   LOST: result has no owner because the promise lived only in memory');
    log('   cannot resume workflow-42 after restart');
  }
}

await runDemo();
