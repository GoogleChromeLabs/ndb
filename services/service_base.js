/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

class ServiceBase {
  constructor() {
    process.on('message', this._onMessage.bind(this));
    this._notify('ready');
  }

  _onMessage({method, options, callbackId}) {
    try {
      const handler = this._getMethod(method);
      if (!(handler instanceof Function)) {
        process.send({callbackId, message: {
          error: `Handler for '${method}' is missing.`
        }});
        return;
      }
      Promise.resolve(handler(options || {}))
          .then(result => process.send({callbackId, message: {result}}))
          .catch(error => process.send({callbackId, message: {error: error.message || error}}));
    } catch (e) {
      process.send({callbackId, message: {error: e.message || e}});
    }
  }

  _notify(name, params) {
    if (process.connected)
      process.send({message: {name, params}});
  }

  _getMethod(name) {
    return this[name].bind(this);
  }
}

module.exports = {ServiceBase};
