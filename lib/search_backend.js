/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const fs = require('fs');
const path = require('path');

const isbinaryfile = require('isbinaryfile');
// TODO: migrate to service.
class SearchBackend {
  constructor(frontend) {
    this._frontend = frontend;
    this._activeIndexing = new Set();
    this._index = new Map();
    this._filesQueue = new Set();

    this._lastFileNameIndex = 0;
    this._indexToFileName = new Map();
    this._fileNameToIndex = new Map();
  }

  static async create(frontend) {
    const backend = new SearchBackend(frontend);
    await Promise.all([
      frontend.exposeFunction('indexPath', backend.indexPath.bind(backend)),
      frontend.exposeFunction('stopIndexing', backend.stopIndexing.bind(backend)),
      frontend.exposeFunction('searchInPath', backend.searchInPath.bind(backend))
    ]);
    return backend;
  }

  /**
   * @param {number} requestId
   * @param {string} fileSystemPath
   */
  async indexPath(requestId, fileSystemPath) {
    if (this._index.has(fileSystemPath)) {
      this._indexChangedFiles(requestId, fileSystemPath);
      return;
    }
    this._activeIndexing.add(requestId);
    const index = new Map();
    const directories = [fileSystemPath];
    const allFiles = [];
    while (directories.length) {
      if (!this._activeIndexing.has(requestId))
        return;
      const directory = directories.shift();
      await new Promise(done => fs.readdir(directory, 'utf8', async(err, files) => {
        if (err) {
          done();
          return;
        }
        files = files.filter(file => !file.startsWith('.'));
        files = files.map(file => path.join(directory, file));
        await Promise.all(files.map(file => new Promise(done => fs.stat(file, (err, stats) => {
          if (err) {
            done();
            return;
          }
          if (stats.isDirectory() && file !== 'node_modules')
            directories.push(file);
          if (stats.isFile())
            allFiles.push(file);
          done();
        }))));
        done();
      }));
    }

    const textFiles = [];
    for (const file of allFiles) {
      if (file.endsWith('.js') || file.endsWith('.json'))
        textFiles.push(file);
      else if (!await new Promise(resolve => isbinaryfile(file, (err, isBinary) => resolve(err || isBinary))))
        textFiles.push(file);
    }
    this.indexingTotalWorkCalculated(requestId, fileSystemPath, textFiles.length);
    for (const fileName of textFiles) {
      if (!this._activeIndexing.has(requestId))
        return;
      await this._indexFile(fileName, index);
      this.indexingWorked(requestId, fileSystemPath, 1);
    }
    this._index.set(fileSystemPath, index);
    this.indexingDone(requestId, fileSystemPath);
    this._activeIndexing.delete(requestId);
  }

  /**
   * @param {string} fileName
   * @param {!Map<string,!Set<string>>} index
   * @return {!Promise}
   */
  _indexFile(fileName, index) {
    const stream = fs.createReadStream(fileName, {encoding: 'utf8'});
    return new Promise(done => {
      let prev = '';
      const trigrams = new Set();
      stream.on('error', finished.bind(this));
      stream.on('data', chunk => {
        chunk = prev + chunk;
        chunk = chunk.toLowerCase();
        while (chunk.length > 3) {
          trigrams.add(chunk.substring(0, 3));
          chunk = chunk.substring(1);
        }
        prev = chunk;
      });
      stream.on('end', finished.bind(this));

      function finished() {
        let fileNameIndex;
        if (this._fileNameToIndex.has(fileName)) {
          fileNameIndex = this._fileNameToIndex.get(fileName);
        } else {
          fileNameIndex = ++this._lastFileNameIndex;
          this._indexToFileName.set(fileNameIndex, fileName);
          this._fileNameToIndex.set(fileName, fileNameIndex);
        }
        for (const trigram of trigrams) {
          let values = index.get(trigram);
          if (!values) {
            values = new Set();
            index.set(trigram, values);
          }
          values.add(fileNameIndex);
        }
        done();
      }
    }).then(() => stream.close());
  }

