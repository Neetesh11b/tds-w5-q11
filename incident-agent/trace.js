function makeSpan({ traceId, spanId, parentSpanId, name, kind, attributes, status }) {
  return {
    traceId, spanId, parentSpanId, name,
    kind, // 1=INTERNAL, 2=SERVER, 3=CLIENT
    attributes,
    status
  };
}