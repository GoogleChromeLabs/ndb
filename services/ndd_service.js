/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const net = require('net');
const { fileURLToPath } = require('../lib/filepath_to_url.js');

const protocolDebug = require('debug')('ndd_service:protocol');
const caughtErrorDebug = require('debug', 'ndd_service:caught');
const { rpc, rpc_process } = require('carlo/rpc');
const WebSocket = require('ws');

function silentRpcErrors(error) {
  if (!process.connected && error.code === 'ERR_IPC_CHANNEL_CLOSED')
    return;
  throw error;
}

process.on('uncaughtException', silentRpcErrors);
process.on('unhandledRejection', silentRpcErrors);

const DebugState = {
  WS_OPEN: 1,
  WS_ERROR: 2,
  WS_CLOSE: 3,
  PROCESS_DISCONNECT: 4
};

const CALL_EXIT_MESSAGE = JSON.stringify({
  id: -1,
  method: 'Runtime.evaluate',
  params: { expression: 'process.exit(-1)' }
});

class Channel {
  /**
   * @param {!WebSocket} ws
   */
  constructor(ws) {
    this._ws = ws;
    this._handler = null;
    this._messageListener = this._messageReceived.bind(this);
    this._ws.on('message', this._messageListener);
  }

  /**
   * @param {string} message
   */
  send(message) {
    if (this._ws.readyState === WebSocket.OPEN) {
      protocolDebug('>', message);
      this._ws.send(message);
    }
  }

  close() {
    this._ws.close();
  }

  /**
   * @param {!Object}
   */
  listen(handler) {
    this._handler = handler;
  }

  dispose() {
    this._ws.removeListener('message', this._messageListener);
  }

  /**
   * @param {string} message
   */
  _messageReceived(message) {
    if (this._handler) {
      protocolDebug('<', message);
      this._handler.dispatchMessage(message);
    }
  }
}

class NddService {
  constructor(frontend) {
    process.title = 'ndb/ndd_service';
    this._disconnectPromise = new Promise(resolve => process.once('disconnect', () => resolve(DebugState.PROCESS_DISCONNECT)));
    this._connected = new Set();
    this._frontend = frontend;

    const pipePrefix = process.platform === 'win32' ? '\\\\.\\pipe\\' : os.tmpdir();
    const pipeName = `node-ndb.${process.pid}.sock`;
    this._pipe = path.join(pipePrefix, pipeName);
    const server = net.createServer(socket => {
      socket.on('data', async d => {
        const runSession = await this._startSession(JSON.parse(d), frontend);
        socket.write('run');
        runSession();
      });
      socket.on('error', e => caughtErrorDebug(e));
    }).listen(this._pipe);
    server.unref();
  }

  dispose() {
    process.disconnect();
  }

  async _startSession(info, frontend) {
    const ws = new WebSocket(info.inspectorUrl);
    const openPromise = new Promise(resolve => ws.once('open', () => resolve(DebugState.WS_OPEN)));
    const errorPromise = new Promise(resolve => ws.once('error', () => resolve(DebugState.WS_ERROR)));
    const closePromise = new Promise(resolve => ws.once('close', () => resolve(DebugState.WS_CLOSE)));
    let state = await Promise.race([openPromise, errorPromise, closePromise, this._disconnectPromise]);
    if (state === DebugState.WS_OPEN) {
      this._connected.add(info.id);
      const channel = new Channel(ws);
      state = await Promise.race([frontend.detected(info, rpc.handle(channel)), this._disconnectPromise]);
      return async() => {
        if (state !== DebugState.PROCESS_DISCONNECT)
          state = await Promise.race([closePromise, errorPromise, this._disconnectPromise]);
        channel.dispose();
        this._connected.delete(info.id);
        if (state !== DebugState.PROCESS_DISCONNECT)
          frontend.disconnected(info.id);
        else
          ws.send(CALL_EXIT_MESSAGE, () => ws.close());
      };
    } else {
      return async function() {};
    }
  }

  env() {
    return {
      NODE_OPTIONS: `--require ndb/preload.js`,
      NODE_PATH: `${process.env.NODE_PATH || ''}${path.delimiter}${path.join(__dirname, '..', 'lib', 'preload')}`,
      NDD_IPC: this._pipe
    };
  }

  async debug(execPath, args, options) {
    const env = this.env();
    if (options.data)
      env.NDD_DATA = options.data;
    const p = spawn(execPath, args, {
      cwd: options.cwd ? fileURLToPath(options.cwd) : undefined,
      env: { ...process.env, ...env },
      stdio: options.ignoreOutput ? 'ignore' : ['inherit', 'pipe', 'pipe'],
      windowsHide: true
    });
    if (!options.ignoreOutput) {
      p.stderr.on('data', data => {
        if (process.connected)
          this._frontend.terminalData('stderr', data.toString('base64'));
      });
      p.stdout.on('data', data => {
        if (process.connected)
          this._frontend.terminalData('stdout', data.toString('base64'));
      });
    }
    const finishPromise = new Promise(resolve => {
      p.once('exit', resolve);
      p.once('error', resolve);
    });
    const result = await Promise.race([finishPromise, this._disconnectPromise]);
    if (result === DebugState.PROCESS_DISCONNECT && !this._connected.has(p.pid)) {
      // The frontend can start the process but disconnects before it is
      // finished if it is blackboxed (e.g., npm process); in this case, we need
      // to kill this process here.
      p.kill();
    }
  }
}

rpc_process.init(frontend => rpc.handle(new NddService(frontend)));
