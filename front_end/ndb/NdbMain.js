/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

Ndb.nodeExecPath = function() {
  if (!Ndb._nodeExecPathPromise)
    Ndb._nodeExecPathPromise = Ndb.backend.which('node').then(result => result.resolvedPath);
  return Ndb._nodeExecPathPromise;
};

Ndb.processInfo = function() {
  if (!Ndb._processInfoPromise)
    Ndb._processInfoPromise = Ndb.backend.processInfo();
  return Ndb._processInfoPromise;
};

/**
 * @implements {Common.Runnable}
 */
Ndb.NdbMain = class extends Common.Object {
  /**
   * @override
   */
  async run() {
    InspectorFrontendAPI.setUseSoftMenu(true);
    document.title = 'ndb';
    Common.moduleSetting('blackboxInternalScripts').addChangeListener(Ndb.NdbMain._calculateBlackboxState);
    Ndb.NdbMain._calculateBlackboxState();

    const setting = Persistence.isolatedFileSystemManager.workspaceFolderExcludePatternSetting();
    setting.set(Ndb.NdbMain._defaultExcludePattern().join('|'));
    Ndb.nodeProcessManager = new Ndb.NodeProcessManager(SDK.targetManager);
    this._addDefaultFileSystem();

    await new Promise(resolve => SDK.initMainConnection(resolve));
    // Create root Main target.
    SDK.targetManager.createTarget('<root>', ls`Root`, SDK.Target.Type.Browser, null);

    this._repl();

    if (Common.moduleSetting('autoStartMain').get()) {
      const main = await Ndb.mainConfiguration();
      if (main)
        Ndb.nodeProcessManager.debug(main.execPath, main.args);
    }
  }

  async _addDefaultFileSystem() {
    const info = await Ndb.processInfo();
    await Ndb.nodeProcessManager.addFileSystem(info.cwd);
  }

  async _repl() {
    const code = btoa(`console.log('Welcome to the ndb %cR%cE%cP%cL%c!',
      'color:#8bc34a', 'color:#ffc107', 'color:#ff5722', 'color:#2196f3', 'color:inherit');
      process.title = 'ndb/repl';
      setInterval(_ => 0, 2147483647)//# sourceURL=repl.js`);
    const args = ['-e', `eval(Buffer.from('${code}', 'base64').toString())`];
    const options = { ignoreOutput: true, data: 'ndb/repl' };
    const node = await Ndb.nodeExecPath();
    for (;;)
      await Ndb.nodeProcessManager.debug(node, args, options);
  }

  static _defaultExcludePattern() {
    const defaultCommonExcludedFolders = [
      '/bower_components/', '/\\.devtools', '/\\.git/', '/\\.sass-cache/', '/\\.hg/', '/\\.idea/',
      '/\\.svn/', '/\\.cache/', '/\\.project/'
    ];
    const defaultWinExcludedFolders = ['/Thumbs.db$', '/ehthumbs.db$', '/Desktop.ini$', '/\\$RECYCLE.BIN/'];
    const defaultMacExcludedFolders = [
      '/\\.DS_Store$', '/\\.Trashes$', '/\\.Spotlight-V100$', '/\\.AppleDouble$', '/\\.LSOverride$', '/Icon$',
      '/\\._.*$'
    ];
    const defaultLinuxExcludedFolders = ['/.*~$'];
    let defaultExcludedFolders = defaultCommonExcludedFolders;
    if (Host.isWin())
      defaultExcludedFolders = defaultExcludedFolders.concat(defaultWinExcludedFolders);
    else if (Host.isMac())
      defaultExcludedFolders = defaultExcludedFolders.concat(defaultMacExcludedFolders);
    else
      defaultExcludedFolders = defaultExcludedFolders.concat(defaultLinuxExcludedFolders);
    return defaultExcludedFolders;
  }

  static _calculateBlackboxState() {
    const blackboxInternalScripts = Common.moduleSetting('blackboxInternalScripts').get();
    const PATTERN = '^internal[\\/].*';
    const regexPatterns = Common.moduleSetting('skipStackFramesPattern').getAsArray()
        .filter(({pattern}) => pattern !== PATTERN && pattern !== '^internal/.*');
    if (blackboxInternalScripts)
      regexPatterns.push({pattern: PATTERN });
    Common.moduleSetting('skipStackFramesPattern').setAsArray(regexPatterns);
  }
};

Ndb.mainConfiguration = async() => {
  const info = await Ndb.processInfo();
  const cmd = info.argv.slice(2);
  if (cmd.length === 0 || cmd[0] === '.')
    return null;
  let execPath;
  let args;
  if (cmd[0].endsWith('.js')
    || cmd[0].endsWith('.mjs')
    || cmd[0].startsWith('-')) {
    execPath = await Ndb.nodeExecPath();
    args = cmd;
  } else {
    execPath = cmd[0];
    args = cmd.slice(1);
  }
  return {
    name: 'main',
    command: cmd.join(' '),
    execPath,
    args
  };
};

