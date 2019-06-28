/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

try {
  const inspector = require('inspector');
  const fs = require('fs');
  let inspectorPort = 0;
  inspector.open(inspectorPort, undefined, false);
  let inspectorUrl = inspector.url();
  if (process.version.startsWith('v8.')) {
    const url = require('url');
    const parsedInspectorUrl = url.parse(inspectorUrl);
    parsedInspectorUrl.pathname = '/json';
    parsedInspectorUrl.protocol = 'http';
    inspectorUrl = url.format(parsedInspectorUrl);
    inspectorPort = Number(parsedInspectorUrl.port);
  }
  const sep = process.platform === 'win32' ? '\\' : '/';
  const fileName = `${process.env.NDD_STORE}${sep}${process.pid}`;
  process.once('exit', fs.unlinkSync.bind(null, fileName));
  const info = fetchProcessInfo();
  info.inspectorUrl = inspectorUrl;
  fs.writeFileSync(fileName, JSON.stringify(info));
  if (process.version.startsWith('v8.')) {
    inspector.close();
    inspector.open(inspectorPort, undefined, true);
  } else {
    inspector.open(inspectorPort, undefined, true);
  }

  function fetchProcessInfo() {
    let scriptName = '';
    try {
      scriptName = require.resolve(process.argv[1]);
    } catch (e) {
    }
    const ppid = process.env.NDD_PPID;
    process.env.NDD_PPID = process.pid;
    process.versions['ndb'] = process.env.NDB_VERSION;
    return {
      cwd: process.cwd(),
      argv: process.argv.concat(process.execArgv),
      data: process.env.NDD_DATA,
      ppid: ppid,
      scriptName: scriptName
    };
  }
} catch (e) {
}
// eslint-disable-next-line spaced-comment
//# sourceURL=internal/preload.js
