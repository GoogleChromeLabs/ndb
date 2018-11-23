/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const carlo = require('carlo');
const { rpc, rpc_process } = require('carlo/rpc');

const removeFolder = require('rimraf');
const util = require('util');

const { Backend } = require('./backend.js');

const fsCopyFile = fs.copyFile ? util.promisify(fs.copyFile) : function(source, target) {
  require('fs-copy-file-sync')(source, target);
  return Promise.resolve();
};
const fsMkdir = util.promisify(fs.mkdir);
const fsMkdtemp = util.promisify(fs.mkdtemp);
const fsWriteFile = util.promisify(fs.writeFile);

process.on('unhandledRejection', error => {
  // Will print "unhandledRejection err is not defined"
  if (error.message.includes('Protocol error') && error.message.includes('Target closed'))
    process.exit(1);
  console.log('unhandledRejection', error.message);
});

async function launch(options) {
  const userDataDir = await setupUserDataDir(options.configDir, options.doNotCopyPreferences);
  const app = await carlo.launch({
    bgcolor: '#242424',
    userDataDir,
    channel: ['stable', 'canary', 'chromium']
  });
  let pkg = null;
  try {
    pkg = require(path.join(options.cwd, 'package.json'));
  } catch (e) {
  }
  const preloadJs = path.join(userDataDir, 'preload.js');
  await fsCopyFile(require.resolve('./preload.js'), preloadJs);
  await Promise.all([
    app.exposeFunction('getProcessInfo', () => ({
      execPath: process.execPath,
      argv: options.argv,
      cwd: options.cwd,
      repl: require.resolve('./repl.js'),
      pkg: pkg,
      preload: preloadJs,
      nddSharedStore: path.join(options.configDir, 'ndd_store'),
      configDir: options.configDir
    }))
  ]);

  const overridesFolder = options.debugFrontend
    ? path.dirname(require.resolve(`../front_end/${options.appName}.json`))
    : path.dirname(path.join(options.releaseFrontendFolder, `${options.appName}.js`));

  app.serveFolder(overridesFolder);
  app.serveFolder(path.join(__dirname, '..'));
  if (options.debugFrontend) {
    try {
      app.serveFolder(path.dirname(require.resolve(`chrome-devtools-frontend/front_end/ndb_app.json`)));
    } catch (e) {
      console.log('To use NDB_DEBUG_FRONTEND=1 you should run npm install from ndb folder first');
      process.exit(1);
    }
  }

  const backend = new Backend(app);
  app.on('exit', () => {
    backend.dispose();
    setTimeout(() => process.exit(0), 0);
  });
  await app.load(`${options.appName}.html?experiments=true&debugFrontend=${options.debugFrontend}`,
      rpc.handle(backend));
  return app;
}

async function setupUserDataDir(configDirectory, doNotCopyPreferences) {
  if (!fs.existsSync(configDirectory))
    await fsMkdir(configDirectory);

  if (!fs.existsSync(path.join(configDirectory, 'ndd_store')))
    await fsMkdir(path.join(configDirectory, 'ndd_store'));

  const chromiumPreferencesFile = path.join(configDirectory, 'ChromiumPreferences');
  if (!fs.existsSync(chromiumPreferencesFile))
    await fsWriteFile(chromiumPreferencesFile, '{}', 'utf8');

  const userDataDir = await fsMkdtemp(path.join(os.tmpdir(), 'ndb-'));
  const defaultUserDir = path.join(userDataDir, 'Default');
  await fsMkdir(defaultUserDir);

  const preferencesFile = path.join(defaultUserDir, 'Preferences');
  await fsCopyFile(chromiumPreferencesFile, preferencesFile);

  process.on('exit', _ => {
    if (!doNotCopyPreferences) {
      if (fs.copyFileSync)
        fs.copyFileSync(preferencesFile, chromiumPreferencesFile);
      else
        require('fs-copy-file-sync')(preferencesFile, chromiumPreferencesFile);
    }
    // rimraf might fail if Chrome is writing write now.
    for (let i = 0; i < 5; ++i) {
      try {
        removeFolder.sync(userDataDir);
        break;
      } catch (e) {
      }
    }
  });

  return userDataDir;
}

module.exports = {launch};
