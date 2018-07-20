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
    Ndb.NodeProcessManager.instance().then(instance => {
      if (!Common.moduleSetting('autoStartMain').get())
        return;
      const main = Ndb.mainConfiguration();
      if (main) {
        const [execPath, ...args] = main.commandToRun.split(' ');
        instance.run(execPath, args);
      }
    });
    if (Common.moduleSetting('blackboxAnythingOutsideCwd').get()) {
      const regexPatterns = Common.moduleSetting('skipStackFramesPattern').getAsArray()
          .filter(({pattern}) => !pattern.startsWith('^(?!(') && pattern !== `node_debug_demon[\\/]preload\\.js`);
      regexPatterns.push({pattern:
          `^(?!(${NdbProcessInfo.cwd}|` +
          `\\[eval\\]|` +
          `${Common.ParsedURL.platformPathToURL(NdbProcessInfo.cwd)}|` +
          `file:///\\[eval\\])).*\$`});
      regexPatterns.push({pattern: `node_debug_demon[\\/]preload\\.js`});
      Common.moduleSetting('skipStackFramesPattern').setAsArray(regexPatterns);
    }

    registerFileSystem('cwd', NdbProcessInfo.cwd).then(_ => {
      InspectorFrontendAPI.fileSystemAdded(undefined, {
        fileSystemName: 'cwd',
        fileSystemPath: NdbProcessInfo.cwd,
        rootURL: '',
        type: ''
      });
    });
  }
};

