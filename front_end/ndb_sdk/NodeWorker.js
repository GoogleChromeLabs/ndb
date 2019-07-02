Protocol.inspectorBackend.registerCommand('NodeWorker.enable', [{'name': 'waitForDebuggerOnStart', 'type': 'boolean', 'optional': false}], [], false);
Protocol.inspectorBackend.registerCommand('NodeWorker.disable', [], [], false);
Protocol.inspectorBackend.registerCommand('NodeWorker.sendMessageToWorker', [{'name': 'message', 'type': 'string', 'optional': false}, {'name': 'sessionId', 'type': 'string', 'optional': false}], [], false);
Protocol.inspectorBackend.registerCommand('NodeWorker.detach', [{'name': 'sessionId', 'type': 'string', 'optional': false}], [], false);
Protocol.inspectorBackend.registerEvent('NodeWorker.attachedToWorker', ['sessionId', 'workerInfo', 'waitingForDebugger']);
Protocol.inspectorBackend.registerEvent('NodeWorker.detachedFromWorker', ['sessionId']);
Protocol.inspectorBackend.registerEvent('NodeWorker.receivedMessageFromWorker', ['sessionId', 'message']);

NdbSdk.connectionSymbol = Symbol('connection');

NdbSdk.NodeWorkerModel = class extends SDK.SDKModel {
  /**
   * @param {!SDK.Target} target
   */
  constructor(target) {
    super(target);

    this._sessions = new Map();
    this._targets = new Map();
    this._agent = target.nodeWorkerAgent();
    this.target().registerNodeWorkerDispatcher(new NdbSdk.NodeWorkerDispatcher(this));
    this._agent.invoke_enable({waitForDebuggerOnStart: true});
  }

  /**
   * @param {string} message
   * @param {string} sessionId
   * @return {!Promise}
   */
  sendMessageToWorker(message, sessionId) {
    return this._agent.sendMessageToWorker(message, sessionId);
  }

  /**
   * @param {string} sessionId
   * @return {!Promise}
   */
  detach(sessionId) {
    return this._agent.detach(sessionId);
  }

  /**
   * @override
   */
  dispose() {
    this._sessions.clear();
    for (const target of this._targets.values()) {
      SDK.targetManager.removeTarget(target);
      target.dispose();
    }
    this._targets.clear();
  }

  /**
   * @param {string} sessionId
   * @param {!Object} workerInfo
   * @param {boolean} waitingForDebugger
   */
  _attachedToWorker(sessionId, workerInfo, waitingForDebugger) {
    const id = this.target().id() + '#' + workerInfo.workerId;
    const connection = new NdbSdk.NodeWorkerConnection(sessionId, this);
    this._sessions.set(sessionId, connection);
    const target = SDK.targetManager.createTarget(
        id, workerInfo.title, SDK.Target.Type.Node, this.target(),
        undefined, false, connection);
    target[NdbSdk.connectionSymbol] = connection;
    this._targets.set(sessionId, target);
    target.runtimeAgent().runIfWaitingForDebugger();
  }

  /**
   * @param {string} sessionId
   */
  _detachedFromWorker(sessionId) {
    const session = this._sessions.get(sessionId);
    if (session) {
      this._sessions.delete(sessionId);
      const target = this._targets.get(sessionId);
      if (target) {
        SDK.targetManager.removeTarget(target);
        target.dispose();
        this._targets.delete(sessionId);
      }
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} message
   */
  _receivedMessageFromWorker(sessionId, message) {
    const session = this._sessions.get(sessionId);
    if (session)
      session.receivedMessageFromWorker(message);
  }
};

NdbSdk.NodeWorkerConnection = class {
  constructor(sessionId, nodeWorkerModel) {
    this._onMessage = null;
    this._onDisconnect = null;
    this._sessionId = sessionId;
    this._nodeWorkerModel = nodeWorkerModel;
  }

  /**
   * @param {function((!Object|string))} onMessage
   */
  setOnMessage(onMessage) {
    this._onMessage = onMessage;
  }

  /**
   * @param {function(string)} onDisconnect
   */
  setOnDisconnect(onDisconnect) {
    this._onDisconnect = onDisconnect;
  }

  /**
   * @param {string} message
   */
  sendRawMessage(message) {
    this._nodeWorkerModel.sendMessageToWorker(message, this._sessionId);
  }

  /**
   * @return {!Promise}
   */
  disconnect() {
    return this._nodeWorkerModel.detach(this._sessionId);
  }

  /**
   * @param {string} message
   */
  receivedMessageFromWorker(message) {
    if (this._onMessage)
      this._onMessage(message);
  }

  detachedFromWorker() {
    if (this._onDisconnect)
      this._onDisconnect();
  }
};

NdbSdk.NodeWorkerDispatcher = class {
  /**
   * @param {!NdbSdk.NodeWorkerModel}
   */
  constructor(nodeWorkerModel) {
    this._nodeWorkerModel = nodeWorkerModel;
  }

  /**
   * @param {string} sessionId
   * @param {!Object} workerInfo
   * @param {boolean} waitingForDebugger
   */
  attachedToWorker(sessionId, workerInfo, waitingForDebugger) {
    this._nodeWorkerModel._attachedToWorker(sessionId, workerInfo, waitingForDebugger);
  }

  /**
   * @param {string} sessionId
   */
  detachedFromWorker(sessionId) {
    this._nodeWorkerModel._detachedFromWorker(sessionId);
  }

  /**
   * @param {string} sessionId
   * @param {string} message
   */
  receivedMessageFromWorker(sessionId, message) {
    this._nodeWorkerModel._receivedMessageFromWorker(sessionId, message);
  }
};
