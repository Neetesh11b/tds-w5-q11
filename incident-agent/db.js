const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'store.json');

function loadStore() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ runs: {}, receipts: {} }));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

module.exports = {
  getRun(runId) {
    const store = loadStore();
    return store.runs[runId] || null;
  },
  saveRun(runId, requestHash, state) {
    const store = loadStore();
    store.runs[runId] = { requestHash, state };
    saveStore(store);
  },
  updateRun(runId, state) {
    const store = loadStore();
    store.runs[runId].state = state;
    saveStore(store);
  },
  getReceipt(receiptId) {
    const store = loadStore();
    return store.receipts[receiptId] || null;
  },
  saveReceipt(receiptId, runId, contentHash, response) {
    const store = loadStore();
    store.receipts[receiptId] = { runId, contentHash, response };
    saveStore(store);
  }
};