/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

(function() {
  if (!process.env.NDD_IPC)
    return;
  if (!process.env.NDD_PUBLISH_DATA) {
    try {
      if (!require('worker_threads').isMainThread)
        return;
    } catch (e) {
      // node 8 does not support workers
    }
    const { pathToFileURL } = require('../../filepath_to_url.js');
    let scriptName = '';
    try {
      scriptName = pathToFileURL(require.resolve(process.argv[1])).toString();
    } catch (e) {
      // preload can get scriptName iff node starts with script as first argument,
      // we should be ready for exception in other cases, e.g., node -e '...'
    }
    const ppid = process.env.NDD_PPID;
    process.env.NDD_PPID = process.pid;
    if (!process.env.NDD_DATA)
      process.env.NDD_DATA = process.pid + '_ndbId';
    process.versions['ndb'] = '1.1.5';
    const inspector = require('inspector');
    inspector.open(0, undefined, false);
    const info = {
      cwd: pathToFileURL(process.cwd()),
      argv: process.argv.concat(process.execArgv),
      data: process.env.NDD_DATA,
      ppid: ppid,
      id: String(process.pid),
      inspectorUrl: inspector.url(),
      scriptName: scriptName
    };
    const {execFileSync} = require('child_process');
    execFileSync(process.execPath, [__filename], {
      env: {
        NDD_IPC: process.env.NDD_IPC,
        NDD_PUBLISH_DATA: JSON.stringify(info)
      }
    });
  } else {
    const net = require('net');
    const TIMEOUT = 30000;
    const socket = net.createConnection(process.env.NDD_IPC, () => {
      socket.write(process.env.NDD_PUBLISH_DATA);
      const timeoutId = setTimeout(() => socket.destroy(), TIMEOUT);
      socket.on('data', () => {
        clearTimeout(timeoutId);
        socket.destroy();
      });
    });
    socket.on('error', err => {
      process.stderr.write('\u001b[31mndb is not found:\u001b[0m\n');
      process.stderr.write('please restart it and update env variables or unset NDD_IPC and NODE_OPTIONS.\n');
      process.exit(0);
    });
  }
})();
// eslint-disable-next-line spaced-comment
//# sourceURL=internal/preload.js
