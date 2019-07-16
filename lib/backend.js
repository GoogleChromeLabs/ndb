/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const { rpc_process } = require('carlo/rpc');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const util = require('util');
const { URL } = require('url');
const { Readable } = require('stream');
const opn = require('opn');
const querystring = require('querystring');
const which = require('which');

const fsReadFile = util.promisify(fs.readFile);
const { fileURLToPath } = require('./filepath_to_url.js');

const MODULE_WRAP_PREFIX = (() => {
  const wrapped = require('module').wrap('☃');
  return wrapped.substring(0, wrapped.indexOf('☃'));
})();

class Backend {
  constructor(window) {
    this._window = window;
    this._info = JSON.parse(Buffer.from(window.paramsForReuse().data, 'base64').toString('utf8'));
    this._handles = [];
    this._window.on('close', () => this._handles.splice(0).forEach(handle => handle.dispose()));
  }

  async createService(name, ...args) {
    const fileName = path.join(__dirname, '..', 'services', name);
    const handle = await rpc_process.spawn(fileName, ...args);
    this._handles.push(handle);
    return handle;
  }

  bringToFront() {
    return this._window.bringToFront();
  }

  /**
   * @param {text} url
   */
  openInNewTab(url) {
    opn(url);
  }

  pkg() {
    // TODO(ak239spb): implement it as decorations over package.json file.
    try {
      return require(path.join(fileURLToPath(this._info.cwd), 'package.json'));
    } catch (e) {
      return null;
    }
  }

  async loadSourceMap(sourceMapURL, compiledURL) {
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

  getNodeScriptPrefix() {
    return MODULE_WRAP_PREFIX;
  }

  which(command) {
    return new Promise(resolve => which(command, (error, resolvedPath) => resolve({
      resolvedPath: resolvedPath,
      error: error ? error.message : null
    })));
  }

  processInfo() {
    return this._info;
  }

  writeTerminalData(stream, data) {
    const buffer = Buffer.from(data, 'base64');
    if (stream === 'stderr')
      process.stderr.write(buffer);
    else if (stream === 'stdout')
      process.stdout.write(buffer);
  }

  fileURLToPath(url) {
    return fileURLToPath(url);
  }

  async loadNetworkResource(url, headers) {
    try {
      if (url.startsWith('file://')) {
        const fileURL = new URL(url);
        return await fsReadFile(fileURL, 'utf8');
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }
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

module.exports = { Backend };
