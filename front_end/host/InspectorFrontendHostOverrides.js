/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

(function(){
  InspectorFrontendHost.isHostedMode = _ => false;
  InspectorFrontendHost.copyText = copyText;
  InspectorFrontendHost.openInNewTab = openInNewTab;
  InspectorFrontendHost.indexPath = indexPath;
  InspectorFrontendHost.stopIndexing = stopIndexing;
  InspectorFrontendHost.searchInPath = searchInPath;
  InspectorFrontendHost.isolatedFileSystem = name => new self.FileSystem(name);
  InspectorFrontendHost.getPreferences = f => getPreferences().then(p => f(p));
  InspectorFrontendHost.setPreference = setPreference;
  InspectorFrontendHost.removePreference = removePreference;
  InspectorFrontendHost.clearPreferences = clearPreferences;

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