Ndb.mainConfiguration = () => {
  const cmd = NdbProcessInfo.argv.slice(2);
  let command = '';
  if (cmd.length === 0 || cmd[0] === '.')
    return null;
  if (cmd[0].endsWith('.js')
    || cmd[0].endsWith('.mjs')
    || cmd[0].startsWith('-'))
    command = 'node ' + cmd.join(' ');
  else
    command = cmd.join(' ');
  return {
    name: 'main',
    command: command,
    commandToRun: command
  };
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
    return error || !result ? null : result;
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
  }

  _shouldPauseAtStart(instance) {
    if (!Common.moduleSetting('pauseAtStart').get())
      return false;
    if (Common.moduleSetting('blackboxAnythingOutsideCwd').get()) {
      const [_, arg] = instance.argv();
      if (arg && (arg.endsWith('/bin/npm') || arg.endsWith('\\bin\\npm') ||
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

  run(execPath, args) {
    return this._nddService.call('run', {
      execPath, args, options: {
        waitAtStart: true
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
};

SDK.DebuggerModel.prototype.scheduleStepIntoAsync = function() {
  this._agent.scheduleStepIntoAsync();
  this._agent.invoke_stepInto({breakOnAsyncCall: true});
};

// Temporary hack until frontend fix is rolled:
// https://chromium-review.googlesource.com/c/chromium/src/+/1132630
String.tokenizeFormatString = function(format, formatters) {
  const tokens = [];

  function addStringToken(str) {
    if (!str)
      return;
    if (tokens.length && tokens[tokens.length - 1].type === 'string')
      tokens[tokens.length - 1].value += str;
    else
      tokens.push({type: 'string', value: str});
  }

  function addSpecifierToken(specifier, precision, substitutionIndex) {
    tokens.push({type: 'specifier', specifier: specifier, precision: precision, substitutionIndex: substitutionIndex});
  }

  function addAnsiColor(code) {
    const types = {3: 'color', 9: 'colorLight', 4: 'bgColor', 10: 'bgColorLight'};
    const colorCodes = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'lightGray', '', 'default'];
    const colorCodesLight =
        ['darkGray', 'lightRed', 'lightGreen', 'lightYellow', 'lightBlue', 'lightMagenta', 'lightCyan', 'white', ''];
    const colors = {color: colorCodes, colorLight: colorCodesLight, bgColor: colorCodes, bgColorLight: colorCodesLight};
    const type = types[Math.floor(code / 10)];
    if (!type)
      return;
    const color = colors[type][code % 10];
    if (!color)
      return;
    tokens.push({
      type: 'specifier',
      specifier: 'c',
      value: {description: (type.startsWith('bg') ? 'background : ' : 'color: ') + color}
    });
  }

  let textStart = 0;
  let substitutionIndex = 0;
  const re =
      new RegExp(`%%|%(?:(\\d+)\\$)?(?:\\.(\\d*))?([${Object.keys(formatters).join('')}])|\\u001b\\[(\\d+)m`, 'g');
  for (let match = re.exec(format); !!match; match = re.exec(format)) {
    const matchStart = match.index;
    if (matchStart > textStart)
      addStringToken(format.substring(textStart, matchStart));

    if (match[0] === '%%') {
      addStringToken('%');
    } else if (match[0].startsWith('%')) {
      // eslint-disable-next-line no-unused-vars
      const [_, substitionString, precisionString, specifierString] = match;
      if (substitionString && Number(substitionString) > 0)
        substitutionIndex = Number(substitionString) - 1;
      const precision = precisionString ? Number(precisionString) : -1;
      addSpecifierToken(specifierString, precision, substitutionIndex);
      ++substitutionIndex;
    } else {
      const code = Number(match[4]);
      addAnsiColor(code);
    }
    textStart = matchStart + match[0].length;
  }
  addStringToken(format.substring(textStart));
  return tokens;
};

String.format = function(format, substitutions, formatters, initialValue, append, tokenizedFormat) {
  if (!format || ((!substitutions || !substitutions.length) && format.search(/\u001b\[(\d+)m/) === -1))
    return {formattedResult: append(initialValue, format), unusedSubstitutions: substitutions};

  function prettyFunctionName() {
    return 'String.format("' + format + '", "' + Array.prototype.join.call(substitutions, '", "') + '")';
  }

  function warn(msg) {
    console.warn(prettyFunctionName() + ': ' + msg);
  }

  function error(msg) {
    console.error(prettyFunctionName() + ': ' + msg);
  }

  let result = initialValue;
  const tokens = tokenizedFormat || String.tokenizeFormatString(format, formatters);
  const usedSubstitutionIndexes = {};

  for (let i = 0; i < tokens.length; ++i) {
    const token = tokens[i];

    if (token.type === 'string') {
      result = append(result, token.value);
      continue;
    }

    if (token.type !== 'specifier') {
      error('Unknown token type "' + token.type + '" found.');
      continue;
    }

    if (!token.value && token.substitutionIndex >= substitutions.length) {
      // If there are not enough substitutions for the current substitutionIndex
      // just output the format specifier literally and move on.
      error(
          'not enough substitution arguments. Had ' + substitutions.length + ' but needed ' +
          (token.substitutionIndex + 1) + ', so substitution was skipped.');
      result = append(result, '%' + (token.precision > -1 ? token.precision : '') + token.specifier);
      continue;
    }

    if (!token.value)
      usedSubstitutionIndexes[token.substitutionIndex] = true;

    if (!(token.specifier in formatters)) {
      // Encountered an unsupported format character, treat as a string.
      warn('unsupported format character \u201C' + token.specifier + '\u201D. Treating as a string.');
      result = append(result, token.value ? '' : substitutions[token.substitutionIndex]);
      continue;
    }

    result = append(result, formatters[token.specifier](token.value || substitutions[token.substitutionIndex], token));
  }

  const unusedSubstitutions = [];
  for (let i = 0; i < substitutions.length; ++i) {
    if (i in usedSubstitutionIndexes)
      continue;
    unusedSubstitutions.push(substitutions[i]);
  }

  return {formattedResult: result, unusedSubstitutions: unusedSubstitutions};
};

// Temporary hack until frontend with fix is rolled.
// fix: TBA.
SDK.Target.prototype.decorateLabel = function(label) {
  if (label.startsWith('node['))
    return this.name();
  return label;
};
