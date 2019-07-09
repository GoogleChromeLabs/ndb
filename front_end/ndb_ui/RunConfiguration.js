/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

Ndb.RunConfiguration = class extends UI.VBox {
  constructor() {
    super(true);
    this.registerRequiredCSS('ndb_ui/runConfiguration.css');
    this._items = new UI.ListModel();
    this._list = new UI.ListControl(this._items, this, UI.ListMode.NonViewport);
    this.contentElement.appendChild(this._list.element);
    this.update();
  }

  async update() {
    const configurations = [];
    const main = await Ndb.mainConfiguration();
    if (main)
      configurations.push(main);
    const pkg = await Ndb.backend.pkg();
    if (pkg) {
      const scripts = pkg.scripts || {};
      this._items.replaceAll(configurations.concat(Object.keys(scripts).map(name => ({
        name,
        command: scripts[name],
        args: ['run', name]
      }))));
    }
  }

  /**
   * @override
   * @param {!SDK.DebuggerModel} debuggerModel
   * @return {!Element}
   */
  createElementForItem(item) {
    const f = UI.Fragment.build`
    <div class=list-item>
      <div class=configuration-item>
        <div>${item.name}</div>
        <div class=configuration-command>${item.command}</div>
      </div>
      <div class='controls-container fill'>
        <div class=controls-gradient></div>
        <div $=controls-buttons class=controls-buttons></div>
      </div>
    </div>`;
    const buttons = f.$('controls-buttons');
    const toolbar = new UI.Toolbar('', buttons);
    const runButton = new UI.ToolbarButton(Common.UIString('Run'), 'largeicon-play');
    runButton.addEventListener(UI.ToolbarButton.Events.Click, this._runConfig.bind(this, item.execPath, item.args));
    toolbar.appendToolbarItem(runButton);
    const profileButton = new UI.ToolbarButton(Common.UIString('Start recording..'), 'largeicon-start-recording');
    profileButton.addEventListener(UI.ToolbarButton.Events.Click, this._profileConfig.bind(this, item.execPath, item.args));
    toolbar.appendToolbarItem(profileButton);
    return f.element();
  }

  async _runConfig(execPath, args) {
    await Ndb.nodeProcessManager.debug(execPath || await Ndb.npmExecPath(), args);
  }

  async _profileConfig(execPath, args) {
    await Ndb.nodeProcessManager.profile(execPath || await Ndb.npmExecPath(), args);
  }

  /**
   * @override
   * @param {!SDK.DebuggerModel} debuggerModel
   * @return {number}
   */
  heightForItem(debuggerModel) {
    return 12;
  }

  /**
   * @override
   * @param {!SDK.DebuggerModel} debuggerModel
   * @return {boolean}
   */
  isItemSelectable(debuggerModel) {
    return false;
  }

  /**
   * @override
   * @param {?Profiler.IsolateSelector.ListItem} from
   * @param {?Profiler.IsolateSelector.ListItem} to
   * @param {?Element} fromElement
   * @param {?Element} toElement
   */
  selectedItemChanged(from, to, fromElement, toElement) {}
};
