const crypto = require('crypto');

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

async function callGroq(messages) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages,
      temperature: 0
    })
  });
  const data = await response.json();
  const text = data.choices[0].message.content;
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function runPlanner(safeBody) {
  const { runId, incident, toolCatalog, publicMarker, policy } = safeBody;

  // Parse traceparent if present
  let traceId = crypto.randomBytes(16).toString('hex');
  let parentSpanId = null;
  if (safeBody.traceparent) {
    const parts = safeBody.traceparent.split('-');
    if (parts.length === 4 && parts[0] === '00') {
      traceId = parts[1];
      parentSpanId = parts[2];
    }
  }

  // Step 1 — AI se diagnosis + tool selection ek saath
  const toolList = toolCatalog.map(t =>
    `- ${t.name}: ${t.description} | schema: ${JSON.stringify(t.inputSchema)}`
  ).join('\n');

  const diagPrompt = `You are an incident diagnosis assistant. Return ONLY valid JSON, no markdown.

Incident: ${incident.title}
Service: ${incident.service}
Severity: ${incident.severity}

Evidence transcript (each line tagged [ev_XXX]):
${incident.transcript}

Allowed root causes (pick exactly ONE): ${incident.allowedRootCauses.join(', ')}

Available diagnostic tools (maximumDiagnostics: ${policy.maximumDiagnostics}):
${toolList}

Effect tools available after diagnosis: ${(policy.effectTools || []).join(', ')}

Rules:
1. Pick exactly one rootCause from the allowed list
2. Cite 2 to 4 evidence IDs that justify it (no duplicates)
3. Pick only the diagnostic tools actually needed to confirm this root cause (1 to ${policy.maximumDiagnostics})
4. For each tool, provide exact incident-specific arguments based on the evidence (not generic placeholders)
5. Each tool must cite at least one evidence ID from your diagnosis evidence

Return this exact JSON shape:
{
  "rootCause": "one_allowed_value",
  "evidence": ["ev_001", "ev_002"],
  "diagnosticTools": [
    {
      "toolName": "exact_tool_name",
      "arguments": { "key": "incident-specific-value" },
      "evidence": ["ev_001"]
    }
  ]
}`;

  const plan = await callGroq([{ role: 'user', content: diagPrompt }]);

  const diagnosis = {
    rootCause: plan.rootCause,
    evidence: plan.evidence
  };

  // Step 2 — Spans banao
  const serverSpanId = crypto.randomBytes(8).toString('hex');
  const agentSpanId = crypto.randomBytes(8).toString('hex');
  const chatSpanId = crypto.randomBytes(8).toString('hex');

  const spans = [
    {
      traceId, spanId: serverSpanId,
      parentSpanId: parentSpanId || undefined,
      name: "POST /v2/incidents", kind: 2,
      attributes: { "ga5.run.id": runId, "ga5.public.marker": publicMarker }
    },
    {
      traceId, spanId: agentSpanId, parentSpanId: serverSpanId,
      name: "invoke_agent incident-response", kind: 1,
      attributes: { "ga5.run.id": runId, "ga5.public.marker": publicMarker }
    },
    {
      traceId, spanId: chatSpanId, parentSpanId: agentSpanId,
      name: "chat incident-plan", kind: 3,
      attributes: {
        "ga5.run.id": runId,
        "ga5.public.marker": publicMarker,
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "llama-3.1-8b-instant"
      }
    }
  ];

  // Step 3 — Dispatches + spans per tool
  const dispatches = [];
  const executeToolSpanIds = []; // join ke liye

  for (const tool of plan.diagnosticTools) {
    const actionId = makeId();
    const callId = actionId;
    const toolInternalSpanId = crypto.randomBytes(8).toString('hex');
    const toolClientSpanId = crypto.randomBytes(8).toString('hex');

    executeToolSpanIds.push(toolInternalSpanId);

    dispatches.push({
      actionId,
      callId,
      phase: "diagnostic",
      toolName: tool.toolName,
      arguments: tool.arguments,
      evidence: tool.evidence,
      attempt: 1,
      traceparent: `00-${traceId}-${toolClientSpanId}-01`
    });

    spans.push({
      traceId, spanId: toolInternalSpanId, parentSpanId: agentSpanId,
      name: `execute_tool ${tool.toolName}`, kind: 1,
      attributes: {
        "ga5.run.id": runId,
        "ga5.public.marker": publicMarker,
        "ga5.action.id": actionId,
        "gen_ai.tool.name": tool.toolName,
        "gen_ai.tool.call.id": callId,
        "gen_ai.operation.name": "execute_tool"
      }
    });

    spans.push({
      traceId, spanId: toolClientSpanId, parentSpanId: toolInternalSpanId,
      name: `POST tool/${tool.toolName}`, kind: 3,
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

  // Step 4 — Join span (agar 2+ diagnostic tools parallel hain)
  if (dispatches.length > 1) {
    const joinSpanId = crypto.randomBytes(8).toString('hex');
    spans.push({
      traceId, spanId: joinSpanId, parentSpanId: agentSpanId,
      name: "incident.join", kind: 1,
      attributes: { "ga5.run.id": runId, "ga5.public.marker": publicMarker },
      links: executeToolSpanIds.map(sid => ({ traceId, spanId: sid }))
    });
  }

  return {
    runId,
    status: "waiting",
    diagnosis,
    dispatches,
    approvals: [],
    actionLog: [],
    receiptLog: [],
    otlp: { resourceSpans: [{ scopeSpans: [{ spans }] }] },
    _traceId: traceId,
    _agentSpanId: agentSpanId,
    _spans: spans
  };
}

module.exports = { runPlanner };