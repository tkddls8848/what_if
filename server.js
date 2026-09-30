"use strict";
const path = require('path');
const express = require('express');
const { loadEnvFile } = require('./src/server/env');
loadEnvFile(path.join(__dirname, '.env'));
const { getSettings } = require('./src/server/settings');
const app = express();
app.use(express.json({ limit: '2mb' }));
require('./src/server/routes/pages')(app);
require('./src/server/routes/analysis')(app);
require('./src/server/routes/worlds')(app);
require('./src/server/routes/play')(app);

if (require.main === module) {
  const port = getSettings().PORT;
  app.listen(port, '127.0.0.1', () => console.log('Novel IF  http://localhost:' + port));
}
module.exports = { app };
