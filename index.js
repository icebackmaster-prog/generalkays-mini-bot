const express = require('express');
const app = express();
const path = require('path');
const bodyParser = require('body-parser');
require('dotenv').config();
const PORT = process.env.PORT || 8000;
let code = require('./pair');

require('events').EventEmitter.defaultMaxListeners = 500;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Bot pairing API
app.use('/code', code);

// /pair redirects to main page (pair.html was removed; main.html has the pairing UI)
app.use('/pair', (req, res) => {
    res.redirect('/');
});

// Main pairing UI
app.use('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'main.html'));
});

// 404 fallback
app.use((req, res) => {
    res.status(404).send({ error: 'Not found' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
Don't Forget To Give Star ‼️

Powered by General kays tech 

Server running on http://0.0.0.0:${PORT}`);
});

module.exports = app;
