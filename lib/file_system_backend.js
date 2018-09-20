/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const util = require('util');

const mime = require('mime');
// TODO: migrate to service.
// TODO: process infinite symbolic links.
// TODO: at least cwd per process.
// TODO: what to do when link is not found.
// TODO: on each scriptParsed if script is not loaded yet, add its folder.
// TODO: how deep to traverse added folder?
class FileSystem {
  constructor() {
    this._fileSystems = new Map();
    this._watchers = new Map();
  }

  setSearchBackend(searchBackend) {
    this._searchBackend = searchBackend;
  }

  dispose() {
    for (const [,{watcher}] of this._fileSystems)
      watcher.close();
    this._fileSystems.clear();
  }

  static async create(frontend) {
    const backend = new FileSystem();
    await backend._expose(frontend);
    return backend;
  }

  _expose(page) {
    return Promise.all([
      page.exposeFunction('registerFileSystem', this._registerFileSystem.bind(this, (changed, added, removed) => {
        page.safeEvaluate((changed, added, removed) => {
          callFrontend(_ => {
            if (self.InspectorFrontendAPI)
              self.InspectorFrontendAPI.fileSystemFilesChangedAddedRemoved(changed, added, removed);
          });
        }, changed, added, removed);
      })),
      page.exposeFunction('fileSystemGetEntry', this._fileSystemGetEntry.bind(this)),
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

  _registerFileSystem(notify, name, root) {
    const watcher = chokidar.watch([root], {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      },
      depth: 0,
      ignorePermissionErrors: true
    });
    watcher.on('error', console.error);
    watcher.on('all', (event, name) => {
      if (this._searchBackend)
        this._searchBackend.addFile(name);
      if (event === 'add' || event === 'addDir')
        notify([], [name], []);
      else if (event === 'change')
        notify([name], [], []);
      else if (event === 'unlink' || event === 'unlinkDir')
        notify([], [], [name]);
    });
    this._fileSystems.set(name, {root, watcher });
  }

  async _fileSystemGetEntry(name, fullPath, options, isDirectory) {
    const {root: fsPath} = this._fileSystems.get(name);
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
    const fsPath = this._fileSystems.get(name).root;
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
    const {root: fsPath, watcher} = this._fileSystems.get(name);
    if (!fsPath)
      return {error: FileSystemError.fileSystemNotFound()};
    const absolutePath = path.join(fsPath, ...fullPath.slice(1).split('/'));
    watcher.add(absolutePath);
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
    return { entries };
  }

  async _fileSystemEntryGetMetadata(name, fullPath) {
    const fsPath = this._fileSystems.get(name).root;
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
    const fsPath = this._fileSystems.get(name).root;
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
    const fsPath = this._fileSystems.get(name).root;
    if (!fsPath)
      return {error: FileSystemError.fileSystemNotFound()};
    const absolutePath = path.join(fsPath, ...fullPath.slice(1).split('/'));
    const stream = fs.createReadStream(absolutePath, {encoding: 'base64'});
    stream.once('open', () => notify(readerId, 'open', mime.getType(absolutePath)));
    stream.once('error', () => notify(readerId, 'error'));
    stream.once('close', () => notify(readerId, 'close'));
    stream.once('end', () => notify(readerId, 'end'));
    stream.on('readable', _ => {
      const data = stream.read();
      if (data)
        notify(readerId, 'data', data);
    });
  }

  async _fileSystemWriteFile(name, fullPath, content) {
    const fsPath = this._fileSystems.get(name).root;
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
    const fsPath = this._fileSystems.get(name).root;
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
