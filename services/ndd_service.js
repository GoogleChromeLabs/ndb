/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const removeFolder = require('rimraf');
const util = require('util');

const WebSocket = require('ws');

const {Client} = require('../node_debug_demon/client.js');
const {ServiceBase} = require('./service_base.js');

const wsSymbol = Symbol('WebSocket');

class NddService extends ServiceBase {
  constructor() {
    super();
    this._nddStore = '';
    this._nddClient = null;
    this._onAddedListener = this._onAdded.bind(this);
    this._onFinishedListener = this._onFinished.bind(this);

    this._instances = new Map();
  }

  async start() {
    if (this._nddClient)
      return;
    this._nddStore = await util.promisify(fs.mkdtemp)(path.join(os.tmpdir(), 'ndb-'));
    this._nddClient = new Client(this._nddStore);
    this._nddClient.on('added', this._onAddedListener);
    this._nddClient.on('finished', this._onFinishedListener);
    await this._nddClient.start();
    return this._nddStore;
  }

  async stop() {
    if (!this._nddClient)
      return;
    await this._nddClient.stop();
    this._nddClient.removeListener('added', this._onAddedListener);
    this._nddClient.removeListener('finished', this._onFinishedListener);
    this._instances.clear();
    await util.promisify(removeFolder)(this._nddStore);
  }

  async dispose() {
    try {
      await this.stop();
    } finally {
      process.exit(0);
    }
  }

  async attach({instanceId}) {
    if (!this._nddClient)
      throw 'NddService should be started first';
    const instance = this._instances.get(instanceId);
    if (!instance)
      throw 'No instance with given id';
    if (instance[wsSymbol])
      throw 'Already attached to instance with given id';

    const {url} = await instance.fetchInfo();
    const ws = new WebSocket(url);
    ws.on('error', error => ws.close());
    ws.on('close', (a,b,c) => {
      if (!instance[wsSymbol])
        return;
      this._notify('detached', {
        instanceId: instance.id()
      });
      delete instance[wsSymbol];
      this._nddClient.detach(instance.id());
    });
    ws.on('open', _ => {
      instance[wsSymbol] = ws;
      this._notify('attached', {instanceId: instance.id()});
    });
    ws.on('message', message => {
      this._notify('message', {
        instanceId: instance.id(),
        message
      });
    });
  }

  async detach({instanceId}) {
    if (!this._nddClient)
      throw 'NddService should be started first';
    const instance = this._instances.get(instanceId);
    if (!instance)
      throw 'No instance with given id';
    if (!instance[wsSymbol])
      throw 'Instance is not attached';
    instance[wsSymbol].close();
  }

  async sendMessage({instanceId, message}) {
    if (!this._nddClient)
      throw 'NddService should be started first';
    const instance = this._instances.get(instanceId);
    if (!instance)
      throw 'No instance with given id';
    if (!instance[wsSymbol])
      throw 'Not attached to instance with given id';
    instance[wsSymbol].send(message);
  }

  async debug({execPath, args, options}) {
    const env = {
      NODE_OPTIONS: `--require ${require.resolve('../node_debug_demon/preload.js')} --inspect=0`,
      NDD_STORE: this._nddStore,
      NDD_DEASYNC_JS: require.resolve('deasync')
    };
    if (options && options.waitAtStart)
      env.NDD_WAIT_AT_START = 1;
    if (options && options.groupId)
      env.NDD_GROUP_ID = options.groupId;
    const p = spawn(execPath, args, {
      cwd: options.cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    });
    return new Promise((resolve, reject) => {
      p.on('exit', code => resolve(code));
      p.on('error', error => reject(error));
    });
  }

  run({execPath, args, options}) {
    const env = options.env || {};
    let stdoutString = '';
    let stderrString = '';
    const p = spawn(execPath, args, { cwd: options.cwd, env: { ...process.env, ...env }});
    p.stdout.on('data', data => stdoutString += data.toString());
    p.stderr.on('data', data => stderrString += data.toString());
    return new Promise((resolve, reject) => {
      p.on('exit', code => resolve({
        stdout: stdoutString,
        stderr: stderrString,
        code
      }));
      p.on('error', error => reject(error));
    });
  }

  async kill({instanceId}) {
    if (!this._nddClient)
      throw 'NddService should be started first';
    const instance = this._instances.get(instanceId);
    if (!instance)
      throw 'No instance with given id';
    instance.kill();
  }

  async _onAdded(instance) {
    this._instances.set(instance.id(), instance);
    this._notify('added', {
      ...await instance.fetchInfo(),
      instanceId: instance.id()
    });
  }

  _onFinished(instance) {
    this._instances.delete(instance.id());
    if (instance[wsSymbol])
      instance[wsSymbol].close();
    this._notify('finished', {
      instanceId: instance.id()
    });
  }
}

new NddService();
