/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

const mime = require('mime');
// TODO: migrate to service.
class FileSystem {
  constructor(onSourceMapDetected) {
    this._fileSystems = new Map();
    this._watchers = new Map();

    this._onSourceMapDetected = onSourceMapDetected;
  }

  setSearchBackend(searchBackend) {
    this._searchBackend = searchBackend;
  }

  static async create(frontend) {
    const backend = new FileSystem((fsPath, fileName, sourceMappingUrl) => {
      frontend.safeEvaluate((fsPath, fileName, sourceMappingUrl) => {
        callFrontend(_ => Ndb.sourceMapManager._sourceMapDetected(fsPath, fileName, sourceMappingUrl));
      }, fsPath, fileName, sourceMappingUrl);
    });
    await backend._expose(frontend);
    return backend;
  }

  _expose(page) {
    return Promise.all([
      page.exposeFunction('registerFileSystem', this._registerFileSystem.bind(this)),
      page.exposeFunction('fileSystemGetEntry', this._fileSystemGetEntry.bind(this, (changed, added, removed) => {
        page.safeEvaluate((changed, added, removed) => {
          callFrontend(_ => {
            if (self.InspectorFrontendAPI)
              self.InspectorFrontendAPI.fileSystemFilesChangedAddedRemoved(changed, added, removed);
          });
        }, changed, added, removed);
      })),
      page.exposeFunction('fileSystemDirectoryReaderReadEntries', this._fileSystemDirectoryReaderReadEntries.bind(this)),
      page.exposeFunction('fileSystemEntryGetMetadata', this._fileSystemEntryGetMetadata.bind(this)),
      page.exposeFunction('fileSystemEntryRemove', this._fileSystemEntryRemove.bind(this)),
      page.exposeFunction('fileSystemEntryMoveTo', this._fileSystemEntryMoveTo.bind(this)),
      page.exposeFunction('fileSystemEntryFile', this._fileSystemEntryFile.bind(this, (readerId, event, ...args) => {
        page.safeEvaluate(function(readerId, event, ...args) {
          callFrontend(_ => {
            const reader = FileSystem._readers.get(readerId);
            if (reader)
              reader[`on${event}`](...args);
          });
        }, readerId, event, ...args);
      })),
      page.exposeFunction('fileSystemWriteFile', this._fileSystemWriteFile.bind(this)),
      page.exposeFunction('fileSystemTruncateFile', this._fileSystemTruncateFile.bind(this))
    ]);
  }

  _registerFileSystem(name, path) {
    this._fileSystems.set(name, path);
  }

  async _fileSystemGetEntry(notify, name, fullPath, options, isDirectory) {
    const fsPath = this._fileSystems.get(name);
    if (!fsPath)
      return {error: FileSystemError.fileSystemNotFound()};
    const absolutePath = path.join(fsPath, ...fullPath.slice(1).split('/'));
    const {stat, error} = await util.promisify(fs.stat)(absolutePath)
        .then(x => ({stat: x}))
        .catch(e => ({error: e}));
    if (error && error.code !== 'ENOENT')
      return {error: FileSystemError.internalError()};
    options = options || {};
    if (options.create) {
      const pathExists = !error;
      if (options.exclusive) {
        if (pathExists)
          return {error: FileSystemError.pathExistsError()};
        else
          return await this._createEntry(absolutePath, isDirectory);
      } else {
        if (pathExists) {
          if (isDirectory) {
            const {error} = await util.promisify(fs.rmdir)(absolutePath).catch(error => ({error}));
            if (error)
              return {error: FileSystemError.internalError()};
          }
          return await this._createEntry(absolutePath, isDirectory);
        } else {
          return await this._createEntry(absolutePath, isDirectory);
        }
      }
    }
    if (error || (isDirectory && !stat.isDirectory()) || (!isDirectory && !stat.isFile()))
      return {error: FileSystemError.notFoundError()};
    if (isDirectory)
      this._startWatcherIfNeeded(notify, absolutePath);
    return {};
  }

  async _createEntry(absolutePath, isDirectory) {
    const createFunction = isDirectory
      ? util.promisify(fs.mkdir)
      : absolutePath => util.promisify(fs.writeFile)(absolutePath, '');
    const {error} = await createFunction(absolutePath)
        .then(x => ({}))
        .catch(error => ({error}));
    if (error)
      return {error: FileSystemError.internalError()};
    else
      return {};
  }

  async _fileSystemEntryRemove(name, fullPath, isDirectory) {
    const fsPath = this._fileSystems.get(name);
    if (!fsPath)
      return {error: FileSystemError.fileSystemNotFound()};
    const absolutePath = path.join(fsPath, ...fullPath.slice(1).split('/'));
    let result;
    if (isDirectory)
      result = await util.promisify(fs.rmdir)(absolutePath).catch(error => ({error}));
    else
      result = await util.promisify(fs.unlink)(absolutePath).catch(error => ({error}));
    if (result && result.error)
      return {error: FileSystemError.internalError()};
    return {};
  }

  async _fileSystemDirectoryReaderReadEntries(name, fullPath) {
    const fsPath = this._fileSystems.get(name);
    if (!fsPath)
      return {error: FileSystemError.fileSystemNotFound()};
    const absolutePath = path.join(fsPath, ...fullPath.slice(1).split('/'));
    const {names, error} = await util.promisify(fs.readdir)(absolutePath, {encoding: 'utf8'})
        .then(x => ({names: x}))
        .catch(e => ({error: e}));
    if (error)
      return {error: FileSystemError.notFoundError()};
    let entries = await Promise.all(names.map(name => util.promisify(fs.stat)(path.join(absolutePath, name))
        .then(x => ({stat: x, name: name}))
        .catch(e => ({error: e}))));
    entries = entries.filter(x => !x.error && (x.stat.isDirectory() || x.stat.isFile()))
        .map(x => ({name: x.name, isDirectory: x.stat.isDirectory(), size: x.stat.size}));
    this._detectSourceMaps(fsPath, absolutePath, entries);
    return { entries };
  }

