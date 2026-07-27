function handleReceipt(currentState, receiptBody) {
  const updated = { ...currentState };
  updated.receiptLog = updated.receiptLog || [];

  if (receiptBody.outcomes) {
    receiptBody.outcomes.forEach(o => {
      updated.receiptLog.push({
        receiptId: receiptBody.receiptId,
        actionId: o.actionId,
        callId: o.callId,
        attempt: o.attempt,
        status: o.status,
        resultClass: o.resultClass,
        nonce: o.nonce
      });
    });
  }

  updated.status = "completed";
  updated.actionLog = updated.dispatches || [];
  return updated;
}

module.exports = { handleReceipt };