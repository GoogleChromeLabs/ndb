/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const {spawn} = require('child_process');
const chokidar = require('chokidar');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const {ServiceBase} = require('./service_base.js');

const NDB_VERSION = require('../package.json').version;

const fsMkdtemp = util.promisify(fs.mkdtemp);
const fsReadFile = util.promisify(fs.readFile);
const removeFolder = util.promisify(require('rimraf'));

class NddService extends ServiceBase {
  constructor() {
    super();
    this._nddStore = '';
    this._nddStoreWatcher = null;
    this._running = new Set();
  }

  async init() {
    this._nddStore = await fsMkdtemp(path.join(os.tmpdir(), 'ndb-'));
    this._nddStoreWatcher = chokidar.watch(this._nddStore, {
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      },
      cwd: this._nddStore,
      depth: 0
    });
    this._nddStoreWatcher.on('add', this._onAdded.bind(this));
    this._nddStoreWatcher.on('unlink', id => this._running.delete(id));
    return this._nddStore;
  }

  async _onAdded(id) {
    this._running.add(id);
    try {
      const info = JSON.parse(await fsReadFile(path.join(this._nddStore, id), 'utf8'));
      this._notify('added', {...info, id});
    } catch (e) {
    }
  }

  async dispose() {
    try {
      for (const id of this._running)
        process.kill(id, 'SIGKILL');
      this._running.clear();
      if (this._nddStoreWatcher) {
        this._nddStoreWatcher.close();
        this._nddStoreWatcher = null;
        await removeFolder(this._nddStore);
        this._nddStore = '';
      }
    } catch (e) {
    } finally {
      process.exit(0);
    }
  }

  async debug({execPath, args, options}) {
    const env = {
      NODE_OPTIONS: `--require ${options.preload}`,
      NDD_STORE: this._nddStore,
      NDB_VERSION
    };
    if (options && options.data)
      env.NDD_DATA = options.data;
    const p = spawn(execPath, args, {
      cwd: options.cwd,
      env: { ...process.env, ...env },
      stdio: ['inherit', 'inherit', 'pipe']
    });
    const filter = [
      Buffer.from('Debugger listening on', 'utf8'),
      Buffer.from('Waiting for the debugger to disconnect...', 'utf8'),
      Buffer.from('Debugger attached.', 'utf8')
    ];
    p.stderr.on('data', data => {
      for (const prefix of filter) {
        if (Buffer.compare(data.slice(0, prefix.length), prefix) === 0)
          return;
      }
      process.stderr.write(data);
    });
    return new Promise((resolve, reject) => {
      p.on('exit', code => resolve(code));
      p.on('error', error => reject(error));
    }).then(_ => fs.unlink(path.join(this._nddStore, String(p.pid)), err => 0));
  }

  async kill({id}) {
    if (!this._running.has(id))
      return;
    process.kill(id, 'SIGKILL');
    fs.unlink(path.join(this._nddStore, id), err => 0);
  }
}

new NddService();
