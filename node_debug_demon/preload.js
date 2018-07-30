/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

try {
  const fs = require('fs');
  const path = require('path');

  const nddStore = process.env.NDD_STORE;
  const nddWaitAtStart = !!process.env.NDD_WAIT_AT_START || false;
  const nodePid = process.pid;
  const nddGroupId = process.env.NDD_GROUP_ID || `${nodePid}:${Date.now()}`;
  if (process.env.NDD_GROUP_ID !== nddGroupId)
    process.env.NDD_GROUP_ID = nddGroupId;
  const parentProcessId = process.env.NDD_PID;
  process.env.NDD_PID = process.pid;

  const stateFileName = path.join(nddStore, `${nodePid}`);
  const state = {
    url: require('inspector').url(),
    groupId: nddGroupId,
    argv: process.argv.concat(process.execArgv),
    waitAtStart: nddWaitAtStart
  };
  if (parentProcessId)
    state.parentId = parentProcessId;
  if (process.env.NDD_DATA)
    state.data = process.env.NDD_DATA;
  fs.writeFileSync(stateFileName, JSON.stringify(state));

  const readyFileName = path.join(nddStore, `${nodePid}-ready`);
  if (nddWaitAtStart) {
    let wait = true;
    process.runIfWaitingAtStart = breakAtStart => {
      if (breakAtStart) {
        process._breakFirstLine = true;
        const commandLineAPIDebug = debug;
        process.binding('inspector').callAndPauseOnStart = (fn, receiver, ...args) => {
          commandLineAPIDebug(fn);
          fn.apply(receiver, args);
        };
      }
      wait = false;
    };
    fs.renameSync(stateFileName, readyFileName);
    const buffer = [];
    const store = message => buffer.push(message);
    process.on('message', store);

    while (wait) require(process.env.NDD_DEASYNC_JS).sleep(100);

    process.removeListener('message', store);
    if (buffer.length)
      setTimeout(_ => buffer.map(message => process.emit('message', message)), 0);
    delete process.runIfWaitingAtStart;
  } else {
    fs.renameSync(stateFileName, readyFileName);
  }
} catch (e) {
}
