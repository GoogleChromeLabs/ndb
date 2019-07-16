/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

Ndb.npmExecPath = function() {
  if (!Ndb._npmExecPathPromise)
    Ndb._npmExecPathPromise = Ndb.backend.which('npm').then(result => result.resolvedPath);
  return Ndb._npmExecPathPromise;
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

    Ndb.processInfo = await Ndb.backend.processInfo();
    await Ndb.nodeProcessManager.addFileSystem(Ndb.processInfo.cwd);

    // TODO(ak239): we do not want to create this model for workers, so we need a way to add custom capabilities.
    SDK.SDKModel.register(NdbSdk.NodeWorkerModel, SDK.Target.Capability.JS, true);
    SDK.SDKModel.register(NdbSdk.NodeRuntimeModel, SDK.Target.Capability.JS, true);

    await new Promise(resolve => SDK.initMainConnection(resolve));
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
    Ndb.nodeProcessManager.startRepl();
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
  const info = Ndb.processInfo;
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
    execPath = await Ndb.processInfo.nodeExecPath;
    args = cmd;
  } else {
    execPath = cmd[0];
    args = cmd.slice(1);
  }
  if (execPath === 'npm')
    execPath = await Ndb.npmExecPath();
  else if (execPath === 'node')
    execPath = await Ndb.processInfo.nodeExecPath;
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
      const platformPath = await Ndb.backend.fileURLToPath(url);
      const args = url.endsWith('.mjs') ? ['--experimental-modules', platformPath] : [platformPath];
      Ndb.nodeProcessManager.debug(Ndb.processInfo.nodeExecPath, args);
    });
  }
};

Ndb._connectionSymbol = Symbol('connection');