  /**
   * @param {number} requestId
   * @param {string} fileSystemPath
   */
  async _indexChangedFiles(requestId, fileSystemPath) {
    if (!this._filesQueue.size) {
      this.indexingDone(requestId);
      return;
    }
    this._activeIndexing.add(requestId);

    const allFiles = Array.from(this._filesQueue);
    this._filesQueue.clear();

    const textFiles = [];
    for (const file of allFiles) {
      if (file.endsWith('.js') || file.endsWith('.json'))
        textFiles.push(file);
      else if (!await new Promise(resolve => isbinaryfile(file, (err, isBinary) => resolve(err || isBinary))))
        textFiles.push(file);
    }

    this.indexingTotalWorkCalculated(requestId, textFiles.length);
    const index = this._index.get(fileSystemPath);
    while (textFiles.length) {
      if (!this._activeIndexing.has(requestId)) {
        for (const fileName of textFiles)
          this._filesQueue.add(fileName);
        return;
      }
      const fileName = textFiles.shift();
      await this._indexFile(fileName, index);
      this.indexingWorked(requestId, 1);
    }
    this._activeIndexing.delete(requestId);
    this.indexingDone(requestId);
  }

  /**
   * @param {number} requestId
   */
  stopIndexing(requestId) {
    this._activeIndexing.delete(requestId);
  }

  /**
   * @param {number} requestId
   * @param {string} fileSystemPath
   * @param {string} query
   */
  searchInPath(requestId, fileSystemPath, query) {
    const index = this._index.get(fileSystemPath);
    let result = [];
    query = query.toLowerCase();
    if (index && query.length === 0) {
      result = Array.from(new Set(index.values()));
    } else if (index && query.length > 2) {
      let resultSet = index.get(query.substring(0, 3)) || new Set();
      for (let i = 1; i < query.length - 2; ++i) {
        const trigram = query.substring(i, i + 3);
        const current = index.get(trigram) || new Set();
        const nextCurrent = new Set();
        for (const file of current) {
          if (resultSet.has(file))
            nextCurrent.add(file);
        }
        resultSet = nextCurrent;
      }
      result = Array.from(resultSet);
    }
    result = result.map(index => this._indexToFileName.get(index));
    this.searchCompleted(requestId, fileSystemPath, result);
  }

  /**
   * @param {number} requestId
   * @param {string} fileSystemPath
   * @param {number} totalWork
   */
  indexingTotalWorkCalculated(requestId, fileSystemPath, totalWork) {
    this._frontend.safeEvaluate((requestId, fileSystemPath, totalWork) => {
      callFrontend(_ => InspectorFrontendAPI.indexingTotalWorkCalculated(requestId, fileSystemPath, totalWork));
    }, requestId, fileSystemPath, totalWork);
  }

  /**
   * @param {number} requestId
   * @param {string} fileSystemPath
   * @param {number} worked
   */
  indexingWorked(requestId, fileSystemPath, worked) {
    this._frontend.safeEvaluate((requestId, fileSystemPath, worked) => {
      callFrontend(_ => InspectorFrontendAPI.indexingWorked(requestId, fileSystemPath, worked));
    }, requestId, fileSystemPath, worked);
  }

  /**
   * @param {number} requestId
   * @param {string} fileSystemPath
   */
  indexingDone(requestId, fileSystemPath) {
    this._frontend.safeEvaluate((requestId, fileSystemPath) => {
      callFrontend(_ => InspectorFrontendAPI.indexingDone(requestId, fileSystemPath));
    }, requestId, fileSystemPath);
  }

  /**
   * @param {number} requestId
   * @param {string} fileSystemPath
   * @param {!Array.<string>} files
   */
  searchCompleted(requestId, fileSystemPath, files) {
    this._frontend.safeEvaluate((requestId, fileSystemPath, files) => {
      callFrontend(_ => InspectorFrontendAPI.searchCompleted(requestId, fileSystemPath, files));
    }, requestId, fileSystemPath, files);
  }

  /**
   * @param {string} fileName
   */
  addFile(fileName) {
    this._filesQueue.add(fileName);
  }
}

module.exports = {SearchBackend};
