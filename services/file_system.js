const fs = require('fs');

const { rpc, rpc_process } = require('carlo/rpc');
const chokidar = require('chokidar');

class FileSystemHandler {
  constructor() {
    require('../lib/process_utility.js')('file_system', () => this.dispose());
    this._watcher = null;
    this._embedderPath = '';
    this._client = null;
  }

  startWatcher(embedderPath, exludePattern, client, mainFileName) {
    this._embedderPath = embedderPath;
    this._client = client;
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

  forceFileLoad(fileName) {
    if (fileName.startsWith(this._embedderPath) && fs.existsSync(fileName))
      this._client.filesChanged([{type: 'add', name: fileName}]);
  }

  dispose() {
    this._watcher.close();
    Promise.resolve().then(() => process.exit(0));
  }
}

rpc_process.init(args => rpc.handle(new FileSystemHandler()));
