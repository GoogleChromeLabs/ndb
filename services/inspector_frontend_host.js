/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const { rpc, rpc_process } = require('carlo/rpc');

const fs = require('fs');
const util = require('util');
const path = require('path');
const fsReadFile = util.promisify(fs.readFile);
const fsWriteFile = util.promisify(fs.writeFile);

const opn = require('opn');

class Preferences {
  /**
   * @param {string} configDir
   */
  constructor(configDir) {
    this._file = path.join(configDir, 'Preferences');
    this._current = {};
  }

  async getPreferences() {
    this._current = await Preferences._read(this._file, /* forceDefault */ false);
    return this._current;
  }

  /**
   * @param {string} name
   * @param {string} value
   * @return {!Promise}
   */
  setPreference(name, value) {
    this._current[name] = value;
    return this._sync();
  }

  /**
   * @param {string} name
   * @return {!Promise}
   */
  removePreference(name) {
    delete this._current[name];
    return this._sync();
  }

  /**
   * @return {!Promise}
   */
  async clearPreferences() {
    this._current = await Preferences._read(this._file, /* forceDefault */ true);
    return this._sync();
  }

  /**
   * @return {!Promise}
   */
  async _sync() {
    await fsWriteFile(this._file, JSON.stringify(this._current), 'utf8');
  }

  /**
   * @param {string} fileName
   * @return {!Object}
   */
  static async _read(fileName, forceDefault) {
    try {
      const content = !forceDefault && fs.existsSync(fileName)
        ? await fsReadFile(fileName, 'utf8')
        : await fsReadFile(path.join(__dirname, '..', 'DefaultPreferences'));
      return JSON.parse(content);
    } catch (e) {
      return {};
    }
  }
}

class InspectorFrontendHost {
  constructor(configDir) {
    this._preferences = new Preferences(configDir);
    require('../lib/process_utility.js')(() => this.dispose());
  }

  /**
   * @param {text} url
   */
  openInNewTab(url) {
    opn(url);
  }

  getPreferences() {
    return this._preferences.getPreferences();
  }

  setPreference(name, value) {
    return this._preferences.setPreference(name, value);
  }

  removePreference(name) {
    return this._preferences.removePreference(name);
  }

  clearPreferences() {
    return this._preferences.clearPreferences();
  }

  dispose() {
    Promise.resolve().then(() => process.exit(0));
  }
}

rpc_process.init(configDir => rpc.handle(new InspectorFrontendHost(configDir)));
