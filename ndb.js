#!/usr/bin/env node
/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const {Writable} = require('stream');
const removeFolder = require('rimraf');
const {URL} = require('url');
const util = require('util');

const {Services} = require('./services/services.js');
const {FileSystem} = require('./lib/file_system_backend.js');
const {SearchBackend} = require('./lib/search_backend.js');

const fsCopyFile = util.promisify(fs.copyFile);
const fsReadFile = util.promisify(fs.readFile);
const fsMkdir = util.promisify(fs.mkdir);
const fsMkdtemp = util.promisify(fs.mkdtemp);
const fsWriteFile = util.promisify(fs.writeFile);

const updateNotifier = require('update-notifier');
// Tell user if there's a newer version of ndb.
updateNotifier({pkg: require('./package.json')}).notify();

(async function main() {
  const configDir = path.join(os.homedir(), '.ndb');
  // TODO: remove prepare/restore process streams as soon as we roll pptr with proper fix.
  prepareProcessStreams();
  const browser = await puppeteer.launch({
    appMode: true,
    dumpio: true,
    userDataDir: await setupUserDataDir(configDir),
    args: [
      '--app=data:text/html,<style>html{background:#242424;}</style>',
      '--enable-features=NetworkService',
      '--no-sandbox'
    ]
  });
  restoreProcessStreams();

  const [frontend] = await browser.pages();
  frontend._client.send('Emulation.setDefaultBackgroundColorOverride',
      {color: {r: 0x24, g: 0x24, b: 0x24, a: 0xff}});
  frontend.on('close', browser.close.bind(browser));
  frontend.safeEvaluate = async(...args) => {
    try {
      return await frontend.evaluate(...args);
    } catch (e) {
      if (!e.message.includes('Session closed.'))
        throw e;
    }
  };

  const [searchBackend, fileSystemBackend] = await Promise.all([
    SearchBackend.create(frontend),
    FileSystem.create(frontend),
    Services.create(frontend),
    NdbPreferences.create(frontend, configDir),
    frontend.evaluateOnNewDocument(`NdbProcessInfo = ${JSON.stringify({
      execPath: process.execPath,
      argv: process.argv,
      execArgv: process.execArgv,
      argv0: process.argv0,
      cwd: process.cwd(),
      platform: process.platform,
      title: process.title,
      serviceDir: path.join(__dirname, 'services'),
      repl: require.resolve('./lib/repl.js')
    })};`),
    frontend.setRequestInterception(true),
    frontend.exposeFunction('openInNewTab', url => require('opn')(url)),
    frontend.exposeFunction('copyText', text => require('clipboardy').write(text))
  ]);
  fileSystemBackend.setSearchBackend(searchBackend);
  const overridesFolder = process.env.NDB_DEBUG_FRONTEND
    ? path.dirname(require.resolve('./front_end/ndb_app.json'))
    : path.dirname(require.resolve('./.local-frontend/ndb_app.js'));
  frontend.on('request', requestIntercepted.bind(null, overridesFolder));

  await frontend.goto('https://ndb/ndb_app.html?experiments=true');
  await frontend.bringToFront();
})();

function redirectPipe(stdStream, devnull, src) {
  src.unpipe(stdStream);
  src.pipe(devnull);
}

function prepareProcessStreams() {
  const devnull = new Writable({
    write(chunk, encoding, callback) {
      callback();
    }
  });
  process.stderr.on('pipe', redirectPipe.bind(null, process.stderr, devnull));
  process.stdout.on('pipe', redirectPipe.bind(null, process.stdout, devnull));
}

function restoreProcessStreams() {
  process.stderr.removeAllListeners('pipe');
  process.stdout.removeAllListeners('pipe');
}

async function setupUserDataDir(configDirectory) {
  if (!fs.existsSync(configDirectory))
    await fsMkdir(configDirectory);

  const chromiumPreferencesFile = path.join(configDirectory, 'ChromiumPreferences');
  if (!fs.existsSync(chromiumPreferencesFile))
    await fsWriteFile(chromiumPreferencesFile, '{}', 'utf8');

  const userDataDir = await fsMkdtemp(path.join(os.tmpdir(), 'ndb-'));
  const defaultUserDir = path.join(userDataDir, 'Default');
  await fsMkdir(defaultUserDir);

  const preferencesFile = path.join(defaultUserDir, 'Preferences');
  await fsCopyFile(chromiumPreferencesFile, preferencesFile);

  process.on('exit', _ => {
    fs.copyFileSync(preferencesFile, chromiumPreferencesFile);
    removeFolder.sync(userDataDir);
  });

  return userDataDir;
}

class NdbPreferences {
  static async create(frontend, configDir) {
    const preferencesFile = path.join(configDir, 'Preferences');
    const current = await NdbPreferences._read(preferencesFile);
    const preferences = new NdbPreferences(preferencesFile, current);
    await Promise.all([
      preferences._sync(),
      frontend.exposeFunction('getPreferences', _ => NdbPreferences._read(preferencesFile)),
      frontend.exposeFunction('setPreference', preferences._setPreference.bind(preferences)),
      frontend.exposeFunction('removePreference', preferences._removePreference.bind(preferences)),
      frontend.exposeFunction('clearPreferences', preferences._clearPreferences.bind(preferences)),
      frontend.evaluateOnNewDocument(`NdbPreferences = ${JSON.stringify(current)}`)
    ]);
  }

  /**
   * @param {string} preferencesFile
   * @param {!Object} current
   * @return {!Promise}
   */
  constructor(preferencesFile, current) {
    this._file = preferencesFile;
    this._current = current;
  }

  /**
   * @param {string} name
   * @param {string} value
   * @return {!Promise}
   */
  _setPreference(name, value) {
    this._current[name] = value;
    return this._sync();
  }

  /**
   * @param {string} name
   * @return {!Promise}
   */
  _removePreference(name) {
    delete this._current[name];
    return this._sync();
  }

  /**
   * @return {!Promise}
   */
  async _clearPreferences() {
    this._current = await NdbPreferences._read(undefined, true);
    return this._sync();
  }

  /**
   * @return {!Promise}
   */
  async _sync() {
    await fsWriteFile(this._file, JSON.stringify(this._current), 'utf8');
  }

  /**
   * @param {string} fileName
   * @return {!Object}
   */
  static async _read(fileName, forceDefault) {
    try {
      const content = !forceDefault && fs.existsSync(fileName)
        ? await fsReadFile(fileName, 'utf8')
        : await fsReadFile(path.join(__dirname, 'DefaultPreferences'));
      return JSON.parse(content);
    } catch (e) {
      return {};
    }
  }
}

async function requestIntercepted(overridesFolder, interceptedRequest) {
  const {pathname} = new URL(interceptedRequest.url());
  let fileName = pathname.startsWith('/node_modules/')
    ? path.join(__dirname, pathname)
    : path.join(overridesFolder, pathname);
  if (!fs.existsSync(fileName))
    fileName = require.resolve(`chrome-devtools-frontend/front_end${pathname}`);
  const buffer = await fsReadFile(fileName);
  interceptedRequest.respond({
    status: 200,
    body: buffer
  });
}
