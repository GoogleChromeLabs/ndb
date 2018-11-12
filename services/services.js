/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const {fork} = require('child_process');
const fs = require('fs');
const path = require('path');

class Services {
  constructor(notify) {
    this._notify = notify;
    this._serviceIdToService = new Map();
    this._lastServiceId = 0;
    this._lastCallbackId = 0;
    this._isDisposed = false;
  }

  static async create(frontend) {
    let buffer = [];
    let timer = 0;
    const services = new Services((serviceId, callId, payload) => {
      if (!timer) {
        timer = setTimeout(_ => {
          timer = 0;
          const expression = `Ndb.serviceManager.notify(${JSON.stringify(buffer)})`;
          buffer = [];
          frontend.evaluate(process.env.NDB_DEBUG_FRONTEND ? `callFrontend(_ => ${expression}),null` : `${expression},null`);
        }, 50);
      }
      buffer.push({serviceId, callId, payload});
    });
    await Promise.all([
      frontend.exposeFunction('createNdbService', services.createNdbService.bind(services)),
      frontend.exposeFunction('callNdbService', services.callNdbService.bind(services))
    ]);
    frontend.on('exit', services.dispose.bind(services));
    return services;
  }

  _onBindingCalled(event) {
    if (event.name !== 'callNdbService')
      return;
    const {serviceId, callId, method, options} = JSON.parse(event.payload);
    this.callNdbService(serviceId, callId, method, options);
  }

  createNdbService(name, serviceDir) {
    const serviceName = path.join(serviceDir, `${name}.js`);
    if (!fs.existsSync(serviceName))
      return {error: `Service with given name=${name} not found`};
    const serviceId = ++this._lastServiceId;
    const service = fork(serviceName, []);
    service.on('exit', this._onServiceExit.bind(this, serviceId));
    service.on('message', this._onServiceMessage.bind(this, serviceId));
    return new Promise(resolve => this._serviceIdToService.set(serviceId, {
      service,
      callbacks: new Map(),
      disposeCallbacks: new Set(),
      readyCallback: resolve
    })).then(_ => ({serviceId}));
  }

  callNdbService(args) {
    const {serviceId, callId, method, options} = args;
    const {service, callbacks, disposeCallbacks} = this._serviceIdToService.get(serviceId) || {};
    if (!service) {
      this._notify(serviceId, callId, {error: `Service with id=${serviceId} not found`});
      return;
    }
    const callbackId = ++this._lastCallbackId;
    callbacks.set(callbackId, this._notify.bind(this, serviceId, callId));
    if (method === 'dispose')
      disposeCallbacks.add(callbackId);
    service.send({
      method,
      options,
      callbackId
    });
  }

  _disposeService(serviceId) {
    const {service, callbacks, disposeCallbacks} = this._serviceIdToService.get(serviceId) || {};
    if (!service)
      return;
    const callbackId = ++this._lastCallbackId;
    disposeCallbacks.add(callbackId);
    service.send({method: 'dispose', options: {}, callbackId});
    return new Promise(resolve => callbacks.set(callbackId, resolve));
  }

  dispose() {
    if (this._isDisposed)
      return;
    this._isDisposed = true;
    const serviceIds = Array.from(this._serviceIdToService.keys());
    return Promise.all(serviceIds.map(serviceId => this._disposeService(serviceId)));
  }

  _onServiceMessage(serviceId, {message, callbackId}) {
    const {service, callbacks, readyCallback} = this._serviceIdToService.get(serviceId) || {};
    if (!service) {
      this._notify(serviceId, undefined, {error: `Service with id=${serviceId} not found`});
      return;
    }
    if (callbackId) {
      const callback = callbacks.get(callbackId);
      callbacks.delete(callbackId);
      callback(message);
    } else {
      if (message.name === 'ready')
        readyCallback();
      else
        this._notify(serviceId, undefined, message);
    }
  }

  _onServiceExit(serviceId) {
    const {service, callbacks, disposeCallbacks} = this._serviceIdToService.get(serviceId) || {};
    if (!service)
      return;
    this._serviceIdToService.delete(serviceId);
    for (const [id, callback] of callbacks) {
      if (disposeCallbacks.has(id))
        callback({result: {}});
      else
        callback({error: `Service with id=${serviceId} was disposed`});
    }
    this._notify(serviceId, undefined, { name: 'disposed' });
  }
}

module.exports = {Services};
