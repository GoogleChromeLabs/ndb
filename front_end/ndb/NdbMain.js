/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

function callFrontend(f) {
  if (Runtime.queryParam('debugFrontend'))
    setTimeout(f, 0);
  else
    f();
}

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
    self.NdbProcessInfo = await getProcessInfo();
    Common.moduleSetting('blackboxAnythingOutsideCwd').addChangeListener(Ndb.NdbMain._calculateBlackboxState);
    Common.moduleSetting('whitelistedModules').addChangeListener(Ndb.NdbMain._calculateBlackboxState);
    Ndb.NdbMain._calculateBlackboxState();

    // Create root Main target.
    const stubConnection = new SDK.StubConnection({onMessage: _ => 0, onDisconnect: _ => 0});
    SDK.targetManager.createTarget('<root>', '', 0, _ => stubConnection, null, true);
    this._startRepl();

    registerFileSystem('cwd', NdbProcessInfo.cwd).then(_ => {
      InspectorFrontendAPI.fileSystemAdded(undefined, {
        fileSystemName: 'cwd',
        fileSystemPath: NdbProcessInfo.cwd,
        rootURL: '',
        type: ''
      });
    });
    Runtime.experiments.setEnabled('timelineTracingJSProfile', false);
  }

  async _startRepl() {
    const processManager = await Ndb.NodeProcessManager.instance();
    processManager.debug(NdbProcessInfo.execPath, [NdbProcessInfo.repl])
        .then(this._startRepl.bind(this));
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
    const whitelistOnlyProject = Common.moduleSetting('blackboxAnythingOutsideCwd').get();
    const whitelistModules = Common.moduleSetting('whitelistedModules').get().split(',');

    // ^(?!cwd|[eval]|f(cwd)|f([eval]))|^(cwd/node_modules/|f(cwd/node_modules/))(?!(module1|module2|...))
    const escapedCwd = NdbProcessInfo.cwd.replace(/\\/g, '\\\\');
    const cwdUrl = Common.ParsedURL.platformPathToURL(NdbProcessInfo.cwd);

    let pattern = '';
    if (whitelistOnlyProject)
      pattern += `^(?!${escapedCwd}|\\[eval\\]|${cwdUrl}|file:///\\[eval\\])`;
    pattern += `${pattern.length > 0 ? '|' : ''}^(` +
      `${escapedCwd}[/\\\\]node_modules[/\\\\]|` +
      `${cwdUrl}/node_modules/)${whitelistModules.length > 0 ? `(?!${whitelistModules.join('|')})` : ''}`;

    const regexPatterns = Common.moduleSetting('skipStackFramesPattern').getAsArray()
        .filter(({pattern}) => !pattern.includes(`\\[eval\\]`) && pattern !== `node_debug_demon[\\/]preload\\.js`);
    regexPatterns.push({pattern: pattern });
    regexPatterns.push({pattern: `node_debug_demon[\\/]preload\\.js`});
    Common.moduleSetting('skipStackFramesPattern').setAsArray(regexPatterns);

    let excludePattern;
    if (NdbProcessInfo.pkg) {
      if (whitelistModules.length > 0) {
        const root = {name: 'node_modules', subfolders: []};
        populateFolders(whitelistModules, root);
        excludePattern = `^/node_modules/(?!($|${root.subfolders.map(generatePattern).join('|')}))`;
      } else {
        excludePattern = `^/node_modules/`;
      }
    } else {
      excludePattern = '^/[^/]+/[^/]+/[^/]+/';
    }
    const setting = Persistence.isolatedFileSystemManager.workspaceFolderExcludePatternSetting();
    setting.set([excludePattern, ...Ndb.NdbMain._defaultExcludePattern()].join('|'));
    setExcludedPattern(excludePattern);

    function populateFolders(folders, currentRoot) {
      const perParent = new Map();
      for (const folder of folders) {
        const [parent, ...tail] = folder.split('/');
        if (!perParent.has(parent))
          perParent.set(parent, [tail.join('/')]);
        else
          perParent.get(parent).push(tail.join('/'));
      }
      for (const [parent, tails] of perParent) {
        const node = {name: parent, subfolders: []};
        if (tails.filter(a => a.length).length)
          populateFolders(tails, node);
        currentRoot.subfolders.push(node);
      }
    }

    function generatePattern(node) {
      if (!node.subfolders || !node.subfolders.length)
        return `${node.name}/`;
      return `${node.name}/($|${node.subfolders.map(generatePattern).join('|')})`;
    }
  }
};

Ndb.mainConfiguration = () => {
  const cmd = NdbProcessInfo.argv.slice(2);
  if (cmd.length === 0 || cmd[0] === '.')
    return null;
  let execPath;
  let args;
  if (cmd[0].endsWith('.js')
    || cmd[0].endsWith('.mjs')
    || cmd[0].startsWith('-')) {
    execPath = NdbProcessInfo.execPath;
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
      const processManager = await Ndb.NodeProcessManager.instance();
      const args = url.endsWith('.mjs') ? ['--experimental-modules', platformPath] : [platformPath];
      processManager.debug(NdbProcessInfo.execPath, args);
    });
  }
};

