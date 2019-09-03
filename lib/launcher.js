/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const path = require('path');
const carlo = require('carlo');
const { rpc, rpc_process } = require('carlo/rpc');
const { pathToFileURL } = require('./filepath_to_url.js');
const { Backend } = require('./backend.js');

process.on('unhandledRejection', error => {
  if (error.message.includes('Protocol error') && error.message.includes('Target closed'))
    process.exit(1);
  console.log('unhandledRejection', error.stack || error.message);
});

async function launch() {
  let app;
  const carloArgs = process.env.NDB_CARLO_ARGS ? JSON.parse(process.env.NDB_CARLO_ARGS) : {};
  try {
    app = await carlo.launch({
      bgcolor: '#242424',
      channel: ['chromium'],
      paramsForReuse: {
        data: Buffer.from(JSON.stringify({
          cwd: pathToFileURL(process.cwd()).toString(),
          argv: process.argv,
          nodeExecPath: process.execPath
        })).toString('base64')
      },
      ...carloArgs
    });
  } catch (e) {
    if (e.message !== 'Could not start the browser or the browser was already running with the given profile.')
      throw e;
    process.exit(0);
  }

  process.title = 'ndb/main';
  const appName = 'ndb';
  const debugFrontend = !!process.env.NDB_DEBUG_FRONTEND;

  app.setIcon(path.join(__dirname, '..', 'front_end', 'favicon.png'));
  const overridesFolder = debugFrontend
    ? path.dirname(require.resolve(`../front_end/${appName}.json`))
    : path.join(__dirname, '..', '.local-frontend');
  app.serveFolder(overridesFolder);
  if (debugFrontend) {
    try {
      app.serveFolder(path.join(__dirname, '..', 'node_modules'));
      app.serveFolder(path.dirname(require.resolve(`chrome-devtools-frontend/front_end/ndb_app.json`)));
    } catch (e) {
      console.log('To use NDB_DEBUG_FRONTEND=1 you should run npm install from ndb folder first');
      process.exit(1);
    }
  }
  app.on('exit', () => setTimeout(() => process.exit(0), 0));
  app.on('window', load);
  load(app.mainWindow());

  async function load(window) {
    const params = [
      ['experiments', true],
      ['debugFrontend', debugFrontend],
      ['sources.hide_add_folder', true],
      ['sources.hide_thread_sidebar', true],
      ['timelineTracingJSProfileDisabled', true],
      ['panel', 'sources']];
    const paramString = params.reduce((acc, p) => acc += `${p[0]}=${p[1]}&`, '');
    window.load(`${appName}.html?${paramString}`, rpc.handle(new Backend(window)));
  }
}

module.exports = {launch};
