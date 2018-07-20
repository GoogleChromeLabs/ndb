/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

self.FileSystem = class {
  constructor(name) {
    this.name = name;
    this.root = new FileSystemEntry(this, '/', true, false, '');
    this._lastReaderId = 0;
  }

  static onReaderEvent(id, event, ...args) {
    const reader = FileSystem._readers.get(id);
    if (!reader)
      return;
    reader[event].call(reader, ...args);
  }

  _nextReaderId() {
    return `${this.name}:${++this._lastReaderId}`;
  }
};

FileSystem._readers = new Map();

class FileSystemEntry {
  constructor(filesystem, fullPath, isDirectory) {
    this.filesystem = filesystem;
    this.fullPath = fullPath;
    this.isDirectory = isDirectory;
    this.isFile = !isDirectory;
    const path = fullPath.split('/');
    this.name = path[path.length - 1];
  }

  serializeForTest() {
    return {
      fullPath: this.fullPath,
      isDirectory: this.isDirectory,
      isFile: this.isFile,
      name: this.name
    };
  }

  getMetadata(successCallback, errorCallback) {
    if (!this.isFile) {
      errorCallback(FileError.notImplementedError());
      return;
    }
    fileSystemEntryGetMetadata(this.filesystem.name, this.fullPath)
        .then(({error, mtime, size}) => {
          if (error) {
            errorCallback(error);
          } else {
            successCallback({
              modificationTime: new Date(mtime),
              size: size
            });
          }
        });
  }

  getParent(successCallback, errorCallback) {
    if (this.fullPath === '/')
      return this;
    const path = this.fullPath.split('/');
    const fullPath = path.slice(0, path.length - 1).join('/');
    successCallback(new FileSystemEntry(this.filesystem, fullPath || '/', true));
  }

  moveTo(newParent, newName, successCallback, errorCallback) {
    if (!newParent.isDirectory) {
      errorCallback(FileError.invalidModificationError());
      return;
    }
    const newFullPath = `${newParent.fullPath}/${newName}`;
    fileSystemEntryMoveTo(this.filesystem.name, this.fullPath, newFullPath)
        .then(({error}) => {
          if (error)
            errorCallback(error);
          else
            successCallback(new FileSystemEntry(this.filesystem, newFullPath, this.isDirectory));
        });
  }

  remove(successCallback, errorCallback) {
    fileSystemEntryRemove(this.filesystem.name, this.fullPath, this.isDirectory)
        .then(({error}) => {
          if (error)
            errorCallback(error);
          else
            successCallback();
        });
  }

  // --- FileSystemFileEntry --------------------------------

  file(successCallback, errorCallback) {
    const readerId = this.filesystem._nextReaderId();
    let mimeType;
    const promises = [];
    const reader = {
      onopen: type => mimeType = type,
      onend: async _ => {
        FileSystem._readers.delete(readerId);
        successCallback(new Blob(await Promise.all(promises)));
      },
      ondata: data => promises.push(fetch(`data:${mimeType};base64,${data}`).then(response => response.blob())),
      onerror: _ => {
        FileSystem._readers.delete(readerId);
        errorCallback(FileError.invalidModificationError());
      },
      onclose: _ => {
        FileSystem._readers.delete(readerId);
        errorCallback(FileError.invalidModificationError());
      }
    };
    FileSystem._readers.set(readerId, reader);
    fileSystemEntryFile(this.filesystem.name, this.fullPath, readerId);
  }

  createWriter(successCallback, errorCallback) {
    const entry = this;
    const writer = {
      write(blob) {
        const reader = new FileReader();
        reader.onloadend = _ =>
          fileSystemWriteFile(entry.filesystem.name, entry.fullPath, reader.result)
              .then(writer.onwriteend);
        reader.readAsDataURL(blob);
      },

      truncate(num) {
        fileSystemTruncateFile(entry.filesystem.name, entry.fullPath, num)
            .then(writer.onwriteend);
      }
    };
    successCallback(writer);
  }

  // ---  FileSystemDirectoryEntry ---------------------------------------

  createReader() {
    return new FileSystemDirectoryReader(this);
  }

  getDirectory(path, options, successCallback, errorCallback) {
    this._getEntry(path, options, true, successCallback, errorCallback);
  }

  getFile(path, options, successCallback, errorCallback) {
    this._getEntry(path, options, false, successCallback, errorCallback);
  }

  _getEntry(path, options, isDirectory, successCallback, errorCallback) {
    const fullPath = this._fullPath(path);
    self.fileSystemGetEntry(this.filesystem.name, fullPath, options, isDirectory)
        .then(({error}) => {
          if (error)
            errorCallback(error);
          else
            successCallback(new FileSystemEntry(this.filesystem, fullPath, isDirectory));
        });
  }

  _fullPath(path) {
    return `${this.fullPath}/${path}`.replace('//', '/');
  }
}

class FileSystemDirectoryReader {
  constructor(entry) {
    this._entry = entry;
    this._done = false;
  }

  readEntries(successCallback, errorCallback) {
    if (this._done) {
      successCallback([]);
      return;
    }
    this._done = true;
    fileSystemDirectoryReaderReadEntries(this._entry.filesystem.name, this._entry.fullPath)
        .then(({error, entries}) => {
          if (error)
            errorCallback(error);
          else
            successCallback(entries.map(entry => new FileSystemEntry(this._entry.filesystem, this._entry._fullPath(entry.name), entry.isDirectory)));
        });
  }
}

class FileError {
  constructor(name, message) {
    this.name = name;
    this.message = message;
  }

  static invalidModificationError() {
    return new FileError('InvalidModificationError', 'The object can not be modified in this way.');
  }

  static notFoundError() {
    return new FileError('NotFoundError', 'An attempt was made to reference a Node in a context where it does not exist.');
  }

  static notImplementedError() {
    return new FileError('NotImplementedError', 'This method is not implemented');
  }
}
