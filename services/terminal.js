/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const fs = require('fs');
const path = require('path');
const { rpc, rpc_process } = require('carlo/rpc');

class Terminal {
  constructor(frontend, pty, nddStore, cols, rows) {
    require('../lib/process_utility.js')('terminal', () => this.dispose());
    let shell = process.env.SHELL;
    if (!shell || !fs.existsSync(shell))
      shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const NDB_VERSION = require('../package.json').version;
    let nodePath = process.env.NODE_PATH || '';
    if (nodePath)
      nodePath += process.platform === 'win32' ? ';' : ':';
    nodePath += path.join(__dirname, '..', 'lib', 'preload');
    this._term = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: cols,
      rows: rows,
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ndb/preload.js`,
        NDD_STORE: nddStore,
        NDD_WAIT_FOR_CONNECTION: 1,
        NODE_PATH: nodePath,
        NDB_VERSION
      }
    });
    this._term.on('data', data => frontend.dataAdded(data));
    this._term.on('close', () => frontend.closed());
  }

  dispose() {
    Promise.resolve().then(() => process.exit(0));
  }

  resize(cols, rows) {
    this._term.resize(cols, rows);
  }

  write(data) {
    this._term.write(data);
  }
}

function init(frontend, nddStore, cols, rows) {
  try {
    const pty = require('ndb-node-pty-prebuilt');
    return rpc.handle(new Terminal(frontend, pty, nddStore, cols, rows));
  } catch (e) {
    frontend.initFailed(e.stack);
    process.exit(0);
  }
}

rpc_process.init(init);
