function toOtlpAttrs(obj) {
  return Object.entries(obj).map(([key, value]) => {
    if (typeof value === 'number') {
      return { key, value: { intValue: value } };
    }
    return { key, value: { stringValue: String(value) } };
  });
}

function convertSpansToOtlp(spans) {
  return spans.map(span => {
    const s = {
      traceId: span.traceId,
      spanId: span.spanId,
      name: span.name,
      kind: span.kind,
      attributes: toOtlpAttrs(span.attributes || {}),
      status: span.status || { code: 0 }
    };
    if (span.parentSpanId) s.parentSpanId = span.parentSpanId;
    if (span.links) {
      s.links = span.links.map(l => ({
        traceId: l.traceId,
        spanId: l.spanId
      }));
    }
    return s;
  });
}

module.exports = { toOtlpAttrs, convertSpansToOtlp };