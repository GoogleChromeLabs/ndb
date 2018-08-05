/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

Ndb._FakeDebuggerLocation = class {
  constructor(sourceURL, lineNumber, columnNumber) {
    this.debuggerModel = {getPossibleBreakpoints: _ => []};
    this.lineNumber = lineNumber;
    this.columnNumber = columnNumber;
    this.script = _ => ({sourceURL});
  }
};

Ndb.FileSystemMapping = class {
  constructor() {
    this._sourceMapManager = new SDK.SourceMapManager({
      inspectedURL: _ => Common.ParsedURL.platformPathToURL(NdbProcessInfo.cwd)
    });
    this._sourceMapManager.addEventListener(
        SDK.SourceMapManager.Events.SourceMapAttached, this._sourceMapAttached, this);

    this._sourceUrlToSourceMap = new Map();
    this._compiledUrlToSourceMap = new Map();
  }

  sourceMapDetected(fileName, sourceMappingUrl) {
    const fileUrl = Common.ParsedURL.platformPathToURL(fileName);
    this._sourceMapManager.attachSourceMap({}, fileUrl, sourceMappingUrl);
  }

  _sourceMapAttached(event) {
    const sourceMap = /** @type {!SDK.SourceMap} */ (event.data.sourceMap);
    for (const sourceUrl of sourceMap.sourceURLs())
      this._sourceUrlToSourceMap.set(sourceUrl, sourceMap);
    this._compiledUrlToSourceMap.set(sourceMap.compiledURL(), sourceMap);
  }

  /**
   * @param {!SDK.DebuggerModel.Location} rawLocation
   * @return {?Workspace.UILocation}
   */
  rawLocationToUILocation(rawLocation) {
    const script = rawLocation.script();
    const sourceMap = script ? this._compiledUrlToSourceMap.get(script.sourceURL) : null;
    if (sourceMap) {
      const entry = sourceMap.findEntry(rawLocation.lineNumber, rawLocation.columnNumber);
      if (entry) {
        const fileSystemProjects = Workspace.workspace.projectsForType('filesystem');
        for (const fileSystemProject of fileSystemProjects) {
          const uiSourceCode = fileSystemProject.uiSourceCodeForURL(entry.sourceURL);
          if (uiSourceCode) {
            const networkUISourceCode = Persistence.persistence.network(uiSourceCode);
            if (networkUISourceCode)
              return null;
            return uiSourceCode.uiLocation(entry.sourceLineNumber, entry.sourceColumnNumber);
          }
        }
      }
    }
    return null;
  }

  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   * @param {number} lineNumber
   * @param {number} columnNumber
   * @return {?SDK.DebuggerModel.Location}
   */
  uiLocationToRawLocation(uiSourceCode, lineNumber, columnNumber) {
    const url = uiSourceCode.url();
    const sourceMap = this._sourceUrlToSourceMap.get(url);
    if (sourceMap) {
      const entry = sourceMap.sourceLineMapping(url, lineNumber, columnNumber);
      if (entry)
        return new Ndb._FakeDebuggerLocation(sourceMap.compiledURL(), entry.lineNumber, entry.columnNumber);
    }
    return null;
  }
};

/** @type {!Ndb.FileSystemMapping} */
Ndb.fileSystemMapping;
