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

const readline = require('readline');
const {Readable} = require('stream');
const removeFolder = require('rimraf');
const {URL} = require('url');
const util = require('util');
const querystring = require('querystring');

const {FileSystem} = require('./file_system_backend.js');
const {SearchBackend} = require('./search_backend.js');
const {NdbPreferences} = require('./preferences.js');

const fsCopyFile = fs.copyFile ? util.promisify(fs.copyFile) : function(source, target) {
  require('fs-copy-file-sync')(source, target);
  return Promise.resolve();
};
const fsReadFile = util.promisify(fs.readFile);
const fsMkdir = util.promisify(fs.mkdir);
const fsMkdtemp = util.promisify(fs.mkdtemp);
const fsWriteFile = util.promisify(fs.writeFile);

async function launch(options) {
  const userDataDir = await setupUserDataDir(options.configDir, options.doNotCopyPreferences);
  const app = await carlo.launch({
    bgcolor: '#242424',
    userDataDir
  });
  app.safeEvaluate = async(...args) => {
    try {
      return await app.evaluate(...args);
    } catch (e) {
      if (!e.message.includes('Session closed.') && !e.message.includes('Target closed.'))
        throw e;
    }
  };

  let pkg = null;
  try {
    pkg = require(path.join(options.cwd, 'package.json'));
  } catch (e) {
  }
  const preloadJs = path.join(userDataDir, 'preload.js');
  await fsCopyFile(require.resolve('../ndb-inspect/preload.js'), preloadJs);

  const [searchBackend, fileSystemBackend] = await Promise.all([
    SearchBackend.create(app),
    FileSystem.create(app),
    NdbPreferences.create(app, options.configDir),
    app.exposeFunction('getProcessInfo', () => ({
      execPath: process.execPath,
      npmExecPath: process.execPath.replace(/node$/, 'npm').replace(/node\.exe$/, 'npm.cmd'),
      argv: options.argv,
      cwd: options.cwd,
      serviceDir: path.join(__dirname, '..', 'services'),
      repl: require.resolve('./repl.js'),
      pkg: pkg,
      preload: preloadJs,
      nddSharedStore: path.join(options.configDir, 'ndd_store')
    })),
    app.exposeFunction('openInNewTab', url => require('opn')(url)),
    app.exposeFunction('copyText', text => require('clipboardy').write(text)),
    app.exposeFunction('bringToFront', () => app.mainWindow().bringToFront()),
    app.exposeFunction('loadSourceMap', loadSourceMap)
  ]);
  fileSystemBackend.setSearchBackend(searchBackend);
  app.on('exit', cleanupAndExit);

  async function cleanupAndExit() {
    fileSystemBackend.dispose();
    if (!options.doNotProcessExit)
      process.exit(0);
  }

  const overridesFolder = options.debugFrontend
    ? path.dirname(require.resolve(`../front_end/${options.appName}.json`))
    : path.dirname(path.join(options.releaseFrontendFolder, `${options.appName}.js`));

  app.serveFolder(overridesFolder);
  app.serveFolder(path.join(__dirname, '..'));
  app.serveFolder(path.dirname(require.resolve(`chrome-devtools-frontend/front_end/ndb_app.json`)));

  await app.load(`${options.appName}.html?experiments=true&debugFrontend=${options.debugFrontend}`,
      rpc.handle({
        createService: async(fullName, ...args) => await rpc_process.spawn(fullName, {args: args})
      }));
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
    removeFolder.sync(userDataDir);
  });

  return userDataDir;
}

async function loadSourceMap(sourceMapURL, compiledURL) {
  try {
    let payload;
    if (sourceMapURL.startsWith('data:')) {
      const [metadata, ...other] = sourceMapURL.split(',');
      const urlPayload = other.join(',');
      const isBase64 = metadata.endsWith(';base64');
      payload = JSON.parse(Buffer.from(isBase64 ? urlPayload : querystring.unescape(urlPayload), isBase64 ? 'base64' : 'utf8').toString('utf8'));
    } else {
      const fileURL = new URL(sourceMapURL);
      const content = await fsReadFile(fileURL, 'utf8');
      payload = JSON.parse(content);
    }
    await removeSourceContentIfMatch(sourceMapURL, compiledURL, payload);
    return {payload};
  } catch (e) {
    return {error: e.stack};
  }
}

class StringStream extends Readable {
  constructor(str) {
    super();
    this._str = str;
    this._ended = false;
  }

  _read() {
    if (this._ended)
      return;
    this._ended = true;
    process.nextTick(_ => {
      this.push(Buffer.from(this._str, 'utf8'));
      this.push(null);
    });
  }
}

async function removeSourceContentIfMatch(sourceMapURL, compiledURL, payload) {
  const {sourcesContent, sources} = payload;
  if (!sourcesContent || !sources)
    return;
  for (let i = 0; i < sources.length; ++i) {
    if (!sources[i] || !sourcesContent[i]) continue;
    let url = sources[i];
    if (!path.isAbsolute(url))
      url = path.join(path.dirname(compiledURL), url);
    if (!fs.existsSync(url))
      continue;
    const sourceContentStream = new StringStream(sourcesContent[i]);
    const sourceContentLines = await readLines(sourceContentStream);
    const fileStream = fs.createReadStream(url);
    const fileStreamLines = await readLines(fileStream);
    if (sourceContentLines.length === fileStreamLines.length) {
      let equal = true;
      for (let i = 0; i < sourceContentLines.length; ++i) {
        if (sourceContentLines[i] !== fileStreamLines[i]) {
          equal = false;
          break;
        }
      }
      if (equal)
        sourcesContent[i] = undefined;
    }
  }
}

async function readLines(stream) {
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });
  return new Promise(resolve => {
    stream.once('error', _ => resolve(null));
    const lines = [];
    rl.on('line', line => lines.push(line));
    rl.on('close', _ => resolve(lines));
  });
}

module.exports = {launch};