/**
 * @implements {UI.ContextMenu.Provider}
 * @unrestricted
 */
Ndb.ContextMenuProvider = class {
  /**
   * @override
   * @param {!Event} event
   * @param {!UI.ContextMenu} contextMenu
   * @param {!Object} object
   */
  appendApplicableItems(event, contextMenu, object) {
    if (!(object instanceof Workspace.UISourceCode))
      return;
    const url = object.url();
    if (!url.startsWith('file://') || (!url.endsWith('.js') && !url.endsWith('.mjs')))
      return;
    contextMenu.debugSection().appendItem(ls`Run this script`, async() => {
      const platformPath = Common.ParsedURL.urlToPlatformPath(url, Host.isWin());
      const args = url.endsWith('.mjs') ? ['--experimental-modules', platformPath] : [platformPath];
      Ndb.nodeProcessManager.debug(await Ndb.nodeExecPath(), args);
    });
  }
};

Ndb.NodeProcessManager = class extends Common.Object {
  constructor(targetManager) {
    super();
    this._servicePromise = null;
    this._processes = new Map();
    this._lastDebugId = 0;
    this._lastStarted = null;
    this._targetManager = targetManager;
    this._cwds = new Map();
    this._targetManager.addModelListener(
        SDK.RuntimeModel, SDK.RuntimeModel.Events.ExecutionContextDestroyed, this._onExecutionContextDestroyed, this);
  }

  async nddStore() {
    const service = await this._service();
    return service.nddStore();
  }

  infoForTarget(target) {
    return this._processes.get(target.id()) || null;
  }

  async addFileSystem(cwd) {
    let promise = this._cwds.get(cwd);
    if (!promise) {
      async function innerAdd() {
        const cwdUrl = Common.ParsedURL.platformPathToURL(cwd);
        const fileSystemManager = Persistence.isolatedFileSystemManager;
        fileSystemManager.addPlatformFileSystem(cwdUrl, await Ndb.FileSystem.create(fileSystemManager, cwd, cwdUrl));
      }
      promise = innerAdd();
      this._cwds.set(cwd, promise);
    }
    return promise;
  }

  async detected(payload) {
    const pid = payload.id;
    const processInfo = new Ndb.ProcessInfo(payload);
    this._processes.set(pid, processInfo);

    await this.addFileSystem(processInfo.cwd());
    const parentTarget = (payload.ppid ? this._targetManager.targetById(payload.ppid) || this._targetManager.mainTarget() : this._targetManager.mainTarget());
    const target = this._targetManager.createTarget(
        pid, processInfo.userFriendlyName(), SDK.Target.Type.Node,
        parentTarget, pid);
    if (!processInfo.isRepl() && shouldPauseAtStart(payload.argv)) {
      target.runtimeAgent().invoke_evaluate({
        expression: `process.breakAtStart && process.breakAtStart()`,
        includeCommandLineAPI: true
      });
    }
    return target.runtimeAgent().runIfWaitingForDebugger();

    function shouldPauseAtStart(argv) {
      if (argv.find(arg => arg.endsWith('ndb/inspect-brk')))
        return true;
      if (!Common.moduleSetting('pauseAtStart').get())
        return false;
      const [_, arg] = argv;
      if (arg && (arg.endsWith('/bin/npm') || arg.endsWith('\\bin\\npm') ||
          arg.endsWith('/bin/yarn') || arg.endsWith('\\bin\\yarn') ||
          arg.endsWith('/bin/npm-cli.js') || arg.endsWith('\\bin\\npm-cli.js')))
        return false;
      return true;
    }
  }

  disconnected(sessionId) {
    this._processes.delete(sessionId);
    const target = this._targetManager.targetById(sessionId);
    if (target)
      this._targetManager.removeTarget(target);
  }

  dispatchMessage(message) {
    if (this._processes.has(message.sessionId)) {
      InspectorFrontendHost.events.dispatchEventToListeners(
          InspectorFrontendHostAPI.Events.DispatchMessage,
          message);
    }
  }

  async _sendMesage(message) {
    const service = await this._service();
    return service.sendMessage(message);
  }

  _service() {
    if (!this._servicePromise) {
      async function service() {
        const service = await Ndb.backend.createService('ndd_service.js');
        await service.init(rpc.handle(this));
        InspectorFrontendHost.sendMessageToBackend = this._sendMesage.bind(this);
        return service;
      }
      this._servicePromise = service.call(this);
    }
    return this._servicePromise;
  }

  async _onExecutionContextDestroyed(event) {
    const executionContext = event.data;
    const mainContextId = 1;
    if (executionContext.id !== mainContextId)
      return;
    const target = executionContext.target();
    if (target.suspended()) {
      const debuggerModel = target.model(SDK.DebuggerModel);
      await new Promise(resolve => debuggerModel.addEventListener(
          SDK.DebuggerModel.Events.DebuggerWasEnabled, resolve));
    }
    const service = await this._service();
    service.disconnect(target.id());
  }

  async debug(execPath, args, options) {
    options = options || {};
    const service = await this._service();
    const debugId = options.data || String(++this._lastDebugId);
    this._lastStarted = {execPath, args, debugId};
    const info = await Ndb.processInfo();
    return service.debug(
        execPath, args, {
          ...options,
          data: debugId,
          cwd: info.cwd,
        });
  }

  async kill(target) {
    const service = await this._service();
    return service.kill(target.id());
  }

  async restartLast() {
    if (!this._lastStarted)
      return;
    const promises = [];
    for (const target of SDK.targetManager.targets()) {
      const info = this.infoForTarget(target);
      if (!info)
        continue;
      if (info.data() === this._lastStarted.debugId)
        promises.push(this.kill(target));
    }
    await Promise.all(promises);
    const {execPath, args} = this._lastStarted;
    await this.debug(execPath, args);
  }
};

