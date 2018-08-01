/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

Ndb.Terminal = class extends UI.VBox {
  constructor() {
    super(true);
    this.registerRequiredCSS('node_modules/xterm/dist/xterm.css');
    Terminal.applyAddon(fit);
    this._term = null;
    this._service = null;

    this._buffer = '';
    this._ready = false;

    this._terminalShownCallback = null;
    this._terminalPromise = new Promise(resolve => this._terminalShownCallback = resolve);
    this._init();
  }

  async _init() {
    this._service = await Ndb.serviceManager.create('terminal');
    await this._terminalPromise;
    this._terminal.on('resize', size => this._service.call('resize', {cols: size.cols, rows: size.rows}));
    this._terminal.on('data', data => {
      if (this._ready)
        this._service.call('write', {data: data});
      else
        this._buffer += data;
    });
    this._service.addEventListener(Ndb.Service.Events.Notification, this._onNotification.bind(this));
    this._initService();
  }

  _onNotification({data: {name, params}}) {
    if (name === 'data')
      this._terminal.write(params.data);
    if (name === 'close')
      this._initService();
  }

  async _initService() {
    this._ready = false;
    const nddStore = await (await Ndb.NodeProcessManager.instance()).nddStore();
    const {error} = await this._service.call('init', {
      cols: this._terminal.cols,
      rows: this._terminal.rows,
      nddStore: nddStore,
      preload: NdbProcessInfo.preload
    });
    this._ready = true;
    if (this._buffer.length) {
      this._service.call('write', {data: this._buffer});
      this._buffer = '';
    }
    if (error)
      this._showInitError(error);
  }

  _showInitError(error) {
    this.contentElement.removeChildren();
    this.contentElement.createChild('div').textContent = error;
  }

  wasShown() {
    if (this._terminalShownCallback) {
      this._terminal = new Terminal();

      let fontFamily;
      let fontSize = 11;
      if (Host.isMac()) {
        fontFamily = 'Menlo, monospace';
      } else if (Host.isWin()) {
        fontFamily = 'Consolas, Lucida Console, Courier New, monospace';
        fontSize = 12;
      } else {
        fontFamily = 'dejavu sans mono, monospace';
      }
      this._terminal.setOption('fontFamily', fontFamily);
      this._terminal.setOption('fontSize', fontSize);
      this._terminal.setOption('cursorStyle', 'bar');

      this._terminal.open(this.contentElement);
      this._terminalShownCallback(this._terminal);
      delete this._terminalShownCallback;
    }
    this._terminal.fit();
  }

  onResize() {
    if (this._terminal)
      this._terminal.fit();
  }
};
