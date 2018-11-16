/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const fs = require('fs');
const { rpc, rpc_process } = require('carlo/rpc');

class Terminal {
  constructor(frontend, pty, nddStore, preload, cols, rows) {
    let shell = process.env.SHELL;
    if (!shell || !fs.existsSync(shell))
      shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const NDB_VERSION = require('../package.json').version;
    this._term = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: cols,
      rows: rows,
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${preload}`,
        NDD_STORE: nddStore,
        NDD_WAIT_FOR_CONNECTION: 1,
        NDB_VERSION
      }
    });
    this._term.on('data', data => frontend.dataAdded(data));
    this._term.on('close', () => frontend.closed());
    process.on('disconnect', () => this.dispose());
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

function init(frontend, nddStore, preload, cols, rows) {
  try {
    const pty = require('ndb-node-pty-prebuilt');
    return rpc.handle(new Terminal(frontend, pty, nddStore, preload, cols, rows));
  } catch (e) {
    frontend.initFailed(e.stack);
    process.exit(0);
  }
}

rpc_process.init(args => init(...args.args));
