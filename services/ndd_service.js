/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const { rpc, rpc_process } = require('carlo/rpc');
const { spawn } = require('child_process');
const chokidar = require('chokidar');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const util = require('util');
const url = require('url');
const WebSocket = require('ws');

const NDB_VERSION = require('../package.json').version;

const fsMkdtemp = util.promisify(fs.mkdtemp);
const fsReadFile = util.promisify(fs.readFile);
const removeFolder = util.promisify(require('rimraf'));

class NddService {
  constructor() {
    require('../lib/process_utility.js')('ndd_service', () => this.dispose());
    this._nddStores = [];
    this._nddStoreWatchers = [];
    this._running = new Set();
    this._sockets = new Map();
    this._frontend = null;
  }

  async init(frontend) {
    this._frontend = frontend;
    this._nddStores = [await fsMkdtemp(path.join(os.tmpdir(), 'ndb-'))];

    try {
      const ndbDir = path.join(os.homedir(), '.ndb');
      if (!fs.existsSync(ndbDir))
        fs.mkdirSync(ndbDir);
      const nddStoreDir = path.join(ndbDir, 'ndd_store');
      if (!fs.existsSync(nddStoreDir))
        fs.mkdirSync(nddStoreDir);
      this._nddStores.push(nddStoreDir);
    } catch (e) {
    }

    this._nddStoreWatchers = [];
    for (const nddStore of this._nddStores) {
      const watcher = chokidar.watch(nddStore, {
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 100
        },
        cwd: nddStore,
        depth: 0
      });
      this._nddStoreWatchers.push(watcher);
      watcher.on('add', id => {
        this._running.add(id);
        this._onAdded(nddStore, id);
      });
      watcher.on('unlink', id => this._running.delete(id));
      watcher.on('error', error => 0);
    }
  }

  nddStore() {
    return this._nddStores[0];
  }

  async _onAdded(nddStore, id) {
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
      ws.once('open', () => {
        this._sockets.set(id, ws);
        this._frontend.detected({...info, id}, rpc.handle(this));
      });
      ws.on('message', rawMessage => {
        const message = JSON.parse(rawMessage);
        message.sessionId = id;
        this._frontend.dispatchMessage(message);
      });
      ws.once('close', () => {
        this._sockets.delete(id);
        this._frontend.disconnected(id);
      });
      ws.once('error', () => 0);
    } catch (e) {
    }
  }

  _fetch(url) {
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
      for (const id of Array.from(this._running)) {
        try {
          process.kill(id, 'SIGKILL');
        } catch (e) {
        }
      }
      this._running.clear();
      for (const ws of this._sockets.values())
        ws.close();
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

  debug(execPath, args, options) {
    let nodePath = process.env.NODE_PATH || '';
    if (nodePath)
      nodePath += process.platform === 'win32' ? ';' : ':';
    nodePath += path.join(__dirname, '..', 'lib', 'preload');
    const env = {
      NODE_OPTIONS: `--require ndb/preload.js`,
      NODE_PATH: nodePath,
      NDD_STORE: this._nddStores[0],
      NDD_WAIT_FOR_CONNECTION: 1,
      NDB_VERSION
    };
    if (options && options.data)
      env.NDD_DATA = options.data;
    const p = spawn(execPath, args, {
      cwd: options.cwd,
      env: { ...process.env, ...env },
      stdio: options.ignoreOutput ? 'ignore' : ['inherit', 'inherit', 'pipe'],
      windowsHide: true
    });
    if (!options.ignoreOutput) {
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
    }
    return new Promise((resolve, reject) => {
      p.on('exit', code => resolve(code));
      p.on('error', error => reject(error));
    }).then(_ => fs.unlink(path.join(this._nddStores[0], String(p.pid)), err => 0));
  }

  kill(id) {
    if (!this._running.has(id))
      return;
    process.kill(id, 'SIGINT');
    for (const nddStore of this._nddStores)
      fs.unlink(path.join(nddStore, id), _ => 0);
  }

  sendMessage(rawMessage) {
    const message = JSON.parse(rawMessage);
    const socket = this._sockets.get(message.sessionId);
    delete message.sessionId;
    if (socket)
      socket.send(JSON.stringify(message));
  }

  disconnect(sessionId) {
    const socket = this._sockets.get(sessionId);
    if (socket)
      socket.close();
  }
}

rpc_process.init(args => rpc.handle(new NddService()));
