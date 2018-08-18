/**
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @implements {Common.Runnable}
 */
Ndb.CloudDebugMain = class extends Common.Object {
  /**
   * @override
   */
  run() {
    // Create root CloudDebugMain target.
    const stubConnection = new SDK.StubConnection({onMessage: _ => 0, onDisconnect: _ => 0});
    SDK.targetManager.createTarget('<cloud-debug-root>', '', 0, _ => stubConnection, null, false);
  }
};

Ndb.CloudDebuggeeManager = class extends Common.Object {
  /**
   * @return {!Promise<!Ndb.CloudDebuggeeManager>}
   */
  static async instance() {
    if (!Ndb.CloudDebuggeeManager._instancePromise) {
      Ndb.CloudDebuggeeManager._instancePromise = new Promise(resolve => {
        Ndb.CloudDebuggeeManager._instanceReady = resolve;
      });
      Ndb.CloudDebuggeeManager._create();
    }
    return Ndb.CloudDebuggeeManager._instancePromise;
  }

  static async _create() {
    const service = await Ndb.serviceManager.create('cloud_debug_service');
    const instance = new Ndb.CloudDebuggeeManager(SDK.targetManager, service);
    Ndb.CloudDebuggeeManager._instanceReady(instance);
    delete Ndb.CloudDebuggeeManager._instanceReady;
  }

  constructor(targetManager, cloudDebugService) {
    super();
    this._targetManager = targetManager;
    this._cloudDebugService = cloudDebugService;
    this._cloudDebugService.addEventListener(Ndb.Service.Events.Notification, this._onNotification.bind(this));
    this._debuggees = new Map();
    this._connections = new Map();
  }

  _onNotification({data: {name, params}}) {
    if (name === 'debuggeeListUpdated') {
      this._onDebuggeeListUpdated(params);
    } else if (name === 'attached') {
      this._onDebuggeeAttached(params);
    } else if (name === 'breakpointListUpdated') {
      this.dispatchEventToListeners(Ndb.CloudDebuggeeManager.Events.BreakpointListUpdated, params);
    }
  }

  _onDebuggeeListUpdated(payload) {
    const cloudDebuggeeList = payload.debuggeeList.map((debuggee) => {
      if (!this._debuggees.has(debuggee.id)) {
        const cloudDebuggee = new Ndb.CloudDebuggeeInfo(debuggee);
        this._debuggees.set(debuggee.id, cloudDebuggee);
      }
      return this._debuggees.get(debuggee.id);
    });
    this.dispatchEventToListeners(Ndb.CloudDebuggeeManager.Events.DebuggeeListUpdated, cloudDebuggeeList);
  }

  async _onDebuggeeAttached(payload) {
    const debuggee = this._debuggees.get(payload.id);
    const target = this._targetManager.createTarget(
      debuggee.id(), debuggee.userFriendlyName(), SDK.Target.Capability.JS,
      this._createConnection.bind(this, debuggee.id()), null, true);
    debuggee.setTarget(target);
    this.dispatchEventToListeners(Ndb.CloudDebuggeeManager.Events.DebuggeeAttached, debuggee);
  }

  _createConnection(id, params) {
    const connection = new Ndb.CloudDebugConnection(id, this._cloudDebugService, this._onWebSocketDisconnected.bind(this, id), params);
    this._connections.set(id, connection);
    return connection;
  }

  _onWebSocketDisconnected(id) {
    this._connections.delete(id);
    this._debuggees.delete(id);
  }

  updateDebuggeeList({keyFile}) {
    this._cloudDebugService.call('updateDebuggeeList', {keyFile});
  }

  updateSnapshotList() {
    this._cloudDebugService.call('updateSnapshotList');
  }

  attachDebuggee({id}) {
    return this._cloudDebugService.call('attach', {id, sourceDirectory: '/usr/local/google/home/eyqs/Downloads/done/devtools-test/'});
  }

  loadSnapshot({id, breakpointId}) {
    return this._cloudDebugService.call('loadSnapshot', {id, breakpointId});
  }
};

/**
 * @implements {Protocol.InspectorBackend.Connection}
 */
Ndb.CloudDebugConnection = class {
  constructor(id, cloudDebugService, onWebSocketDisconnect, params) {
    this._id = id;
    this._cloudDebugService = cloudDebugService;
    this._onDisconnect = params.onDisconnect;
    this._onMessage = params.onMessage;
    this._onWebSocketDisconnect = onWebSocketDisconnect;
    this._cloudDebugService.addEventListener(Ndb.Service.Events.Notification, this._onServiceNotification.bind(this));
  }

  _onServiceNotification({data: {name, params}}) {
    if (name === 'message' && params.id === this._id)
      this._onMessage.call(null, params.message);
    if (name === 'disconnected' && params.id === this._id) {
      this._onWebSocketDisconnect.call(null);
      this._onDisconnect.call(null, 'websocket closed');
    }
  }

  /**
   * @param {string} domain
   * @param {!Protocol.InspectorBackend.Connection.MessageObject} messageObject
   */
  sendMessage(domain, messageObject) {
    return this._cloudDebugService.call('send', {
      id: this._id,
      message: JSON.stringify(messageObject)
    });
  }

  /**
   * @return {!Promise}
   */
  disconnect() {
    return this._cloudDebugService.call('disconnect', {id: this._id})
        .then(_ => this._onDisconnect.call(null, 'force disconnect'));
  }
};

/** @enum {symbol} */
Ndb.CloudDebuggeeManager.Events = {
  DebuggeeAttached: Symbol('debuggee-attached'),
  DebuggeeListUpdated: Symbol('debuggee-list-updated'),
  BreakpointListUpdated: Symbol('breakpoint-list-updated'),
};

Ndb.CloudDebuggeeInfo = class {
  constructor(payload) {
    this._debuggee = payload;
    this._name = `${payload.labels.projectid}, ${payload.labels.version}`;
    this._target = null;
  }
  id() {
    return this._debuggee.id;
  }
   userFriendlyName() {
    return this._name;
  }
  target() {
    return this._target;
  }
  setTarget(target) {
    this._target = target;
  }
};