Ndb.ServiceManager = class {
  constructor() {
    this._runningServices = new Map();
  }

  async create(name) {
    const {serviceId, error} = await createNdbService(name, NdbProcessInfo.serviceDir);
    if (error) {
      console.error(error);
      return null;
    }
    const service = new Ndb.Service(serviceId);
    this._runningServices.set(serviceId, service);
    return service;
  }

  notify(notifications) {
    for (const {serviceId, callId, payload} of notifications) {
      const service = this._runningServices.get(serviceId);
      if (service)
        service._notify(callId, payload);
      if (!callId && payload.method === 'disposed')
        this._runningServices.delete(serviceId);
    }
  }
};
Ndb.serviceManager = new Ndb.ServiceManager();

Ndb.Service = class extends Common.Object {
  constructor(serviceId) {
    super();
    this._serviceId = serviceId;
    this._lastCallId = 0;
    this._callbacks = new Map();
  }

  call(method, options) {
    const callId = ++this._lastCallId;
    const promise = new Promise(resolve => this._callbacks.set(callId, resolve));
    callNdbService({
      serviceId: this._serviceId,
      callId,
      method,
      options
    });
    return promise;
  }

  _notify(callId, payload) {
    if (callId) {
      const callback = this._callbacks.get(callId);
      this._callbacks.delete(callId);
      if (callback) {
        const {result, error} = payload || {};
        callback(error || !result ? {error} : result);
      }
    } else {
      this.dispatchEventToListeners(Ndb.Service.Events.Notification, payload);
    }
  }
};

Ndb.Service.Events = {
  Notification: Symbol('notification')
};

Ndb.NodeProcessManager = class extends Common.Object {
  /**
   * @return {!Promise<!Ndb.NodeProcessManager>}
   */
  static async instance() {
    if (!Ndb.NodeProcessManager._instancePromise) {
      Ndb.NodeProcessManager._instancePromise = new Promise(resolve => {
        Ndb.NodeProcessManager._instanceReady = resolve;
      });
      Ndb.NodeProcessManager._create();
    }
    return Ndb.NodeProcessManager._instancePromise;
  }

  static async _create() {
    const service = await Ndb.serviceManager.create('ndd_service');
    const instance = new Ndb.NodeProcessManager(SDK.targetManager, service);
    instance._nddStore = await service.call('init', {
      nddSharedStore: NdbProcessInfo.nddSharedStore
    });
    Ndb.NodeProcessManager._instanceReady(instance);
    delete Ndb.NodeProcessManager._instanceReady;
  }

  constructor(targetManager, nddService) {
    super();
    this._targetManager = targetManager;

    this._nddService = nddService;
    this._nddService.addEventListener(Ndb.Service.Events.Notification, this._onNotification.bind(this));

    this._processes = new Map();
    this._connections = new Map();

    this._lastDebugId = 0;
    this._lastStarted = null;

    this._targetManager.addModelListener(
        SDK.RuntimeModel, SDK.RuntimeModel.Events.ExecutionContextDestroyed, this._onExecutionContextDestroyed, this);
  }

  nddStore() {
    return this._nddStore;
  }

  _onNotification({data: {name, params}}) {
    if (name === 'added')
      this._onProcessAdded(params);
  }

  async _onProcessAdded(payload) {
    const pid = payload.id;
    const processInfo = new Ndb.ProcessInfo(payload);
    this._processes.set(pid, processInfo);

    const parentTarget = payload.ppid ? this._targetManager.targetById(payload.ppid) : this._targetManager.mainTarget();
    const target = this._targetManager.createTarget(
        pid, processInfo.userFriendlyName(), SDK.Target.Capability.JS,
        this._createConnection.bind(this, pid),
        parentTarget, true);
    if (this._shouldPauseAtStart(payload.argv)) {
      target.runtimeAgent().invoke_evaluate({
        expression: `process.breakAtStart && process.breakAtStart()`,
        includeCommandLineAPI: true
      });
    }
    return target.runtimeAgent().runIfWaitingForDebugger();
  }

  _createConnection(id, params) {
    const connection = new Ndb.Connection(id, this._nddService, this._onWebSocketDisconnected.bind(this, id), params);
    this._connections.set(id, connection);
    return connection;
  }

  _onWebSocketDisconnected(id) {
    this._connections.delete(id);
    this._processes.delete(id);
  }

  _shouldPauseAtStart(argv) {
    if (!Common.moduleSetting('pauseAtStart').get())
      return false;
    if (Common.moduleSetting('blackboxAnythingOutsideCwd').get()) {
      const [_, arg] = argv;
      if (arg && (arg === NdbProcessInfo.repl ||
          arg.endsWith('/bin/npm') || arg.endsWith('\\bin\\npm') ||
          arg.endsWith('/bin/yarn') || arg.endsWith('\\bin\\yarn') ||
          arg.endsWith('/bin/npm-cli.js') || arg.endsWith('\\bin\\npm-cli.js')))
        return false;
    }
    return true;
  }

  async _onExecutionContextDestroyed({data: executionContext}) {
    const mainContextId = 1;
    if (executionContext.id !== mainContextId)
      return;
    const target = executionContext.target();
    if (target.suspended()) {
      const debuggerModel = target.model(SDK.DebuggerModel);
      await new Promise(resolve => debuggerModel.addEventListener(
          SDK.DebuggerModel.Events.DebuggerWasEnabled, resolve));
    }
    const connection = this._connections.get(executionContext.target().id());
    if (connection)
      connection.disconnect();
  }

  infoForTarget(target) {
    return this._processes.get(target.id()) || null;
  }

  debug(execPath, args) {
    const debugId = String(++this._lastDebugId);
    this._lastStarted = {execPath, args, debugId};
    return this._nddService.call('debug', {
      execPath, args, options: {
        data: debugId,
        cwd: NdbProcessInfo.cwd,
        preload: NdbProcessInfo.preload
      }
    });
  }

  kill(target) {
    return this._nddService.call('kill', {
      id: target.id()
    });
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
    this.debug(execPath, args);
  }
};

