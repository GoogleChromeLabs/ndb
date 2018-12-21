/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const { rpc, rpc_process } = require('carlo/rpc');
const chokidar = require('chokidar');
const fs = require('fs');
const { URL, fileURLToPath } = require('url');

function urlToPlatformPath(fileURL) {
  if (fileURLToPath)
    return fileURLToPath(fileURL);
  if (process.platform === 'win32')
    return fileURL.substr('file:///'.length).replace(/\//g, '\\');
  return fileURL.substr('file://'.length);
}

class FileSystemHandler {
  constructor() {
    require('../lib/process_utility.js')('file_system', () => this.dispose());
    this._watcher = null;
  }
  /**
   * @param {string} fileURL
   * @param {string} excludePattern
   */
  async filePaths(fileURL, excludePattern) {
    let excludeRegex = null;
    try {
      excludeRegex = new RegExp(excludePattern);
    } catch (e) {
    }
    const fileURLBase = new URL(fileURL);
    const fileURLBaseLength = fileURLBase.href.length;
    const queue = [fileURLBase];
    const visited = new Set();

    const filePaths = new Set();
    const gitFolders = new Set();
    const excludedFolders = new Set();

    while (queue.length) {
      // Get a chance to terminate process if needed.
      if (visited.size % 5000 === 0)
        await new Promise(resolve => setTimeout(resolve, 0));
      const url = queue.shift();

      let stat;
      let realPath;
      try {
        stat = fs.lstatSync(url);
        realPath = stat.isSymbolicLink() ? fs.realpathSync(url) : urlToPlatformPath(url.toString());
      } catch (e) {
        continue;
      }
      if (visited.has(realPath)) continue;
      visited.add(realPath);

      if (stat.isDirectory()) {
        const names = fs.readdirSync(url);
        const urlString = url.toString();
        if (this._watcher) this._watcher.add(realPath);
        names.forEach(name => {
          if (name === '.git') gitFolders.add(urlString.substr(fileURLBaseLength + 1));
          const fileName = urlString + '/' + name;
          if (excludeRegex && excludeRegex.test(fileName.substr(fileURLBaseLength) + '/'))
            excludedFolders.add(fileName.substr(fileURLBaseLength + 1));
          else
            queue.push(new URL(fileName));
        });
      } else if (stat.isFile()) {
        const urlString = url.toString();
        if (excludeRegex && excludeRegex.test(urlString)) continue;
        filePaths.add(urlString.substr(fileURLBaseLength + 1));
      }
    }
    return {
      excludedFolder: Array.from(excludedFolders),
      gitFolders: Array.from(gitFolders),
      filePaths: Array.from(filePaths)
    };
  }

  /**
   * @param {string} fileURL
   * @param {string} encoding
   */
  readFile(fileURL, encoding) {
    return fs.readFileSync(new URL(fileURL), encoding);
  }

  /**
   * @param {string} fileURL
   * @param {string} content
   * @param {string} encoding
   */
  writeFile(fileURL, content, encoding) {
    if (encoding === 'base64')
      content = Buffer.from(content, 'base64');
    fs.writeFileSync(new URL(fileURL), content, {encoding: encoding});
  }

  /**
   * @param {string} folderURL
   */
  createFile(folderURL) {
    let name = 'NewFile';
    let counter = 1;
    while (fs.existsSync(new URL(folderURL + '/' + name))) {
      name = 'NewFile' + counter;
      ++counter;
    }
    fs.writeFileSync(new URL(folderURL + '/' + name), '');
    return folderURL + '/' + name;
  }

  /**
   * @param {string} fileURL
   */
  deleteFile(fileURL) {
    try {
      fs.unlinkSync(new URL(fileURL));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {string} fileURL
   * @param {string} newName
   */
  renameFile(fileURL, newName) {
    const newURL = new URL(fileURL.substr(0, fileURL.lastIndexOf('/') + 1) + newName);
    try {
      if (fs.existsSync(newURL)) return false;
      fs.renameSync(new URL(fileURL), newURL);
      return true;
    } catch (e) {
      return false;
    }
  }

  startWatcher(embedderPath, client) {
    const watcher = chokidar.watch([embedderPath], {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 500
      },
      depth: 0,
      ignorePermissionErrors: true
    });
    watcher.on('error', error => 0);
    const SUBSCRIPTION = new Set(['add', 'change', 'unlink']);
    const events = [];
    let timer = null;
    watcher.on('all', (event, name) => {
      if (SUBSCRIPTION.has(event)) {
        if (!timer)
          timer = setTimeout(filesChanged, 100);
        events.push({
          type: event,
          name: name
        });
      }
      if (event === 'addDir')
        watcher.add(name);
    });
    this._watcher = watcher;

    function filesChanged() {
      client.filesChanged(events.splice(0));
      timer = null;
    }
  }

  dispose() {
    this._watcher.close();
    Promise.resolve().then(() => process.exit(0));
  }
}

rpc_process.init(args => rpc.handle(new FileSystemHandler()));
