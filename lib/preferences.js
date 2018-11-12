/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

const fsReadFile = util.promisify(fs.readFile);
const fsWriteFile = util.promisify(fs.writeFile);

class NdbPreferences {
  static async create(frontend, configDir) {
    const preferencesFile = path.join(configDir, 'Preferences');
    const current = await NdbPreferences._read(preferencesFile);
    const preferences = new NdbPreferences(preferencesFile, current);
    await Promise.all([
      preferences._sync(),
      frontend.exposeFunction('getPreferences', _ => NdbPreferences._read(preferencesFile)),
      frontend.exposeFunction('setPreference', preferences._setPreference.bind(preferences)),
      frontend.exposeFunction('removePreference', preferences._removePreference.bind(preferences)),
      frontend.exposeFunction('clearPreferences', preferences._clearPreferences.bind(preferences))
    ]);
  }

  /**
   * @param {string} preferencesFile
   * @param {!Object} current
   * @return {!Promise}
   */
  constructor(preferencesFile, current) {
    this._file = preferencesFile;
    this._current = current;
  }

  /**
   * @param {string} name
   * @param {string} value
   * @return {!Promise}
   */
  _setPreference(name, value) {
    this._current[name] = value;
    return this._sync();
  }

  /**
   * @param {string} name
   * @return {!Promise}
   */
  _removePreference(name) {
    delete this._current[name];
    return this._sync();
  }

  /**
   * @return {!Promise}
   */
  async _clearPreferences() {
    this._current = await NdbPreferences._read(undefined, true);
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

module.exports = { NdbPreferences };
