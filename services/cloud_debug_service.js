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
const uuidv4 = require('uuid/v4');
const {DebugProxy} = require('@google-cloud/debug-proxy-common');
const {Adapter, parseScripts} = require('cloud-debug-nodejs-devtools');
const {ServiceBase} = require('./service_base.js');
const adapterSymbol = Symbol('Adapter');
const debugProxySymbol = Symbol('DebugProxy');
const ALLOWED_METHOD_LIST = [
  'Debugger.removeBreakpoint', 'Debugger.setBreakpointByUrl'];

class CloudDebugService extends ServiceBase {
  constructor() {
    super();
    this._keyFileMap = new Map();
    this._debuggeeMap = new Map();
  }
   /* Flow of control:
   * 1. CloudDebugMain.js:_create() calls Ndb.serviceManager.create()
   *    to spawn a new cloudDebugService as a separate process.
   * 2. When the user opens the Cloud Debuggees sidebar to select a debuggee,
   *    CloudDebuggees.js:CloudDebuggees() calls _manager.updateDebuggeeList().
   * 3. NdbMain.js:updateDebuggeeList() calls the following function.
   * 4. This function runs, then sends a 'debuggeeListUpdated' notification.
   * 5. NdbMain.js:_onCloudDebugNotification receives the debuggeeList.
   * 6. NdbMain.js:_onDebuggeeListUpdated() sends a DebuggeeListUpdated event.
   * 7. CloudDebuggees.js:_onDebuggeeListUpdated() receives the debuggeeList.
   */
  async updateDebuggeeList({keyFile}) {
    // Temporary debug proxy instantiated to list available debuggees.
    const debugProxy = new DebugProxy({debuggerId: uuidv4(), sourceDirectory: ''});
    await debugProxy.setProjectByKeyFile(keyFile);
    const debuggeeList = await debugProxy.getDebuggees();
    for (const debuggee of debuggeeList) {
      this._keyFileMap.set(debuggee.id, keyFile);
      this._debuggeeMap.set(debuggee.id, debuggee);
    }
    this._notify('debuggeeListUpdated', {debuggeeList});
  }
  async attach({id, sourceDirectory}) {
    const keyFile = this._keyFileMap.get(id);
    const debuggee = this._debuggeeMap.get(id);
    if (!debuggee) {
      throw new Error('No debuggee with given id');
    }
    if (debuggee[adapterSymbol]) {
      throw new Error('Already attached to debuggee with given id');
    }
    const debugProxy = new DebugProxy({debuggerId: uuidv4(), sourceDirectory});
    const adapter = new Adapter(debugProxy);
    debuggee[debugProxySymbol] = debugProxy;
    debuggee[adapterSymbol] = adapter;
    await debugProxy.setProjectByKeyFile(keyFile);
    debugProxy.setDebuggeeId(id);
    adapter.on('updateBreakpointList', (breakpointIdLists) => {
      this._notify('breakpointListUpdated', {id, breakpointIdLists});
    });
    this._notify('attached', {id});

    await parseStripts((message) => this._notify({id, message}), adapter.getSourceDirectory());
    adapter.pollForPendingBreakpoints();
  }
  async loadSnapshot({id, breakpointId}) {
    const debuggee = this._debuggeeMap.get(id);
    if (!debuggee) {
      throw new Error('No debuggee with given id');
    }
    if (!debuggee[adapterSymbol]) {
      throw new Error('Not attached to debuggee with given id');
    }
    const params = await debuggee[adapterSymbol].loadSnapshot(breakpointId);
    this._notify('message', {id, message: {method: 'Debugger.paused', params: params}});
  }
  async send({id, message}) {
    const debuggee = this._debuggeeMap.get(id);
    if (!debuggee) {
      throw new Error('No debuggee with given id');
    }
    if (!debuggee[adapterSymbol]) {
      throw new Error('Not attached to debuggee with given id');
    }
    const request = JSON.parse(message);
    for (const method of ALLOWED_METHOD_LIST) {
      if (request.method === method) {
        const result = await debuggee[adapterSymbol].processRequest(request);
        this._notify('message', {id, message: {id: request.id, result}});
      }
    }
  }
}

new CloudDebugService();
