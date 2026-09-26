const config = require('./config');
const app = require('./app');

app.locals.dbReady
  .then(() => {
    app.listen(config.port, () => {
      console.log(`Wolde Driving School API listening on ${config.backendUrl}`);
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
