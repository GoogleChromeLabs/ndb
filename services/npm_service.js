/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const {exec} = require('child_process');
const util = require('util');

const {ServiceBase} = require('./service_base.js');

class NpmService extends ServiceBase {
  async call(method, options) {
    const cmd = `npm ${method} --json=true ` + Object.keys(options || {})
        .map(key => `--${key}=${options[key]}`).join(' ');
    const result = await util.promisify(exec)(cmd).catch(result => result);
    return JSON.parse(result.stdout);
  }

  async dispose() {
    process.exit(0);
  }

  _getMethod(method) {
    if (method === 'dispose')
      return this.dispose.bind(this);
    return this.call.bind(this, method);
  }
}

new NpmService();
