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
    Ndb.nodeProcessManager = await Ndb.NodeProcessManager.create(SDK.targetManager);

    const {cwd} = await Ndb.processInfo();
    await Ndb.nodeProcessManager.addFileSystem(cwd);

    await new Promise(resolve => SDK.initMainConnection(resolve));
    // Create root Main target.
    SDK.targetManager.createTarget('<root>', ls`Root`, SDK.Target.Type.Browser, null);

    if (Common.moduleSetting('autoStartMain').get()) {
      const main = await Ndb.mainConfiguration();
      if (main) {
        if (main.prof)
          await Ndb.nodeProcessManager.profile(main.execPath, main.args);
        else
          Ndb.nodeProcessManager.debug(main.execPath, main.args);
      }
    }
    this._repl();
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
    const PATTERN = '^internal[\\/].*|bin/npm-cli\.js$|bin/yarn\.js$';
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
  let prof = false;
  if (cmd[0] === '--prof') {
    prof = true;
    cmd.shift();
  }
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
    args,
    prof
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
  constructor(targetManager, service) {
    super();
    this._service = service;
    this._processes = new Map();
    this._lastDebugId = 0;
    this._lastStarted = null;
    this._targetManager = targetManager;
    this._cwds = new Map();
    this._isProfiling = false;
    this._cpuProfiles = [];
    this._targetManager.addModelListener(
        SDK.RuntimeModel, SDK.RuntimeModel.Events.ExecutionContextDestroyed, this._onExecutionContextDestroyed, this);
    InspectorFrontendHost.sendMessageToBackend = this._sendMesage.bind(this);
  }

  static async create(targetManager) {
    const service = await Ndb.backend.createService('ndd_service.js');
    const manager = new Ndb.NodeProcessManager(targetManager, service);
    await service.init(rpc.handle(manager));
    return manager;
  }

  async nddStore() {
    return this._service.nddStore();
  }

  infoForTarget(target) {
    return this._processes.get(target.id()) || null;
  }

  /**
   * @param {string} cwd
   * @param {string=} mainFileName
   * @return {!Promise}
   */
  async addFileSystem(cwd, mainFileName) {
    let promise = this._cwds.get(cwd);
    if (!promise) {
      async function innerAdd() {
        const cwdUrl = Common.ParsedURL.platformPathToURL(cwd);
        const fileSystemManager = Persistence.isolatedFileSystemManager;
        const fs = await Ndb.FileSystem.create(fileSystemManager, cwd, cwdUrl, mainFileName);
        fileSystemManager.addPlatformFileSystem(cwdUrl, fs);
        return fs;
      }
      promise = innerAdd();
      this._cwds.set(cwd, promise);
    }
    if (mainFileName)
      await (await promise).forceFileLoad(mainFileName);
    await promise;
  }

  async detected(id, info) {
    let processInfoReceived;
    this._processes.set(id, new Promise(resolve => processInfoReceived = resolve));
    const processInfo = new Ndb.ProcessInfo(info);
    const target = this._targetManager.createTarget(
        id, processInfo.userFriendlyName(), SDK.Target.Type.Node,
        this._targetManager.mainTarget(), id);
    await this.addFileSystem(info.cwd, info.scriptName);
    if (info.scriptName) {
      const scriptURL = Common.ParsedURL.platformPathToURL(info.scriptName);
      const uiSourceCode = Workspace.workspace.uiSourceCodeForURL(scriptURL);
      const isBlackboxed = Bindings.blackboxManager.isBlackboxedURL(scriptURL, false);
      if (isBlackboxed) {
        await target.runtimeAgent().runIfWaitingForDebugger();
        return this._service.disconnect(target.id());
      }
      if (uiSourceCode) {
        if (Common.moduleSetting('pauseAtStart').get() && !isBlackboxed)
          Bindings.breakpointManager.setBreakpoint(uiSourceCode, 0, 0, '', true);
        else
          Common.Revealer.reveal(uiSourceCode);
      }
    }
    processInfoReceived(processInfo);
    return target.runtimeAgent().runIfWaitingForDebugger();
  }

  disconnected(sessionId) {
    this._processes.delete(sessionId);
    const target = this._targetManager.targetById(sessionId);
    if (target) {
      this._targetManager.removeTarget(target);
      target.dispose();
    }
  }

  dispatchMessage(message) {
    if (this._processes.has(message.sessionId)) {
      InspectorFrontendHost.events.dispatchEventToListeners(
          InspectorFrontendHostAPI.Events.DispatchMessage,
          message);
    }
  }

  async _sendMesage(message) {
    return this._service.sendMessage(message);
  }

  async _onExecutionContextDestroyed(event) {
    const executionContext = event.data;
    if (!executionContext.isDefault)
      return;
    const target = executionContext.target();
    if (this._isProfiling) {
      this._cpuProfiles.push({
        profile: await target.model(SDK.CPUProfilerModel).stopRecording(),
        name: target.name(),
        id: target.id()
      });
    }
    await this._service.disconnect(target.id());
  }

  async debug(execPath, args, options) {
    options = options || {};
    const debugId = options.data || String(++this._lastDebugId);
    if (!options.data)
      this._lastStarted = {execPath, args, debugId, isProfiling: this._isProfiling};

    const {cwd} = await Ndb.processInfo();
    return this._service.debug(
        execPath, args, {
          ...options,
          data: debugId,
          cwd: cwd,
        });
  }

  async profile(execPath, args, options) {
    await UI.viewManager.showView('timeline');
    const action = UI.actionRegistry.action('timeline.toggle-recording');
    await action.execute();
    this._isProfiling = true;
    await this.debug(execPath, args);
    this._isProfiling = false;
    this._cpuProfiles.push(...await Promise.all(SDK.targetManager.models(SDK.CPUProfilerModel).map(async profiler => ({
      profile: await profiler.stopRecording(),
      name: profiler.target().name(),
      id: profiler.target().id()
    }))));
    const controller = Timeline.TimelinePanel.instance()._controller;
    controller.traceEventsCollected([{
      cat: SDK.TracingModel.DevToolsMetadataEventCategory,
      name: TimelineModel.TimelineModel.DevToolsMetadataEvent.TracingStartedInPage,
      ph: 'M', pid: 1, tid: this._cpuProfiles[0].id, ts: 0,
      args: {data: {sessionId: 1}}
    }]);
    for (const {profile, name, id} of this._cpuProfiles) {
      controller.traceEventsCollected([{
        cat: SDK.TracingModel.DevToolsMetadataEventCategory,
        name: TimelineModel.TimelineModel.DevToolsMetadataEvent.TracingSessionIdForWorker,
        ph: 'M', pid: 1, tid: id, ts: 0,
        args: {data: {sessionId: 1, workerThreadId: id, workerId: id, url: name}}
      }]);
      controller.traceEventsCollected(TimelineModel.TimelineJSProfileProcessor.buildTraceProfileFromCpuProfile(
          profile, id, false, TimelineModel.TimelineModel.WorkerThreadName));
    }
    this._cpuProfiles = [];
    await action.execute();
  }

  async kill(target) {
    return target.runtimeAgent().invoke_evaluate({
      expression: 'process.exit(-1)'
    });
  }

  async restartLast() {
    if (!this._lastStarted)
      return;
    await Promise.all(SDK.targetManager.targets()
        .filter(target => target.id() !== '<root>')
        .map(target => target.runtimeAgent().invoke_evaluate({
          expression: `'${this._lastStarted.debugId}' === process.env.NDD_DATA && process.exit(-1)`
        })));
    const {execPath, args, isProfiling} = this._lastStarted;
    if (!isProfiling)
      await this.debug(execPath, args);
    else
      await this.profile(execPath, args);
  }
};

Ndb.ProcessInfo = class {
  constructor(payload) {
    this._argv = payload.argv;
    this._data = payload.data;
    this._ppid = payload.ppid;
    this._isRepl = payload.data === 'ndb/repl';
  }

  argv() {
    return this._argv;
  }

  data() {
    return this._data;
  }

  ppid() {
    return this._ppid;
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
