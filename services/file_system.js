const { rpc, rpc_process } = require('carlo/rpc');
const chokidar = require('chokidar');

class FileSystemHandler {
  constructor() {
    require('../lib/process_utility.js')('file_system', () => this.dispose());
    this._watcher = null;
  }

  startWatcher(embedderPath, exludePattern, client) {
    this._watcher = chokidar.watch([embedderPath], {
      ignored: new RegExp(exludePattern),
      awaitWriteFinish: true,
      ignorePermissionErrors: true
    });
    const events = [];
    this._watcher.on('all', (event, name) => {
      if (event === 'add' || event === 'change' || event === 'unlink') {
        if (!events.length)
          setTimeout(() => client.filesChanged(events.splice(0)), 100);
        events.push({
          type: event,
          name: name
        });
      }
    });
    this._watcher.on('error', console.error);
  }

  dispose() {
    this._watcher.close();
    Promise.resolve().then(() => process.exit(0));
  }
}

rpc_process.init(args => rpc.handle(new FileSystemHandler()));
