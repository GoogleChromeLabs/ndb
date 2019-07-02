Protocol.inspectorBackend.registerCommand('NodeRuntime.notifyWhenWaitingForDisconnect', [{'name': 'enabled', 'type': 'boolean', 'optional': false}], [], false);
Protocol.inspectorBackend.registerEvent('NodeRuntime.waitingForDisconnect', []);

NdbSdk.NodeRuntimeModel = class extends SDK.SDKModel {
  /**
   * @param {!SDK.Target} target
   */
  constructor(target) {
    super(target);

    this._agent = target.nodeRuntimeAgent();
    this.target().registerNodeRuntimeDispatcher(new NdbSdk.NodeRuntimeDispatcher(this));
    this._agent.notifyWhenWaitingForDisconnect(true);
  }

  /**
   * @param {string} sessionId
   * @param {!Object} workerInfo
   * @param {boolean} waitingForDebugger
   */
  _waitingForDisconnect() {
    this.dispatchEventToListeners(NdbSdk.NodeRuntimeModel.Events.WaitingForDisconnect, this.target());
  }
};

/** @enum {symbol} */
NdbSdk.NodeRuntimeModel.Events = {
  WaitingForDisconnect: Symbol('WaitingForDisconnect')
};

NdbSdk.NodeRuntimeDispatcher = class {
  constructor(nodeRuntimeModel) {
    this._nodeRuntimeModel = nodeRuntimeModel;
  }

  waitingForDisconnect() {
    this._nodeRuntimeModel._waitingForDisconnect();
  }
};
