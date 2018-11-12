/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

(function(){
  Runtime.backendPromise = new Promise(resolve => self.load = backend => {
    delete self.load;
    resolve(backend);
  });
  const servicePromise = getProcessInfo().then(info =>
    Runtime.backendPromise.then(backend => backend.createService(info.serviceDir + '/inspector_frontend_host.js', info.configDir)));

  InspectorFrontendHost.isHostedMode = _ => false;
  InspectorFrontendHost.copyText = text => servicePromise.then(service => service.copyText(String(text)));
  InspectorFrontendHost.openInNewTab = url => servicePromise.then(service => service.openInNewTab(url));
  InspectorFrontendHost.isolatedFileSystem = name => new self.FileSystem(name);
  InspectorFrontendHost.getPreferences = f => {
    const threads = runtime._extensions.find(e => e._descriptor.className === 'Sources.ThreadsSidebarPane');
    threads._descriptor.className = 'UI.Widget';
    threads._descriptor.title = 'Node processes';
    servicePromise.then(service => service.getPreferences().then(f));
  };
  InspectorFrontendHost.setPreference = (name, value) => servicePromise.then(service => service.setPreference(name, value));
  InspectorFrontendHost.removePreference = name => servicePromise.then(service => service.removePreference(name));
  InspectorFrontendHost.clearPreferences = () => servicePromise.then(service => service.clearPreferences());
  InspectorFrontendHost.bringToFront = bringToFront;

  class SearchClient {
    /**
     * @param {number} requestId
     * @param {string} fileSystemPath
     * @param {number} totalWork
     */
    indexingTotalWorkCalculated(requestId, fileSystemPath, totalWork) {
      callFrontend(() => InspectorFrontendAPI.indexingTotalWorkCalculated(requestId, fileSystemPath, totalWork));
    }

    /**
     * @param {number} requestId
     * @param {string} fileSystemPath
     * @param {number} worked
     */
    indexingWorked(requestId, fileSystemPath, worked) {
      callFrontend(() => InspectorFrontendAPI.indexingWorked(requestId, fileSystemPath, worked));
    }

    /**
     * @param {number} requestId
     * @param {string} fileSystemPath
     */
    indexingDone(requestId, fileSystemPath) {
      callFrontend(_ => InspectorFrontendAPI.indexingDone(requestId, fileSystemPath));
    }

    /**
     * @param {number} requestId
     * @param {string} fileSystemPath
     * @param {!Array.<string>} files
     */
    searchCompleted(requestId, fileSystemPath, files) {
      callFrontend(_ => InspectorFrontendAPI.searchCompleted(requestId, fileSystemPath, files));
    }
  }

  Runtime.searchServicePromise = getProcessInfo().then(info =>
    Runtime.backendPromise.then(backend => backend.createService(info.serviceDir + '/search.js', rpc.handle(new SearchClient()))));

  InspectorFrontendHost.indexPath = (...args) => Runtime.searchServicePromise.then(search => search.indexPath(...args));
  InspectorFrontendHost.stopIndexing = (...args) => Runtime.searchServicePromise.then(search => search.stopIndexing(...args));
  InspectorFrontendHost.searchInPath = (...args) => Runtime.searchServicePromise.then(search => search.searchInPath(...args));

  Common.Settings.prototype._storageFromType = function(storageType) {
    switch (storageType) {
      case (Common.SettingStorageType.Local):
        return this._globalStorage;
      case (Common.SettingStorageType.Session):
        return this._sessionStorage;
      case (Common.SettingStorageType.Global):
        return this._globalStorage;
    }
    return this._globalStorage;
  };
})();
