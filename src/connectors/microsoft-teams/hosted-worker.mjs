// Runs with a minimal environment and filesystem permissions; never gets host
// model keys, service credentials, identity tokens or OAuth material.
import { pathToFileURL } from 'node:url';

process.once('message', async ({ modulePath, operation, args, connectionId }) => {
  let reply;
  try {
    const module = await import(pathToFileURL(modulePath).href);
    const connection = Object.freeze({ config: Object.freeze({ auth_mode: 'oauth2', connection_id: connectionId }),
      execute(name, input) {
        if (name !== operation) throw new Error('Operation denied');
        return new Promise((resolve, reject) => {
          process.once('message', result => result.error ? reject(new Error('Provider operation failed')) : resolve(result.result));
          process.send({ type: 'invoke', operation: name, args: input });
        });
      } });
    reply = await module.call(args, { connection });
    process.send({ type: 'result', result: reply });
  } catch { process.send({ type: 'result', error: 'ADO tool failed. Check connection and approval status.' }); }
});
