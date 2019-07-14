/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

Ndb.FileSystem = class extends Persistence.PlatformFileSystem {
  constructor(fsService, fsIOService, searchService, manager, rootURL) {
    super(rootURL, '');
    this._fsService = fsService;
    this._fsIOService = fsIOService;
    this._searchService = searchService;
    this._rootURL = rootURL;
    this._manager = manager;

    /** @type {!Array<string>} */
    this._initialFilePaths = [];
  }

  static async create(manager, rootURL) {
    const searchClient = new Ndb.FileSystem.SearchClient();
    const [fsService, fsIOService, searchService] = await Promise.all([
      Ndb.backend.createService('file_system.js'),
      Ndb.backend.createService('file_system_io.js'),
      Ndb.backend.createService('search.js', rpc.handle(searchClient))]);

    // TODO: fix PlatformFileSystem upstream, entire search / indexing pipeline should go
    // through the platform filesystem. This should make searchClient also go away.
    InspectorFrontendHost.stopIndexing = searchService.stopIndexing.bind(searchService);

    const fs = new Ndb.FileSystem(fsService, fsIOService, searchService, manager, rootURL);
    await fs._initFilePaths();
    return fs;
  }

  /**
   * @override
   * @return {string}
   */
  embedderPath() {
    throw new Error('Not implemented');
  }

  /**
   * @override
   * @return {!Promise}
   */
  async _initFilePaths() {
    await this._fsService.startWatcher(this._rootURL, this._excludePattern(), rpc.handle(this));
  }

  forceFileLoad(scriptName) {
    return this._fsService.forceFileLoad(scriptName);
  }

  /**
   * @override
   * @return {!Array<string>}
   */
  initialFilePaths() {
    return this._initialFilePaths;
  }

  /**
   * @override
   * @return {!Array<string>}
   */
  initialGitFolders() {
    return [];
  }

  /**
   * @override
   * @param {string} path
   * @return {!Promise<?{modificationTime: !Date, size: number}>}
   */
  getMetadata(path) {
    // This method should never be called as long as we are matching using file urls.
    throw new Error('not implemented');
  }

  /**
   * @override
   * @param {string} path
   * @return {!Promise<?Blob>}
   */
  requestFileBlob(path) {
    throw new Error('not implemented');
  }

  /**
   * @override
   * @param {string} path
   * @param {function(?string,boolean)} callback
   */
  async requestFileContent(path, callback) {
    const result = await this._fsIOService.readFile(this._rootURL + path, 'base64');
    if (this.contentType(path) === Common.resourceTypes.Image) {
      callback(result, true);
    } else {
      const content = await(await fetch(`data:application/octet-stream;base64,${result}`)).text();
      callback(content, false);
    }
  }

  /**
   * @override
   * @param {string} path
   * @param {string} content
   * @param {boolean} isBase64
   */
  async setFileContent(path, content, isBase64) {
    await this._fsIOService.writeFile(this._rootURL + path, isBase64 ? content : content.toBase64(), 'base64');
  }

  /**
   * @override
   * @param {string} path
   * @param {?string} name
   * @return {!Promise<?string>}
   */
  async createFile(path, name) {
    const result = await this._fsIOService.createFile(this._rootURL + (path.length === 0 || path.startsWith('/') ? '' : '/') + path);
    return result.substr(this._rootURL.length + 1);
  }

  /**
   * @override
   * @param {string} path
   * @return {!Promise<boolean>}
   */
  async deleteFile(path) {
    return await this._fsIOService.deleteFile(this._rootURL + path);
  }

  /**
   * @override
   * @param {string} path
   * @param {string} newName
   * @param {function(boolean, string=)} callback
   */
  async renameFile(path, newName, callback) {
    const result = await this._fsIOService.renameFile(this._rootURL + path, newName);
    callback(result, result ? newName : null);
  }

  /**
   * @override
   * @param {string} path
   * @return {!Common.ResourceType}
   */
  contentType(path) {
    const extension = Common.ParsedURL.extractExtension(path);
    if (Persistence.IsolatedFileSystem._styleSheetExtensions.has(extension))
      return Common.resourceTypes.Stylesheet;
    if (Persistence.IsolatedFileSystem._documentExtensions.has(extension))
      return Common.resourceTypes.Document;
    if (Persistence.IsolatedFileSystem.ImageExtensions.has(extension))
      return Common.resourceTypes.Image;
    if (Persistence.IsolatedFileSystem._scriptExtensions.has(extension))
      return Common.resourceTypes.Script;
    return Persistence.IsolatedFileSystem.BinaryExtensions.has(extension) ? Common.resourceTypes.Other :
      Common.resourceTypes.Document;
  }

  /**
   * @override
   * @param {string} path
   * @return {string}
   */
  mimeFromPath(path) {
    return Common.ResourceType.mimeFromURL(path) || 'text/plain';
  }

  /**
   * @override
   * @param {string} path
   * @return {boolean}
   */
  canExcludeFolder(path) {
    return !!path ;
  }

  /**
   * @override
   * @param {string} url
   * @return {string}
   */
  tooltipForURL(url) {
    const path = Common.ParsedURL.urlToPlatformPath(url, Host.isWin()).trimMiddle(150);
    return ls`Linked to ${path}`;
  }

  /**
   * @override
   * @param {string} query
   * @param {!Common.Progress} progress
   * @return {!Promise<!Array<string>>}
   */
  searchInPath(query, progress) {
    return new Promise(resolve => {
      const requestId = this._manager.registerCallback(innerCallback);
      this._searchService.searchInPath(requestId, this._rootURL, query);

      /**
       * @param {!Array<string>} files
       */
      function innerCallback(files) {
        resolve(files);
        progress.worked(1);
      }
    });
  }

  /**
   * @param {string} name
   */
  filesChanged(events) {
    for (const event of events) {
      const paths = new Multimap();
      paths.set(this._rootURL, event.name);
      const emptyMap = new Multimap();
      Persistence.isolatedFileSystemManager.dispatchEventToListeners(Persistence.IsolatedFileSystemManager.Events.FileSystemFilesChanged, {
        changed: event.type === 'change' ? paths : emptyMap,
        added: event.type === 'add' ? paths : emptyMap,
        removed: event.type === 'unlink' ? paths : emptyMap
      });
    }
  }

  /**
   * @override
   * @param {!Common.Progress} progress
   */
  indexContent(progress) {
    progress.setTotalWork(1);
    const requestId = this._manager.registerProgress(progress);
    this._searchService.indexPath(requestId, this._rootURL, this._excludePattern());
  }

  /**
   * @override
   * @return {boolean}
   */
  supportsAutomapping() {
    return true;
  }

  /**
   * @return {string}
   */
  _excludePattern() {
    return this._manager.workspaceFolderExcludePatternSetting().get();
  }
};

