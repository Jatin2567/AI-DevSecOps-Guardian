// backend/server.js
const express = require('express');
const bodyParser = require('body-parser');
const webhookRoutes = require('./src/routes/webhook');
const apiRoutes = require('./src/routes/api');
const app = express();
app.use(bodyParser.json({ limit: '5mb' }));

app.use('/webhook', webhookRoutes);
app.use('/api', apiRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Assistant backend listening on ${port}`));
