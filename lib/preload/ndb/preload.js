/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

(function() {
  if (!process.env.NDD_IPC)
    return;
  try {
    if (!require('worker_threads').isMainThread)
      return;
  } catch (e) {
    // node 8 does not support workers
  }
  let scriptName = '';
  try {
    scriptName = require.resolve(process.argv[1]);
  } catch (e) {
    // preload can get scriptName iff node starts with script as first argument,
    // we should be ready for exception in other cases, e.g., node -e '...'
  }

  const ppid = process.env.NDD_PPID;
  process.env.NDD_PPID = process.pid;
  if (!process.env.NDD_DATA)
    process.env.NDD_DATA = process.pid + '_ndbId';
  process.versions['ndb'] = '1.1.3';
  const inspector = require('inspector');
  inspector.open(0, undefined, false);
  const base64 = new Buffer(JSON.stringify({
    cwd: process.cwd(),
    argv: process.argv.concat(process.execArgv),
    data: process.env.NDD_DATA,
    ppid: ppid,
    id: String(process.pid),
    inspectorUrl: inspector.url(),
    scriptName: scriptName
  })).toString('base64');
  const { execFileSync } = require('child_process');
  if (process.platform === 'win32')
    execFileSync('cmd', ['/C', `echo "${base64}" > ${process.env.NDD_IPC}`]);
  else
    execFileSync('/bin/sh', ['-c', `/bin/echo ${base64} | nc -U ${process.env.NDD_IPC}`]);

})();
// eslint-disable-next-line spaced-comment
//# sourceURL=internal/preload.js
