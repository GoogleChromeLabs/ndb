/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

try {
  const fs = require('fs');
  const inspector = require('inspector');
  const url = require('url');

  process.versions['ndb'] = process.env.NDB_VERSION;

  const nddStore = process.env.NDD_STORE;
  const nddParentProcessId = process.env.NDD_PPID;
  const nddData = process.env.NDD_DATA;
  const nddWaitForConnection = process.env.NDD_WAIT_FOR_CONNECTION;

  process.env.NDD_PPID = process.pid;
  process.once('exit', _ => fs.unlinkSync(stateFileName));
  process.breakAtStart = _ => {
    process._breakFirstLine = true;
    const commandLineAPIDebug = debug;
    process.binding('inspector').callAndPauseOnStart = (fn, receiver, ...args) => {
      commandLineAPIDebug(fn);
      return fn.apply(receiver, args);
    };
  };

  inspector.open(0, undefined, false);

  const inspectorUrl = url.parse(inspector.url());
  inspectorUrl.pathname = '/json';
  inspectorUrl.hash = '';
  inspectorUrl.protocol = 'http';
  inspectorUrl.search = '';
  const port = Number(inspectorUrl.port);
  const targetListUrl = url.format(inspectorUrl);

  const sep = process.platform === 'win32' ? '\\' : '/';
  const stateFileName = `${nddStore}${sep}${process.pid}`;
  fs.writeFileSync(stateFileName, JSON.stringify({
    targetListUrl: targetListUrl,
    ppid: nddParentProcessId,
    data: nddData,
    argv: process.argv.concat(process.execArgv),
    cwd: process.cwd()
  }));

  inspector.close();
  inspector.open(port, undefined, nddWaitForConnection !== '0');
  delete process.breakAtStart;
} catch (e) {
}
// eslint-disable-next-line spaced-comment
//# sourceURL=internal/preload.js