  async _detectSourceMaps(fsPath, absolutePath, entries) {
    const jsFiles = entries
        .filter(entry => !entry.isDirectory && entry.name.endsWith('.js'))
        .map(entry => ({
          name: path.join(absolutePath, entry.name),
          size: entry.size
        }));
    const sourceMappingUrl = /\/\/# sourceMappingURL=([^\s]+)/;
    for (const {name, size} of jsFiles) {
      const stream = fs.createReadStream(name, {
        encoding: 'utf8',
        autoClose: true,
        start: size - 1024
      });
      let data = '';
      let resolveCallback;
      const promise = new Promise(resolve => resolveCallback = resolve);
      stream.on('end', _ => resolveCallback(data));
      stream.on('error', _ => resolveCallback(''));
      stream.on('data', chunk => data += chunk);
      const content = await promise;
      const match = content.match(sourceMappingUrl);
      if (match)
        this._onSourceMapDetected(fsPath, name, match[1]);
    }
  }

  async _fileSystemEntryGetMetadata(name, fullPath) {
    const fsPath = this._fileSystems.get(name);
    if (!fsPath)
      return {error: FileSystemError.fileSystemNotFound()};
    const absolutePath = path.join(fsPath, ...fullPath.slice(1).split('/'));
    const stat = await util.promisify(fs.stat)(absolutePath);
    return {
      mtime: stat.mtime,
      size: stat.size
    };
  }

  async _fileSystemEntryMoveTo(name, fullPath, newFullPath) {
    const fsPath = this._fileSystems.get(name);
    if (!fsPath)
      return {error: FileSystemError.fileSystemNotFound()};
    const oldAbsolutePath = path.join(fsPath, ...fullPath.slice(1).split('/'));
    const newAbsolutePath = path.join(fsPath, ...newFullPath.slice(1).split('/'));
    const result = await util.promisify(fs.rename)(oldAbsolutePath, newAbsolutePath)
        .then(x => ({}))
        .catch(e => ({error: e}));
    if (result && result.error)
      return {error: FileSystemError.notFoundError()};
    return {};
  }

  async _fileSystemEntryFile(notify, name, fullPath, readerId) {
    const fsPath = this._fileSystems.get(name);
    if (!fsPath)
      return {error: FileSystemError.fileSystemNotFound()};
    const absolutePath = path.join(fsPath, ...fullPath.slice(1).split('/'));
    const stream = fs.createReadStream(absolutePath, {encoding: 'base64'});
    stream.on('error', () => notify(readerId, 'error'));
    stream.on('data', chunk => notify(readerId, 'data', chunk));
    stream.on('close', () => notify(readerId, 'close'));
    stream.on('end', () => notify(readerId, 'end'));
    stream.on('open', () => notify(readerId, 'open', mime.getType(absolutePath)));
  }

  async _fileSystemWriteFile(name, fullPath, content) {
    const fsPath = this._fileSystems.get(name);
    if (!fsPath)
      return {error: FileSystemError.fileSystemNotFound()};
    const absolutePath = path.join(fsPath, ...fullPath.slice(1).split('/'));
    const buffer = Buffer.from(content.substr(content.indexOf('base64,') + 'base64,'.length), 'base64');
    const result = await util.promisify(fs.writeFile)(absolutePath, buffer)
        .then(x => ({}))
        .catch(e => ({error: e}));
    if (result && result.error)
      return {error: FileSystemError.internalError()};
    return {};
  }

  async _fileSystemTruncateFile(name, fullPath, size) {
    const fsPath = this._fileSystems.get(name);
    if (!fsPath)
      return {error: FileSystemError.fileSystemNotFound()};
    const absolutePath = path.join(fsPath, ...fullPath.slice(1).split('/'));
    const result = await util.promisify(fs.truncate)(absolutePath, size)
        .then(x => ({}))
        .catch(e => ({error: e}));
    if (result && result.error)
      return {error: FileSystemError.internalError()};
    return {};
  }

  _startWatcherIfNeeded(notify, absolutePath) {
    let watcher = this._watchers.get(absolutePath);
    if (watcher)
      return;
    watcher = fs.watch(absolutePath, {persistent: false, recursive: false, encoding: 'utf8'}, async(eventType, name) => {
      if (!name)
        return;
      const fullName = path.join(absolutePath, name);
      if (this._searchBackend)
        this._searchBackend.addFile(fullName);
      if (eventType === 'change') {
        notify([fullName], [], []);
      } else if (eventType === 'rename') {
        const {stats} = await util.promisify(fs.stat)(fullName)
            .then(x => ({stats: x}))
            .catch(e => ({}));
        if (stats)
          notify([], [fullName], []);
        else
          notify([], [], [fullName]);
      }
    });
    this._watchers.set(absolutePath, watcher);
  }
}

class FileSystemError {
  constructor(name, message) {
    this.name = name;
    this.message = message;
  }

  static fileSystemNotFound() {
    return new FileSystemError('FileSystemNotFound', 'File system with given name is not found');
  }

  static statError(message) {
    return new FileSystemError('StatError', message);
  }

  static notFoundError() {
    return new FileSystemError('NotFoundError', 'An attempt was made to reference a Node in a context where it does not exist.');
  }

  static pathExistsError() {
    return new FileSystemError('PathExistsError', 'An attempt was made to create a file or directory where an element already exists.');
  }

  static internalError() {
    return new FileSystemError('InternalError', 'Internal error');
  }
}

module.exports = {FileSystem};
