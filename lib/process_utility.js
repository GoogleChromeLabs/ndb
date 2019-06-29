/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

module.exports = prepareProcess;

function prepareProcess(name, disposeCallback) {
  process.title = 'ndb/' + name;
  function silentRpcErrors(error) {
    if (!process.connected && error.code === 'ERR_IPC_CHANNEL_CLOSED')
      return;
    throw error;
  }
  process.on('uncaughtException', silentRpcErrors);
  process.on('unhandledRejection', silentRpcErrors);
  // dispose when child process is disconnected
  process.on('disconnect', () => disposeCallback());
}
