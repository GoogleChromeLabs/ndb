/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

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
    this._watchEventListener = this._onWatchEvent.bind(this);

    this._instances = new Map();
    this._updateScheduled = new Set();
  }

  async start() {
    this._nddStoreWatcher = fs.watch(this._nddStore);
    this._nddStoreWatcher.on('change', this._watchEventListener);
    await this.cleanup();
    await this._fetchExisting();
  }

  async stop() {
    const fileNames = await util.promisify(fs.readdir)(this._nddStore);
    await Promise.all(fileNames.map(async fileName => {
      const match = fileName.match(/([0-9]+)-ready/);
      if (match) {
        const [_, id] = match;
        process.kill(id, 'SIGKILL');
      }
    }));
    await this.cleanup();
    await this.dispose();
  }

  async cleanup() {
    const fileNames = await util.promisify(fs.readdir)(this._nddStore);
    await Promise.all(fileNames.map(async fileName => {
      const match = fileName.match(/([0-9]+)-ready/);
      if (match) {
        const [_, id] = match;
        let exists = true;
        try {
          process.kill(id, 0);
        } catch (e) {
          exists = false;
        }
        if (!exists)
          await util.promisify(fs.unlink)(path.join(this._nddStore, fileName)).catch(() => 0);
      }
    }));
  }

  dispose() {
    this._updateScheduled.clear();
    this._instances.clear();
    if (this._nddStoreWatcher) {
      this._nddStoreWatcher.removeListener('change', this._watchEventListener);
      this._nddStoreWatcher.close();
    }
  }

  async _fetchExisting() {
    const fileNames = await util.promisify(fs.readdir)(this._nddStore);
    for (const fileName of fileNames)
      this._onWatchEvent('rename', fileName);
  }

  /**
   * @param {string} eventType
   * @param {string} fileName
   */
  _onWatchEvent(eventType, fileName) {
    if (eventType === 'rename') {
      const match = fileName.match(/([0-9]+)-ready/);
      if (match) {
        const [_, id] = match;
        this._scheduleUpdate(id);
      }
    }
  }

  /**
   * @param {string} id
   */
  _scheduleUpdate(id) {
    if (!this._updateScheduled.has(id)) {
      setImmediate(() => this._update(id));
      this._updateScheduled.add(id);
    }
  }

  /**
   * @param {string} id
   */
  async _update(id) {
    this._updateScheduled.delete(id);

    const files = await util.promisify(fs.readdir)(this._nddStore);
    const re = new RegExp(`${id}-ready`);
    let isFinished = true;
    for (const file of files) {
      const match = file.match(re);
      if (match) {
        isFinished = false;
        break;
      }
    }
    if (this._instances.has(id) && isFinished) {
      const instance = this._instances.get(id);
      instance._finished();
      this._instances.delete(id);
      this.emit('finished', instance);
    } else if (!isFinished) {
      const instance = new NodeProcess(id, this._nddStore);
      this._instances.set(id, instance);
      this.emit('added', instance);
    }
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
    this._isFinished = false;

    this._finishedCallback = null;
  }

  /**
   * @return {boolean}
   */
  isFinished() {
    return this._isFinished;
  }

  /**
   * @return {string}
   */
  id() {
    return this._id;
  }

  async kill() {
    if (!this._isFinished) {
      const done = new Promise(resolve => this._finishedCallback = resolve);
      try {
        process.kill(this._id, 'SIGKILL');
      } catch (e) {
      }
      await done;
    }
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

  _finished() {
    this._isFinished = true;
    if (this._finishedCallback)
      this._finishedCallback();
  }
}

module.exports = {Client};
