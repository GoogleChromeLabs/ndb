/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const {spawn} = require('child_process');
const chokidar = require('chokidar');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const util = require('util');
const url = require('url');
const WebSocket = require('ws');

const {ServiceBase} = require('./service_base.js');

const NDB_VERSION = require('../package.json').version;

const fsMkdtemp = util.promisify(fs.mkdtemp);
const fsReadFile = util.promisify(fs.readFile);
const removeFolder = util.promisify(require('rimraf'));

class NddService extends ServiceBase {
  constructor() {
    super();
    this._nddStores = [];
    this._nddStoreWatchers = [];
    this._running = new Set();
    this._sockets = new Map();
  }

  async init({nddSharedStore}) {
    this._nddStores = [await fsMkdtemp(path.join(os.tmpdir(), 'ndb-'))];
    if (nddSharedStore)
      this._nddStores.push(nddSharedStore);
    this._nddStoreWatchers = [];
    for (const nddStore of this._nddStores) {
      const watcher = chokidar.watch(nddStore, {
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100
        },
        cwd: nddStore,
        depth: 0
      });
      this._nddStoreWatchers.push(watcher);
      watcher.on('add', this._onAdded.bind(this, nddStore));
      watcher.on('unlink', id => this._running.delete(id));
    }
    return this._nddStores[0];
  }

  async _onAdded(nddStore, id) {
    this._running.add(id);
    try {
      const info = JSON.parse(await fsReadFile(path.join(nddStore, id), 'utf8'));
      const targetInfo = (await this._fetch(info.targetListUrl))[0];
      let webSocketDebuggerUrl = targetInfo.webSocketDebuggerUrl;
      if (!webSocketDebuggerUrl) {
        const wsUrl = url.parse(info.wsUrl);
        wsUrl.pathname = '/' + targetInfo.id;
        webSocketDebuggerUrl = url.format(wsUrl);
      }
      const ws = new WebSocket(webSocketDebuggerUrl);
      ws.on('error', _ => 0);
      ws.once('open', _ => {
        this._sockets.set(id, ws);
        this._notify('added', {...info, id});
      });
      ws.on('message', message => this._notify('message', {message, id}));
      ws.once('close', _ => {
        this._sockets.delete(id);
        this._notify('disconnected', {id});
      });
    } catch (e) {
    }
  }

  async disconnect({id}) {
    const ws = this._sockets.get(id);
    if (ws)
      ws.close();
  }

  async send({id, message}) {
    const ws = this._sockets.get(id);
    if (ws)
      return new Promise(resolve => ws.send(message, resolve));
  }

  async _fetch(url) {
    return new Promise(resolve => {
      http.get(url, res => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
        } else {
          res.setEncoding('utf8');
          let buffer = '';
          res.on('data', data => buffer += data);
          res.on('end', _ => {
            try {
              resolve(JSON.parse(buffer));
            } catch (e) {
              resolve(null);
            }
          });
        }
      }).on('error', _ => resolve(null));
    });
  }

  async dispose() {
    try {
      for (const id of this._running)
        process.kill(id, 'SIGKILL');
      this._running.clear();
      for (const watcher of this._nddStoreWatchers)
        watcher.close();
      await removeFolder(this._nddStores[0]);
      this._nddStores = [];
      this._nddStoreWatchers = [];
    } catch (e) {
    } finally {
      process.exit(0);
    }
  }

  async debug({execPath, args, options}) {
    const env = {
      NODE_OPTIONS: `--require ${options.preload}`,
      NDD_STORE: this._nddStores[0],
      NDD_WAIT_FOR_CONNECTION: 1,
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
    }).then(_ => fs.unlink(path.join(this._nddStores[0], String(p.pid)), err => 0));
  }

  async kill({id}) {
    if (!this._running.has(id))
      return;
    process.kill(id, 'SIGKILL');
    for (const nddStore of this._nddStores)
      fs.unlink(path.join(nddStore, id), _ => 0);
  }
}

new NddService();