Ndb.FileSystem.SearchClient = class {
  /**
   * @param {number} requestId
   * @param {string} fileSystemPath
   * @param {number} totalWork
   */
  indexingTotalWorkCalculated(requestId, fileSystemPath, totalWork) {
    this._callFrontend(() => InspectorFrontendAPI.indexingTotalWorkCalculated(requestId, fileSystemPath, totalWork));
  }

  /**
   * @param {number} requestId
   * @param {string} fileSystemPath
   * @param {number} worked
   */
  indexingWorked(requestId, fileSystemPath, worked) {
    this._callFrontend(() => InspectorFrontendAPI.indexingWorked(requestId, fileSystemPath, worked));
  }

  /**
   * @param {number} requestId
   * @param {string} fileSystemPath
   */
  indexingDone(requestId, fileSystemPath) {
    this._callFrontend(_ => InspectorFrontendAPI.indexingDone(requestId, fileSystemPath));
  }

  /**
   * @param {number} requestId
   * @param {string} fileSystemPath
   * @param {!Array.<string>} files
   */
  searchCompleted(requestId, fileSystemPath, files) {
    this._callFrontend(_ => InspectorFrontendAPI.searchCompleted(requestId, fileSystemPath, files));
  }

  _callFrontend(f) {
    if (Runtime.queryParam('debugFrontend'))
      setTimeout(f, 0);
    else
      f();
  }
};
