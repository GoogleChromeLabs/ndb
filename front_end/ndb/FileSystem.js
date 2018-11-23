/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

Ndb.FileSystem = class extends Persistence.PlatformFileSystem {
  constructor(manager, rootPath, rootURL) {
    super(rootURL, '');
    this._rootURL = rootURL;
    this._embedderPath = rootPath;
    this._manager = manager;

    /** @type {!Array<string>} */
    this._initialFilePaths = [];
    /** @type {!Array<string>} */
    this._initialGitFolders = [];
    /** @type {!Array<string>} */
    this._excludedFolders = [];

    this._servicePromise = null;
  }

  static async create(manager, rootPath, rootURL) {
    const fs = new Ndb.FileSystem(manager, rootPath, rootURL);
    await fs._initFilePaths();
    return fs;
  }

  /**
   * @override
   * @return {string}
   */
  embedderPath() {
    return this._embedderPath;
  }

  /**
   * @override
   * @return {!Promise}
   */
  async _initFilePaths() {
    const excludePattern = this._manager.workspaceFolderExcludePatternSetting().get();
    const service = await this._service();
    await service.startWatcher(this._embedderPath, rpc.handle(this));
    const result = await service.filePaths(this._rootURL, excludePattern);
    this._initialFilePaths = result.filePaths;
    this._initialGitFolders = result.gitFolders;
    this._excludedFolders = result.excludedFolders;
  }

  /**
   * @return {!Promise}
   */
  async _service() {
    if (!this._servicePromise)
      this._servicePromise = Ndb.backend.createService('file_system.js');
    return this._servicePromise;
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
    return this._initialGitFolders;
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
    const result = await (await this._service()).readFile(this._rootURL + path, 'base64');
    const content = await(await fetch(`data:application/octet-stream;base64,${result}`)).text();
    callback(content, false);
  }

  /**
   * @override
   * @param {string} path
   * @param {string} content
   * @param {boolean} isBase64
   */
  async setFileContent(path, content, isBase64) {
    await (await this._service()).writeFile(this._rootURL + path, isBase64 ? content : content.toBase64(), 'base64');
  }

  /**
   * @override
   * @param {string} path
   * @param {?string} name
   * @return {!Promise<?string>}
   */
  async createFile(path, name) {
    // TODO(ak239): we should decide where to do substr here or on backend side.
    const result = await (await this._service()).createFile(this._rootURL + (path.length === 0 || path.startsWith('/') ? '' : '/') + path);
    return result.substr(this._rootURL.length + 1);
  }

  /**
   * @override
   * @param {string} path
   * @return {!Promise<boolean>}
   */
  async deleteFile(path) {
    return await (await this._service()).deleteFile(this._rootURL + path);
  }

  /**
   * @override
   * @param {string} path
   * @param {string} newName
   * @param {function(boolean, string=)} callback
   */
  async renameFile(path, newName, callback) {
    const result = await (await this._service()).renameFile(this._rootURL + path, newName);
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
      InspectorFrontendHost.searchInPath(requestId, this._embedderPath, query);

      /**
       * @param {!Array<string>} files
       */
      function innerCallback(files) {
        resolve(files.map(path => Common.ParsedURL.platformPathToURL(path)));
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
      paths.set(this._rootURL, Common.ParsedURL.platformPathToURL(event.name));
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
    InspectorFrontendHost.indexPath(requestId, this._embedderPath, JSON.stringify(this._excludedFolders));
  }

  /**
   * @override
   * @return {boolean}
   */
  supportsAutomapping() {
    return true;
  }
};
