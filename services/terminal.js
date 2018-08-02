/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

let pty;
let error;
try {
  pty = require('ndb-node-pty-prebuilt');
} catch (e) {
  error = e.stack;
}

const fs = require('fs');

const {ServiceBase} = require('./service_base.js');

const NDB_VERSION = require('../package.json').version;

class Terminal extends ServiceBase {
  init(params) {
    if (!pty)
      throw {message: error};
    let shell = process.env.SHELL;
    if (!shell || !fs.existsSync(shell))
      shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    this._term = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: params.cols || 80,
      rows: params.rows || 24,
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${params.preload}`,
        NDD_STORE: params.nddStore,
        NDB_VERSION
      }
    });

    this._term.on('data', data => this._notify('data', {data}));
    this._term.on('close', _ => this._notify('close'));
    return Promise.resolve({});
  }

  dispose() {
    process.exit(0);
  }

  resize(params) {
    if (this._term)
      this._term.resize(params.cols, params.rows);
    return Promise.resolve({});
  }

  write(params) {
    if (this._term)
      this._term.write(params.data);
    return Promise.resolve({});
  }
}

new Terminal();
