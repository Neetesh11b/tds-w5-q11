const crypto = require('crypto');
const { convertSpansToOtlp } = require('./trace');

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function sha256digest(obj) {
  const sorted = sortedJSON(obj);
  return crypto.createHash('sha256').update(sorted).digest('hex');
}

function sortedJSON(val) {
  if (Array.isArray(val)) return '[' + val.map(sortedJSON).join(',') + ']';
  if (val && typeof val === 'object') {
    const keys = Object.keys(val).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + sortedJSON(val[k])).join(',') + '}';
  }
  return JSON.stringify(val);
}

function handleReceipt(currentState, receiptBody) {
  const state = JSON.parse(JSON.stringify(currentState)); // deep copy
  state.receiptLog = state.receiptLog || [];
  state.actionLog = state.actionLog || [];
  state._pendingApprovals = state._pendingApprovals || {};
  state._timedOutActions = state._timedOutActions || [];

  const traceId = state._traceId;
  const agentSpanId = state._agentSpanId;
  const publicMarker = state._publicMarker || '';
  const runId = state.runId;
  const spans = state._spans || [];

  // --- Approval receipt ---
  if (receiptBody.approvals) {
    for (const appr of receiptBody.approvals) {
      const pending = state._pendingApprovals[appr.approvalId];
      if (!pending) continue;

      // Log approval receipt
      state.receiptLog.push({
        receiptId: receiptBody.receiptId,
        approvalId: appr.approvalId,
        decision: appr.decision,
        nonce: appr.nonce
      });

      if (appr.decision === 'approved') {
        // Now dispatch the effect
        const actionId = pending.actionId;
        const callId = makeId();
        const toolClientSpanId = crypto.randomBytes(8).toString('hex');
        const toolInternalSpanId = crypto.randomBytes(8).toString('hex');

        const dispatch = {
          actionId,
          callId,
          phase: "effect",
          toolName: pending.toolName,
          arguments: pending.arguments,
          evidence: [],
          attempt: 1,
          approvalId: appr.approvalId,
          approvalNonce: appr.nonce,
          traceparent: `00-${traceId}-${toolClientSpanId}-01`
        };

        state.dispatches = [dispatch];
        state.approvals = [];
        state.actionLog.push(dispatch);
        state.chosenEffect = pending.toolName;

        // Add approval_gate span
        const gateSpanId = crypto.randomBytes(8).toString('hex');
        spans.push({
          traceId, spanId: gateSpanId, parentSpanId: agentSpanId,
          name: "approval_gate", kind: 1,
          attributes: {
            "ga5.run.id": runId,
            "ga5.public.marker": publicMarker,
            "ga5.approval.id": appr.approvalId,
            "ga5.approval.nonce": appr.nonce
          }
        });

        spans.push({
          traceId, spanId: toolInternalSpanId, parentSpanId: agentSpanId,
          name: `execute_tool ${pending.toolName}`, kind: 1,
          attributes: {
            "ga5.run.id": runId,
            "ga5.public.marker": publicMarker,
            "ga5.action.id": actionId,
            "gen_ai.tool.name": pending.toolName,
            "gen_ai.tool.call.id": callId,
            "gen_ai.operation.name": "execute_tool"
          }
        });

        spans.push({
          traceId, spanId: toolClientSpanId, parentSpanId: toolInternalSpanId,
          name: `POST tool/${pending.toolName}`, kind: 3,
          attributes: {
            "ga5.run.id": runId,
            "ga5.public.marker": publicMarker,
            "ga5.action.id": actionId,
            "ga5.attempt": 1,
            "http.request.method": "POST",
            "http.request.resend_count": 0
          }
        });

        state._spans = spans;
        state.otlp = { resourceSpans: [{ scopeSpans: [{ spans: convertSpansToOtlp(spans) }] }] };
        state.status = "waiting";
        delete state._pendingApprovals[appr.approvalId];
      }
    }
    return state;
  }

  // --- Tool outcome receipts ---
  if (receiptBody.outcomes) {
    for (const outcome of receiptBody.outcomes) {
      const { actionId, callId, attempt, status, resultClass, nonce } = outcome;

      // Find matching dispatch
      const dispatchIdx = (state.dispatches || []).findIndex(
        d => d.actionId === actionId && d.attempt === attempt
      );

      if (dispatchIdx === -1) continue; // not pending, ignore
      const dispatch = state.dispatches[dispatchIdx];

      if (status === 503) {
        // One retry allowed
        const newCallId = makeId();
        const toolClientSpanId = crypto.randomBytes(8).toString('hex');

        // Log the failed attempt
        state.receiptLog.push({
          receiptId: receiptBody.receiptId,
          actionId, callId, attempt,
          status, resultClass: resultClass || 'error', nonce
        });

        // Update span for 503
        const failSpan = {
          traceId,
          spanId: dispatch.traceparent.split('-')[2],
          name: `POST tool/${dispatch.toolName}`, kind: 3,
          attributes: {
            "ga5.run.id": runId,
            "ga5.public.marker": publicMarker,
            "ga5.action.id": actionId,
            "ga5.attempt": attempt,
            "ga5.receipt.id": receiptBody.receiptId,
            "ga5.receipt.nonce": nonce,
            "http.request.method": "POST",
            "http.request.resend_count": 0,
            "http.response.status_code": 503,
            "error.type": "503"
          },
          status: { code: 2 }
        };
        spans.push(failSpan);

        // Retry dispatch
        const retryDispatch = {
          ...dispatch,
          callId: newCallId,
          attempt: attempt + 1,
          traceparent: `00-${traceId}-${toolClientSpanId}-01`
        };

        state.dispatches[dispatchIdx] = retryDispatch;
        state.actionLog.push(retryDispatch);

        // Retry CLIENT span
        spans.push({
          traceId, spanId: toolClientSpanId,
          parentSpanId: spans.find(s => s.attributes && s.attributes['ga5.action.id'] === actionId && s.kind === 1)?.spanId,
          name: `POST tool/${dispatch.toolName}`, kind: 3,
          attributes: {
            "ga5.run.id": runId,
            "ga5.public.marker": publicMarker,
            "ga5.action.id": actionId,
            "ga5.attempt": attempt + 1,
            "http.request.method": "POST",
            "http.request.resend_count": 1
          }
        });

      } else if (status === 0 && outcome.errorType === 'timeout') {
        // Timeout — suppress dependent effect
        state._timedOutActions = state._timedOutActions || [];
        state._timedOutActions.push(actionId);
        state.receiptLog.push({
          receiptId: receiptBody.receiptId,
          actionId, callId, attempt,
          status: 0, resultClass: 'timeout', nonce
        });
        state.dispatches.splice(dispatchIdx, 1);

      } else if (status === 200) {
        // Success
        state.receiptLog.push({
          receiptId: receiptBody.receiptId,
          actionId, callId, attempt,
          status, resultClass, nonce
        });

        // Update CLIENT span with receipt info
        const clientSpan = spans.find(s =>
          s.attributes && s.attributes['ga5.action.id'] === actionId &&
          s.kind === 3 && s.attributes['ga5.attempt'] === attempt
        );
        if (clientSpan) {
          clientSpan.attributes['ga5.receipt.id'] = receiptBody.receiptId;
          clientSpan.attributes['ga5.receipt.nonce'] = nonce;
          clientSpan.attributes['http.response.status_code'] = 200;
        }

        state.dispatches.splice(dispatchIdx, 1);
      }
    }

    state._spans = spans;
    state.otlp = { resourceSpans: [{ scopeSpans: [{ spans }] }] };

    // Sab diagnostics complete? — Choose effect
    const allDone = (state.dispatches || []).filter(d => d.phase === 'diagnostic').length === 0;

    if (allDone && !state.chosenEffect) {
      const timedOut = state._timedOutActions || [];
      const effectTools = state._policy?.effectTools || [];
      const approvalRequired = state._policy?.approvalRequiredFor || [];

      // Sirf non-timed-out effects choose karo
      const chosenTool = effectTools[0];

      if (chosenTool && !timedOut.includes(chosenTool)) {
        const isDestructive = approvalRequired.includes(chosenTool);

        if (isDestructive) {
          // Approval maango
          const approvalId = makeId();
          const actionId = makeId();
          const args = { service: state._service || 'unknown' };

          state._pendingApprovals[approvalId] = {
            approvalId, actionId,
            toolName: chosenTool,
            arguments: args
          };

          state.approvals = [{
            approvalId,
            actionId,
            toolName: chosenTool,
            argumentsDigest: sha256digest(args)
          }];
          state.dispatches = [];
          state.status = "waiting";

          // Approval gate span
          const gateSpanId = crypto.randomBytes(8).toString('hex');
          spans.push({
            traceId, spanId: gateSpanId, parentSpanId: agentSpanId,
            name: "approval_gate", kind: 1,
            attributes: {
              "ga5.run.id": runId,
              "ga5.public.marker": publicMarker,
              "ga5.approval.id": approvalId
            }
          });

        } else {
          // Non-destructive — seedha dispatch
          const actionId = makeId();
          const callId = actionId;
          const toolClientSpanId = crypto.randomBytes(8).toString('hex');
          const toolInternalSpanId = crypto.randomBytes(8).toString('hex');

          const effectDispatch = {
            actionId, callId,
            phase: "effect",
            toolName: chosenTool,
            arguments: { service: state._service || 'unknown' },
            evidence: [],
            attempt: 1,
            traceparent: `00-${traceId}-${toolClientSpanId}-01`
          };

          state.dispatches = [effectDispatch];
          state.actionLog.push(effectDispatch);
          state.chosenEffect = chosenTool;
          state.status = "waiting";

          spans.push({
            traceId, spanId: toolInternalSpanId, parentSpanId: agentSpanId,
            name: `execute_tool ${chosenTool}`, kind: 1,
            attributes: {
              "ga5.run.id": runId,
              "ga5.public.marker": publicMarker,
              "ga5.action.id": actionId,
              "gen_ai.tool.name": chosenTool,
              "gen_ai.tool.call.id": callId,
              "gen_ai.operation.name": "execute_tool"
            }
          });

          spans.push({
            traceId, spanId: toolClientSpanId, parentSpanId: toolInternalSpanId,
            name: `POST tool/${chosenTool}`, kind: 3,
            attributes: {
              "ga5.run.id": runId,
              "ga5.public.marker": publicMarker,
              "ga5.action.id": actionId,
              "ga5.attempt": 1,
              "http.request.method": "POST",
              "http.request.resend_count": 0
            }
          });
        }
      } else {
        // Koi effect nahi / timed out
        state.status = "completed";
        state.dispatches = [];
        state.approvals = [];
        state.suppressed = timedOut;
      }
    }

    // Effect bhi complete hua?
    const effectDone = (state.dispatches || []).filter(d => d.phase === 'effect').length === 0;
    if (allDone && effectDone && state.chosenEffect) {
      state.status = "completed";
      state.dispatches = [];
      state.approvals = [];
      state.suppressed = state._timedOutActions || [];
    }

    state._spans = spans;
    state.otlp = { resourceSpans: [{ scopeSpans: [{ spans }] }] };
    return state;
  }

  return state;
}

module.exports = { handleReceipt };