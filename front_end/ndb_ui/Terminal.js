/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

Terminal.applyAddon(fit);

Ndb.Terminal = class extends UI.VBox {
  constructor() {
    super(true);
    this.registerRequiredCSS('xterm/dist/xterm.css');
    this.element.addEventListener('contextmenu', this._onContextMenu.bind(this));
  }

  static _createTerminal() {
    const terminal = new Terminal();
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
    terminal.setOption('fontFamily', fontFamily);
    terminal.setOption('fontSize', fontSize);
    terminal.setOption('cursorStyle', 'bar');
    return terminal;
  }

  async _restartService() {
    if (this._backend)
      this._backend.dispose();
    const env = await Ndb.nodeProcessManager.env();
    this._backend = await Ndb.backend.createService(
        'terminal.js',
        rpc.handle(this),
        env,
        this._terminal.cols,
        this._terminal.rows);
    this._anotherTerminalHint(env);
  }

  _anotherTerminalHint(env) {
    this._terminal.write('# Want to use your own terminal? Copy paste following lines..\r\n\r\n');
    this._terminal.write(Object.keys(env).map(k => `export ${k}='${env[k]}'`).join('\r\n') + '\r\n\r\n');
    this._terminal.write('# ..and after you can run any node program (e.g., npm run unit), ndb will detect it.\r\n\r\n');
  }

  /**
   * @param {!Event} event
   */
  _onContextMenu(event) {
    const selection = this._terminal ? this._terminal.getSelection() : null;
    const contextMenu = new UI.ContextMenu(event);
    const copyItem = contextMenu.defaultSection().appendItem(ls`Copy`, () => navigator.clipboard.writeText(selection));
    copyItem.setEnabled(!!selection);
    contextMenu.defaultSection().appendItem(ls`Paste`, async() => {
      if (this._backend)
        this._backend.write(await navigator.clipboard.readText());
    });
    contextMenu.show();
  }

  /**
   * @param {string} error
   */
  async initFailed(error) {
    const env = await Ndb.nodeProcessManager.env();
    this._terminal.write('# Builtin terminal is unvailable: ' + error.split('\n').join('\r\n#') + '\r\n\r\n');
    this._anotherTerminalHint(env);
  }

  /**
   * @param {string} data
   */
  dataAdded(data) {
    if (data.startsWith('Debugger listening on') || data.startsWith('Debugger attached.'))
      return;
    this._terminal.write(data);
  }

  closed() {
    this._restartService();
  }

  /**
   * @param {!{cols: number, rows: number}} size
   */
  _sendResize(size) {
    if (this._backend)
      this._backend.resize(size.cols, size.rows);
  }

  /**
   * @param {string} data
   */
  _sendData(data) {
    if (this._backend)
      this._backend.write(data);
  }

  onResize() {
    this._terminal.fit();
  }

  wasShown() {
    if (this._terminal)
      return;
    this._terminal = Ndb.Terminal._createTerminal();
    this._terminal.open(this.contentElement);
    this._terminal.on('resize', this._sendResize.bind(this));
    this._terminal.on('data', this._sendData.bind(this));
    this._restartService();
  }
};