Ndb.NodeProcessManager = class extends Common.Object {
  constructor(targetManager) {
    super();
    this._service = null;
    this._lastDebugId = 0;
    this._lastStarted = null;
    this._targetManager = targetManager;
    this._cwds = new Map();
    this._finishProfiling = null;
    this._cpuProfiles = [];
    this._targetManager.addModelListener(
        SDK.RuntimeModel, SDK.RuntimeModel.Events.ExecutionContextDestroyed, this._onExecutionContextDestroyed, this);
    this._targetManager.addModelListener(
        NdbSdk.NodeRuntimeModel, NdbSdk.NodeRuntimeModel.Events.WaitingForDisconnect, this._onWaitingForDisconnect, this);
  }

  static async create(targetManager) {
    const manager = new Ndb.NodeProcessManager(targetManager);
    manager._service = await Ndb.backend.createService('ndd_service.js', rpc.handle(manager));
    return manager;
  }

  env() {
    return this._service.env();
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
        const fileSystemManager = Persistence.isolatedFileSystemManager;
        const fs = await Ndb.FileSystem.create(fileSystemManager, cwd);
        fileSystemManager.addPlatformFileSystem(cwd, fs);
        return fs;
      }
      promise = innerAdd();
      this._cwds.set(cwd, promise);
    }
    if (mainFileName)
      await (await promise).forceFileLoad(mainFileName);
    await promise;
  }

  async detected(info, channel) {
    const connection = await Ndb.Connection.create(channel);
    const target = this._targetManager.createTarget(
        info.id, userFriendlyName(info), SDK.Target.Type.Node,
        this._targetManager.targetById(info.ppid) || this._targetManager.mainTarget(), undefined, false, connection);
    target[NdbSdk.connectionSymbol] = connection;
    await this.addFileSystem(info.cwd, info.scriptName);
    if (info.scriptName) {
      const scriptURL = info.scriptName;
      const uiSourceCode = Workspace.workspace.uiSourceCodeForURL(scriptURL);
      const isBlackboxed = Bindings.blackboxManager.isBlackboxedURL(scriptURL, false);
      if (isBlackboxed)
        return connection.disconnect();
      if (uiSourceCode) {
        if (Common.moduleSetting('pauseAtStart').get() && !isBlackboxed)
          Bindings.breakpointManager.setBreakpoint(uiSourceCode, 0, 0, '', true);
        else
          Common.Revealer.reveal(uiSourceCode);
      }
    }
    if (info.data === this._profilingNddData)
      this._profiling.add(target.id());

    function userFriendlyName(info) {
      if (info.data === 'ndb/repl')
        return 'repl';
      return info.argv.map(arg => {
        const index1 = arg.lastIndexOf('/');
        const index2 = arg.lastIndexOf('\\');
        if (index1 === -1 && index2 === -1)
          return arg;
        return arg.slice(Math.max(index1, index2) + 1);
      }).join(' ');
    }
  }

  disconnected(sessionId) {
    const target = this._targetManager.targetById(sessionId);
    if (target) {
      this._targetManager.removeTarget(target);
      target.dispose();
    }
  }

  async terminalData(stream, data) {
    const content = await(await fetch(`data:application/octet-stream;base64,${data}`)).text();
    if (content.startsWith('Debugger listening on') || content.startsWith('Debugger attached.') || content.startsWith('Waiting for the debugger to disconnect...'))
      return;
    await Ndb.backend.writeTerminalData(stream, data);
    this.dispatchEventToListeners(Ndb.NodeProcessManager.Events.TerminalData, content);
  }

  async _onExecutionContextDestroyed(event) {
    const executionContext = event.data;
    if (!executionContext.isDefault)
      return;
    return this._onWaitingForDisconnect({data: executionContext.target()});
  }

  async _onWaitingForDisconnect(event) {
    const target = event.data;
    if (target.name() === 'repl')
      this.startRepl();
    if (this._profiling && (this._profiling.has(target.id()) || this._profiling.has(target.parentTarget().id()))) {
      this._cpuProfiles.push({
        profile: await target.model(SDK.CPUProfilerModel).stopRecording(),
        name: target.name(),
        id: target.id()
      });
      this._profiling.delete(target.id());
      if (this._profiling.size === 0)
        this._finishProfiling();
    }
    const connection = target[NdbSdk.connectionSymbol];
    if (connection)
      await connection.disconnect();
  }

  async startRepl() {
    const code = btoa(`console.log('Welcome to the ndb %cR%cE%cP%cL%c!',
      'color:#8bc34a', 'color:#ffc107', 'color:#ff5722', 'color:#2196f3', 'color:inherit');
      process.title = 'ndb/repl';
      process.on('uncaughtException', console.error);
      setInterval(_ => 0, 2147483647)//# sourceURL=repl.js`);
    const args = ['-e', `eval(Buffer.from('${code}', 'base64').toString())`];
    const options = { ignoreOutput: true, data: 'ndb/repl' };
    const node = Ndb.processInfo.nodeExecPath;
    return this.debug(node, args, options);
  }

  async debug(execPath, args, options) {
    options = options || {};
    const debugId = options.data || String(++this._lastDebugId);
    if (!options.data)
      this._lastStarted = {execPath, args, debugId, isProfiling: !!this._finishProfiling};

    return this._service.debug(
        execPath, args, {
          ...options,
          data: debugId,
          cwd: Ndb.processInfo.cwd
        });
  }

  async profile(execPath, args, options) {
    // TODO(ak239): move it out here.
    await UI.viewManager.showView('timeline');
    const action = UI.actionRegistry.action('timeline.toggle-recording');
    await action.execute();
    this._profilingNddData = String(++this._lastDebugId);
    this._profiling = new Set();
    this.debug(execPath, args, { data: this._profilingNddData });
    await new Promise(resolve => this._finishProfiling = resolve);
    this._profilingNddData = '';
    await Promise.all(SDK.targetManager.models(SDK.CPUProfilerModel).map(profiler => profiler.stopRecording()));
    const controller = Timeline.TimelinePanel.instance()._controller;
    const mainProfile = this._cpuProfiles.find(data => !data.id.includes('#'));
    controller.traceEventsCollected([{
      cat: SDK.TracingModel.DevToolsMetadataEventCategory,
      name: TimelineModel.TimelineModel.DevToolsMetadataEvent.TracingStartedInPage,
      ph: 'M', pid: 1, tid: mainProfile.id, ts: 0,
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

Ndb.NodeProcessManager.Events = {
  TerminalData: Symbol('terminalData')
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
    Common.console.warn('DevTools failed to parse SourceMap: ' + sourceMapURL);
    return null;
  }

  const modulePrefix = await Ndb.backend.getNodeScriptPrefix();
  for (const uiSourceCode of Workspace.workspace.uiSourceCodes()) {
    if (uiSourceCode.url() === compiledURL && uiSourceCode.project().type() === Workspace.projectTypes.Network) {
      const content = await uiSourceCode.requestContent();
      if (content.startsWith(modulePrefix)) {
        for (const mapping of textSourceMap.mappings()) {
          if (!mapping.lineNumber)
            mapping.columnNumber += modulePrefix.length;
        }
        break;
      }
    }
  }

  return textSourceMap;
};