/**
 * @implements {Protocol.InspectorBackend.Connection}
 */
Ndb.Connection = class {
  constructor(pid, nddService, onWebSocketDisconnect, params) {
    this._pid = pid;
    this._nddService = nddService;
    this._onDisconnect = params.onDisconnect;
    this._onMessage = params.onMessage;
    this._onWebSocketDisconnect = onWebSocketDisconnect;
    this._nddService.addEventListener(Ndb.Service.Events.Notification, this._onServiceNotification.bind(this));
  }

  _onServiceNotification({data: {name, params}}) {
    if (name === 'message' && params.id === this._pid)
      this._onMessage.call(null, params.message);
    if (name === 'disconnected' && params.id === this._pid) {
      this._onWebSocketDisconnect.call(null);
      this._onDisconnect.call(null, 'websocket closed');
    }
  }

  /**
   * @param {string} domain
   * @param {!Protocol.InspectorBackend.Connection.MessageObject} messageObject
   */
  sendMessage(domain, messageObject) {
    return this._nddService.call('send', {
      id: this._pid,
      message: JSON.stringify(messageObject)
    });
  }

  /**
   * @return {!Promise}
   */
  disconnect() {
    return this._nddService.call('disconnect', {id: this._pid})
        .then(_ => this._onDisconnect.call(null, 'force disconnect'));
  }
};

Ndb.ProcessInfo = class {
  constructor(payload) {
    this._argv = payload.argv;
    this._data = payload.data;
  }

  argv() {
    return this._argv;
  }

  data() {
    return this._data;
  }

  userFriendlyName() {
    return this.argv().map(arg => {
      const index1 = arg.lastIndexOf('/');
      const index2 = arg.lastIndexOf('\\');
      if (index1 === -1 && index2 === -1)
        return arg;
      return arg.slice(Math.max(index1, index2) + 1);
    }).join(' ');
  }

  isRepl() {
    return this._argv.length === 2 && this._argv[0] === NdbProcessInfo.execPath &&
        this._argv[1] === NdbProcessInfo.repl;
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
        Ndb.NodeProcessManager.instance().then(manager => manager.restartLast());
        return true;
    }
    return false;
  }
};

SDK.DebuggerModel.prototype.scheduleStepIntoAsync = function() {
  this._agent.scheduleStepIntoAsync();
  this._agent.invoke_stepInto({breakOnAsyncCall: true});
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

Bindings.CompilerScriptMapping.prototype._sourceMapDetached = function(event) {
  const script = /** @type {!SDK.Script} */ (event.data.client);
  const frameId = script[Bindings.CompilerScriptMapping._frameIdSymbol];
  const sourceMap = /** @type {!SDK.SourceMap} */ (event.data.sourceMap);
  const bindings = script.isContentScript() ? this._contentScriptsBindings : this._regularBindings;
  for (const sourceURL of sourceMap.sourceURLs()) {
    const binding = bindings.get(sourceURL);
    if (!binding)
      continue;
    binding.removeSourceMap(sourceMap, frameId);
    if (!binding._uiSourceCode)
      bindings.delete(sourceURL);
  }
  this._debuggerWorkspaceBinding.updateLocations(script);
};

/**
 * @param {string} sourceMapURL
 * @param {string} compiledURL
 * @return {!Promise<?SDK.TextSourceMap>}
 * @this {SDK.TextSourceMap}
 */
SDK.TextSourceMap.load = async function(sourceMapURL, compiledURL) {
  const {payload, error} = await loadSourceMap(sourceMapURL, compiledURL);
  if (error || !payload)
    return null;
  try {
    return new SDK.TextSourceMap(compiledURL, sourceMapURL, payload);
  } catch (e) {
    console.error(e);
    Common.console.warn('DevTools failed to parse SourceMap: ' + sourceMapURL);
    return null;
  }
};
