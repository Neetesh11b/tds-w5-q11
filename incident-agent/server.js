require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { runPlanner } = require('./planner');
const { handleReceipt } = require('./stateMachine');

const app = express();
app.use(express.json({ limit: '5mb' }));

function hashBody(body) {
    return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

app.post('/v2/incidents', async (req, res) => {
    const { runId, profile } = req.body;
    if (profile !== 'ga5-incident-agent/v2') return res.status(400).json({ error: 'bad profile' });

    const bodyHash = hashBody(req.body);
    const existing = db.getRun(runId);

    if (existing) {
        if (existing.requestHash !== bodyHash) return res.status(409).json({ error: 'conflict' });
        return res.json(existing.state);
    }

    const { sensitive, ...safeForModel } = req.body;
    const result = await runPlanner(safeForModel);
    result._policy = req.body.policy;
    result._service = req.body.incident?.service;
    result._publicMarker = req.body.publicMarker;
    db.saveRun(runId, bodyHash, result);
    res.json(result);
});

app.post('/v2/incidents/:runId/receipts', (req, res) => {
    const { runId } = req.params;
    const receiptId = req.body.receiptId;
    const bodyHash = hashBody(req.body);

    const existingReceipt = db.getReceipt(receiptId);
    if (existingReceipt) {
        if (existingReceipt.contentHash !== bodyHash) return res.status(409).json({ error: 'conflict' });
        return res.json(existingReceipt.response);
    }

    const run = db.getRun(runId);
    if (!run) return res.status(404).json({ error: 'not found' });

    const updatedResult = handleReceipt(run.state, req.body);

    db.updateRun(runId, updatedResult);
    db.saveReceipt(receiptId, runId, bodyHash, updatedResult);

    res.json(updatedResult);
});

app.get('/v2/incidents/:runId', (req, res) => {
    const run = db.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run.state);
});

app.listen(process.env.PORT || 3000, () => console.log('running on port 3000'));