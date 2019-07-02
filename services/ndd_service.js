/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const net = require('net');

const protocolDebug = require('debug')('ndd_service:protocol');
const caughtErrorDebug = require('debug', 'ndd_service:caught');
const { rpc, rpc_process } = require('carlo/rpc');
const WebSocket = require('ws');

const NDB_VERSION = require('../package.json').version;

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

class NddService {
  constructor(frontend) {
    process.title = 'ndb/ndd_service';
    this._disconnectPromise = new Promise(resolve => process.once('disconnect', () => resolve(DebugState.PROCESS_DISCONNECT)));
    this._sockets = new Map();

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

  async _startSession(info, frontend, resumeTarget) {
    const ws = new WebSocket(info.inspectorUrl);
    const openPromise = new Promise(resolve => ws.once('open', () => resolve(DebugState.WS_OPEN)));
    const errorPromise = new Promise(resolve => ws.once('error', () => resolve(DebugState.WS_ERROR)));
    const closePromise = new Promise(resolve => ws.once('close', () => resolve(DebugState.WS_CLOSE)));
    let state = await Promise.race([openPromise, errorPromise, closePromise, this._disconnectPromise]);
    if (state === DebugState.WS_OPEN) {
      const messageListener = messageString => {
        const message = JSON.parse(messageString);
        message.sessionId = info.id;
        protocolDebug('<', message);
        frontend.dispatchMessage(message);
      };
      ws.on('message', messageListener);
      this._sockets.set(info.id, ws);
      state = await Promise.race([frontend.detected(info), this._disconnectPromise]);
      return async() => {
        if (state !== DebugState.PROCESS_DISCONNECT)
          state = await Promise.race([closePromise, errorPromise, this._disconnectPromise]);
        ws.removeListener('message', messageListener);
        this._sockets.delete(info.id);
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
      NODE_OPTIONS: `--require ndb/preload.js --inspect=0`,
      NODE_PATH: `${process.env.NODE_PATH || ''}${path.delimiter}${path.join(__dirname, '..', 'lib', 'preload')}`,
      NDD_IPC: this._pipe,
      NDB_VERSION
    };
  }

  async debug(execPath, args, options) {
    const env = this.env();
    if (options.data)
      env.NDD_DATA = options.data;
    const p = spawn(execPath, args, {
      cwd: options.cwd,
      env: { ...process.env, ...env },
      stdio: options.ignoreOutput ? 'ignore' : ['inherit', 'inherit', 'pipe'],
      windowsHide: true
    });
    if (!options.ignoreOutput) {
      const filter = [
        Buffer.from('Debugger listening on', 'utf8'),
        Buffer.from('Waiting for the debugger to disconnect...', 'utf8'),
        Buffer.from('Debugger attached.', 'utf8')
      ];
      p.stderr.on('data', data => {
        for (const prefix of filter) {
          if (Buffer.compare(data.slice(0, prefix.length), prefix) === 0)
            return;
        }
        process.stderr.write(data);
      });
    }
    const finishPromise = new Promise(resolve => {
      p.once('exit', resolve);
      p.once('error', resolve);
    });
    const result = await Promise.race([finishPromise, this._disconnectPromise]);
    if (result === DebugState.PROCESS_DISCONNECT && !this._sockets.has(p.pid)) {
      // The frontend can start the process but disconnects before it is
      // finished if it is blackboxed (e.g., npm process); in this case, we need
      // to kill this process here.
      p.kill();
    }
  }

  sendMessage(messageString) {
    const message = JSON.parse(messageString);
    const socket = this._sockets.get(message.sessionId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      delete message.sessionId;
      protocolDebug('>', message);
      socket.send(JSON.stringify(message));
    }
  }

  disconnect(sessionId) {
    const socket = this._sockets.get(sessionId);
    if (socket)
      socket.close();
  }
}

rpc_process.init(frontend => rpc.handle(new NddService(frontend)));
