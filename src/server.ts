import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();
app.listen(config.port, config.host ?? '::', () => {
  console.log(`sg-api listening on http://${config.host ?? 'localhost'}:${config.port}`);
});
