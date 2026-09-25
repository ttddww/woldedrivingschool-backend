const config = require('./config');
const app = require('./app');

app.listen(config.port, () => {
  console.log(`Wolde Driving School API listening on ${config.backendUrl}`);
});
