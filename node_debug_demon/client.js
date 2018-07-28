/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const chokidar = require('chokidar');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const util = require('util');

class Client extends EventEmitter {
  /**
   * @param {string} nddStore
   */
  constructor(nddStore) {
    super();
    this._nddStore = nddStore;
    this._nddStoreWatcher = null;
    this._instances = new Map();
  }

  async start() {
    this._nddStoreWatcher = chokidar.watch([this._nddStore], {
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      },
      cwd: this._nddStore,
      depth: 0,
      ignorePermissionErrors: true
    });
    this._nddStoreWatcher.on('add', path => {
      const match = path.match(/([0-9]+)-ready/);
      if (!match)
        return;
      const id = match[1];
      let instance = this._instances.get(id);
      if (instance)
        return;
      instance = new NodeProcess(id, this._nddStore);
      this._instances.set(id, instance);
      this.emit('added', instance);
    });
    this._nddStoreWatcher.on('unlink', path => {
      const match = path.match(/([0-9]+)-ready/);
      if (!match)
        return;
      const id = match[1];
      const instance = this._instances.get(id);
      if (!instance)
        return;
      this._instances.delete(id);
      this.emit('finished', instance);
    });
  }

  async stop() {
    const fileNames = await util.promisify(fs.readdir)(this._nddStore);
    await Promise.all(fileNames.map(async fileName => {
      const match = fileName.match(/([0-9]+)-ready/);
      if (match)
        process.kill(match[1], 'SIGKILL');
    }));
    this._instances.clear();
    if (this._nddStoreWatcher) {
      this._nddStoreWatcher.close();
      this._nddStoreWatcher = null;
    }
  }

  detach(id) {
    const name = path.join(this._nddStore, `${id}-ready`);
    if (fs.existsSync(name))
      util.promisify(fs.unlink)(name);
  }
}

class NodeProcess {
  /**
   * @param {string} id
   * @param {string} nddStore
   */
  constructor(id, nddStore) {
    this._nddStore = nddStore;

    this._id = id;
    this._info = null;
  }

  /**
   * @return {string}
   */
  id() {
    return this._id;
  }

  /**
   * @return {!Promise<?Object>}
   */
  async fetchInfo() {
    if (!this._info) {
      const fileName = path.join(this._nddStore, `${this._id}-ready`);
      try {
        const content = await util.promisify(fs.readFile)(fileName);
        this._info = JSON.parse(content);
      } catch (e) {
        return null;
      }
    }
    return this._info;
  }

  kill() {
    try {
      process.kill(Number(this._id), 'SIGKILL');
    } catch (e) {
    }
  }
}

module.exports = {Client};