Ndb.ProcessInfo = class {
  constructor(payload) {
    this._argv = payload.argv;
    this._cwd = payload.cwd;
    this._data = payload.data;
    this._isRepl = payload.data === 'ndb/repl';
  }

  argv() {
    return this._argv;
  }

  data() {
    return this._data;
  }

  cwd() {
    return this._cwd;
  }

  userFriendlyName() {
    if (this._isRepl)
      return 'repl';
    return this.argv().map(arg => {
      const index1 = arg.lastIndexOf('/');
      const index2 = arg.lastIndexOf('\\');
      if (index1 === -1 && index2 === -1)
        return arg;
      return arg.slice(Math.max(index1, index2) + 1);
    }).join(' ');
  }

  isRepl() {
    return this._isRepl;
  }
};

/**
 * @implements {UI.ActionDelegate}
 * @unrestricted
 */
Ndb.RestartActionDelegate = class {
  /**
   * @override
   * @param {!UI.Context} context
   * @param {string} actionId
   * @return {boolean}
   */
  handleAction(context, actionId) {
    switch (actionId) {
      case 'ndb.restart':
        Ndb.nodeProcessManager.restartLast();
        return true;
    }
    return false;
  }
};

// Temporary hack until frontend with fix is rolled.
// fix: TBA.
SDK.Target.prototype.decorateLabel = function(label) {
  return this.name();
};

// Front-end does not respect modern toggle semantics, patch it.
const originalToggle = DOMTokenList.prototype.toggle;
DOMTokenList.prototype.toggle = function(token, force) {
  if (arguments.length === 1)
    force = !this.contains(token);
  return originalToggle.call(this, token, !!force);
};

/**
 * @param {string} sourceURL
 * @param {string} modulePrefix
 * @param {SDK.DebuggerModel} debuggerModel
 * @return {!Promise<boolean>}
 */
async function isNodeWrappedModule(sourceURL, modulePrefix, debuggerModel) {
  for (const script of debuggerModel.scripts()) {
    if (script.sourceURL === sourceURL) {
      const content = await script.originalContentProvider().requestContent();
      return content.startsWith(modulePrefix);
    }
  }

  return false;
}

/**
 * @param {string} sourceMapURL
 * @param {string} compiledURL
 * @return {!Promise<?SDK.TextSourceMap>}
 * @this {SDK.TextSourceMap}
 */
SDK.TextSourceMap.load = async function(sourceMapURL, compiledURL) {
  const {payload, error} = await Ndb.backend.loadSourceMap(sourceMapURL, compiledURL);
  if (error || !payload)
    return null;

  let textSourceMap;
  try {
    textSourceMap = new SDK.TextSourceMap(compiledURL, sourceMapURL, payload);
  } catch (e) {
    console.error(e);
    Common.console.warn('DevTools failed to parse SourceMap: ' + sourceMapURL);
    return null;
  }

  if (textSourceMap._baseURL.startsWith('file://')) {
    try {
      const modulePrefix = await Ndb.backend.getNodeScriptPrefix();
      const debuggerModel = Array.from(Bindings.debuggerWorkspaceBinding._debuggerModelToData.keys())[1];
      if (await isNodeWrappedModule(compiledURL, modulePrefix, debuggerModel))
        for (const mapping of textSourceMap.mappings()) mapping.columnNumber += modulePrefix.length;
    } catch (e) {
      console.error(e);
      Common.console.warn('DevTools failed to fix SourceMap for node script: ' + sourceMapURL);
      // return the source map anyways.
    }
  }

  return textSourceMap;
};
