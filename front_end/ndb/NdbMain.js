/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

/**
 * @implements {Common.Runnable}
 */
Ndb.NdbMain = class extends Common.Object {
  /**
   * @override
   */
  run() {
    InspectorFrontendAPI.setUseSoftMenu(true);
    document.title = 'ndb';
    Common.moduleSetting('blackboxAnythingOutsideCwd').addChangeListener(Ndb.NdbMain._calculateBlackboxState);
    Common.moduleSetting('whitelistedModules').addChangeListener(Ndb.NdbMain._calculateBlackboxState);
    Ndb.NdbMain._calculateBlackboxState();
    this._startRepl();
    Ndb.sourceMapManager = new Ndb.SourceMapManager();
    registerFileSystem('cwd', NdbProcessInfo.cwd).then(_ => {
      InspectorFrontendAPI.fileSystemAdded(undefined, {
        fileSystemName: 'cwd',
        fileSystemPath: NdbProcessInfo.cwd,
        rootURL: '',
        type: ''
      });
    });
  }

  async _startRepl() {
    const processManager = await Ndb.NodeProcessManager.instance();
    processManager.debug(NdbProcessInfo.execPath, [NdbProcessInfo.repl])
        .then(this._startRepl.bind(this));
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
    setting.set(excludePattern);
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

class SourceMappableState extends Bindings.BreakpointManager.Breakpoint.State {
  constructor(url, scriptId, scriptHash, lineNumber, columnNumber, condition) {
    super(url, scriptId, scriptHash, lineNumber, columnNumber, condition);
    if (!scriptId && !scriptHash && url) {
      const sourceMap = Ndb.sourceMapManager.sourceMap(url);
      if (sourceMap) {
        const entry = sourceMap.sourceLineMapping(url, lineNumber, columnNumber);
        if (entry) {
          this.url = sourceMap.compiledURL();
          this.lineNumber = entry.lineNumber;
          this.columnNumber = entry.columnNumber;
        }
      }
    }
  }
}

Bindings.BreakpointManager.Breakpoint.State = SourceMappableState;

Ndb.SourceMapManager = class {
  constructor() {
    this._manager = new SDK.SourceMapManager({
      inspectedURL: _ => Common.ParsedURL.platformPathToURL(NdbProcessInfo.cwd)
    });
    this._manager.addEventListener(
        SDK.SourceMapManager.Events.SourceMapAttached, this._sourceMapAttached, this);
    Workspace.workspace.addEventListener(Workspace.Workspace.Events.UISourceCodeAdded, this._uiSourceCodeAdded, this);

    this._bindings = new Map();
    this._fileUrlToSourceMap = new Map();
  }

  _sourceMapDetected(fsPath, fileName, sourceMappingUrl) {
    const fsPathUrl = Common.ParsedURL.platformPathToURL(fsPath);
    const fileUrl = Common.ParsedURL.platformPathToURL(fileName);
    this._manager.attachSourceMap({fsPathUrl, fileUrl}, fileUrl, sourceMappingUrl);
  }

  /**
   * @param {!Common.Event} event
   */
  _sourceMapAttached(event) {
    const {fsPathUrl, fileUrl} = event.data.client;
    const sourceMap = /** @type {!SDK.SourceMap} */ (event.data.sourceMap);
    for (const sourceUrl of sourceMap.sourceURLs()) {
      this._bindings.set(`${fsPathUrl}|${sourceUrl}`, sourceMap);
      this._fileUrlToSourceMap.set(sourceUrl, sourceMap);
    }
    const fileSystemProjects = Workspace.workspace.projectsForType('filesystem');
    for (const fileSystemProject of fileSystemProjects) {
      if (fileSystemProject.fileSystemPath() === fsPathUrl) {
        const uiSourceCode = fileSystemProject.uiSourceCodeForURL(fileUrl);
        if (uiSourceCode) {
          uiSourceCode[Bindings.CompilerScriptMapping._sourceMapSymbol] = sourceMap;
          break;
        }
      }
    }
  }

  sourceMap(fileUrl) {
    return this._fileUrlToSourceMap.get(fileUrl) || null;
  }

  /**
   * @param {!Common.Event} event
   */
  _uiSourceCodeAdded(event) {
    const uiSourceCode = /** @type {!Workspace.UISourceCode} */ (event.data);
    const project = uiSourceCode.project();
    if (project.type() !== 'filesystem')
      return;
    const key = `${project.fileSystemPath()}|${uiSourceCode.url()}`;
    const sourceMap = this._bindings.get(key);
    if (sourceMap)
      uiSourceCode[Bindings.CompilerScriptMapping._sourceMapSymbol] = sourceMap;
  }
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
    if (!url.startsWith('file://') || !url.endsWith('.js'))
      return;
    contextMenu.debugSection().appendItem(ls`Run this script`, async() => {
      const platformPath = Common.ParsedURL.urlToPlatformPath(url, Host.isWin());
      const processManager = await Ndb.NodeProcessManager.instance();
      processManager.debug(NdbProcessInfo.execPath, [platformPath]);
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

  notify(serviceId, notification) {
    const service = this._runningServices.get(serviceId);
    if (service) {
      if (notification.method === 'disposed')
        this._runningServices.delete(serviceId);
      service.dispatchEventToListeners(Ndb.Service.Events.Notification, notification);
    }
  }
};
Ndb.serviceManager = new Ndb.ServiceManager();
SDK.targetManager.mainTarget = () => null;

Ndb.Service = class extends Common.Object {
  constructor(serviceId) {
    super();
    this._serviceId = serviceId;
  }

  async call(method, options) {
    const {result, error} = await callNdbService(this._serviceId, method, options);
    return error || !result ? {error} : result;
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
    await service.call('start');
    Ndb.NodeProcessManager._instanceReady(instance);
    delete Ndb.NodeProcessManager._instanceReady;
  }

  constructor(targetManager, nddService) {
    super();
    this._targetManager = targetManager;

    this._nddService = nddService;
    this._nddService.addEventListener(Ndb.Service.Events.Notification, this._onNotification.bind(this));
    this._idToInstance = new Map();
    this._idToConnection = new Map();

    this._targetManager.addModelListener(
        SDK.RuntimeModel, SDK.RuntimeModel.Events.ExecutionContextDestroyed, this._onExecutionContextDestroyed, this);
  }

  existingInstances() {
    return this._idToInstance.values();
  }

  /**
   * @param {!Ndb.NodeProcess} instance
   * @return {!Promise<boolean>}
   */
  attach(instance) {
    return this._nddService.call('attach', {
      instanceId: instance.id()
    });
  }

  /**
   * @param {!Ndb.NodeProcess} instance
   * @return {!Promise<boolean>}
   */
  detach(instance) {
    return this._nddService.call('detach', {
      instanceId: instance.id()
    });
  }

  nddStore() {
    return this._nddService.call('nddStore');
  }

  _onNotification({data: {name, params}}) {
    if (name === 'added')
      this._onProcessAdded(params);
    else if (name === 'finished')
      this._onProcessFinished(params);
    else if (name === 'attached')
      this._onAttached(params);
    else if (name === 'detached')
      this._onDetached(params);
    else if (name === 'message')
      this._onMessage(params);
  }

  _onProcessAdded(data) {
    const parent = data.parentId ? this._idToInstance.get(data.parentId) : null;
    const instance = new Ndb.NodeProcess(data, parent);
    this._idToInstance.set(instance.id(), instance);
    this.dispatchEventToListeners(Ndb.NodeProcessManager.Events.Added, instance);

    this.attach(instance);
  }

  _onProcessFinished({instanceId}) {
    const instance = this._idToInstance.get(instanceId);
    if (instance)
      this.dispatchEventToListeners(Ndb.NodeProcessManager.Events.Finished, instance);
  }

  async _onAttached({instanceId}) {
    const instance = this._idToInstance.get(instanceId);
    if (!instance)
      return;
    const target = this._targetManager.createTarget(
        instance.id(), instance.userFriendlyName(), SDK.Target.Capability.JS,
        this._createConnection.bind(this, instance), null, true);
    await target.runtimeAgent().invoke_evaluate({
      expression: `process.runIfWaitingAtStart && process.runIfWaitingAtStart(${this._shouldPauseAtStart(instance)})`,
      includeCommandLineAPI: true
    });

    instance.setTarget(target);
    this.dispatchEventToListeners(Ndb.NodeProcessManager.Events.Attached, instance);
    if (instance.isRepl() && !self._replMessageShown) {
      self._replMessageShown = true;
      let message;
      if (Common.moduleSetting('uiTheme').get() === 'default') {
        message =
          new Common.Console.Message('\u001b[30mWelcome to the ndb \u001b\[32mR\u001b\[31mE\u001b\[34mP\u001b\[90mL\u001b[30m!\u001b[0m', Common.Console.MessageLevel.Info, 1, false);
      } else {
        message =
          new Common.Console.Message('\u001b[97mWelcome to the ndb \u001b\[92mR\u001b\[33mE\u001b\[31mP\u001b\[39mL\u001b[97m!\u001b[0m', Common.Console.MessageLevel.Info, 1, false);
      }
      Common.console._messages.push(message);
      Common.console.dispatchEventToListeners(Common.Console.Events.MessageAdded, message);
    }
  }

  _shouldPauseAtStart(instance) {
    if (!Common.moduleSetting('pauseAtStart').get())
      return false;
    if (Common.moduleSetting('blackboxAnythingOutsideCwd').get()) {
      const [_, arg] = instance.argv();
      if (arg && (arg === NdbProcessInfo.repl ||
          arg.endsWith('/bin/npm') || arg.endsWith('\\bin\\npm') ||
          arg.endsWith('/bin/yarn') || arg.endsWith('\\bin\\yarn') ||
          arg.endsWith('/bin/npm-cli.js') || arg.endsWith('\\bin\\npm-cli.js')))
        return false;
    }
    return true;
  }

  _createConnection(instance, params) {
    const connection = new Ndb.NddConnection(this._nddService, instance, params);
    this._idToConnection.set(instance.id(), connection);
    return connection;
  }

  _onDetached({instanceId}) {
    const connection = this._idToConnection.get(instanceId);
    if (connection) {
      this._idToConnection.delete(instanceId);
      connection.params.onDisconnect();
    }
    const instance = this._idToInstance.get(instanceId);
    instance.setTarget(null);
    this.dispatchEventToListeners(Ndb.NodeProcessManager.Events.Detached, instance);
  }

  _onMessage({instanceId, message}) {
    const connection = this._idToConnection.get(instanceId);
    if (connection)
      connection.params.onMessage(message);
  }

  _onExecutionContextDestroyed({data: executionContext}) {
    if (Common.moduleSetting('waitAtEnd').get() || executionContext.id !== 1)
      return;
    if (executionContext.target().suspended())
      return;
    for (const [_, instance] of this._idToInstance) {
      if (instance.target() === executionContext.target())
        this.detach(instance);
    }
  }

  debug(execPath, args) {
    return this._nddService.call('debug', {
      execPath, args, options: {
        waitAtStart: true,
        cwd: NdbProcessInfo.cwd
      }
    });
  }

  run(execPath, args) {
    return this._nddService.call('run', {
      execPath, args, options: {
        cwd: NdbProcessInfo.cwd
      }
    });
  }

  kill(instance) {
    return this._nddService.call('kill', {
      instanceId: instance.id()
    });
  }
};

/** @enum {symbol} */
Ndb.NodeProcessManager.Events = {
  Added: Symbol('added'),
  Finished: Symbol('finished'),
  Attached: Symbol('attached'),
  Detached: Symbol('detached')
};

/**
 * @implements {Protocol.InspectorBackend.Connection}
 */
Ndb.NddConnection = class {
  /**
   * @param {!Protocol.InspectorBackend.Connection.Params} params
   */
  constructor(nddService, instance, params) {
    this.params = params;
    this._nddService = nddService;
    this._instance = instance;
  }

  /**
   * @override
   * @param {string} message
   */
  sendMessage(message) {
    return this._nddService.call('sendMessage', {
      instanceId: this._instance.id(),
      message: message
    });
  }

  /**
   * @override
   * @return {!Promise}
   */
  disconnect() {
    return this._nddService.call('detach', {
      instanceId: this._instance.id(),
    });
  }
};

Ndb.NodeProcess = class {
  constructor(data, parent) {
    this._argv = data.argv;
    this._groupId = data.groupId;
    this._instanceId = data.instanceId;
    this._url = data.url;

    this._parent = parent;
    this._target = null;
  }

  argv() {
    return this._argv;
  }

  groupId() {
    return this._groupId;
  }

  id() {
    return this._instanceId;
  }

  url() {
    return this._url;
  }

  parent() {
    return this._parent;
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

  target() {
    return this._target;
  }

  setTarget(target) {
    this._target = target;
  }

  isRepl() {
    return this._argv.length === 2 && this._argv[0] === NdbProcessInfo.execPath &&
        this._argv[1] === NdbProcessInfo.repl;
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
