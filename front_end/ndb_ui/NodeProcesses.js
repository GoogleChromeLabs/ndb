/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

Ndb.NodeProcesses = class extends UI.VBox {
  constructor() {
    super(true);
    this.registerRequiredCSS('ndb_ui/nodeProcesses.css');

    const toolbar = new UI.Toolbar('process-toolbar', this.contentElement);
    this._pauseAtStartCheckbox = new UI.ToolbarSettingCheckbox(
        Common.moduleSetting('pauseAtStart'));
    this._pauseAtStartCheckbox.element.id = 'pause-at-start-checkbox';
    toolbar.appendToolbarItem(this._pauseAtStartCheckbox);

    this._emptyElement = this.contentElement.createChild('div', 'gray-info-message');
    this._emptyElement.id = 'no-running-nodes-msg';
    this._emptyElement.textContent = Common.UIString('No running nodes');

    this._treeOutline = new UI.TreeOutlineInShadow();
    this._treeOutline.registerRequiredCSS('ndb_ui/nodeProcesses.css');
    this.contentElement.appendChild(this._treeOutline.element);
    this._treeOutline.element.classList.add('hidden');

    this._targetToUI = new Map();
    SDK.targetManager.observeTargets(this);
  }

  /**
   * @override
   * @param {!SDK.Target} target
   */
  targetAdded(target) {
    if (target.id() === '<root>')
      return;
    if (target.name() === 'repl')
      return;
    const f = UI.Fragment.build`
      <div class=process-item>
        <div class=process-title>${target.name()}</div>
        <div $=state class=process-item-state></div>
      </div>
      <div class='controls-container fill'>
        <div class=controls-gradient></div>
        <div $=controls-buttons class=controls-buttons></div>
      </div>
    `;
    const debuggerModel = target.model(SDK.DebuggerModel);
    debuggerModel.addEventListener(SDK.DebuggerModel.Events.DebuggerPaused, () => {
      f.$('state').textContent = 'paused';
    });
    debuggerModel.addEventListener(SDK.DebuggerModel.Events.DebuggerResumed, () => {
      f.$('state').textContent = 'attached';
    });
    f.$('state').textContent = debuggerModel.isPaused() ? 'paused' : 'attached';

    const buttons = f.$('controls-buttons');
    const toolbar = new UI.Toolbar('', buttons);
    const button = new UI.ToolbarButton(Common.UIString('Kill'), 'largeicon-terminate-execution');
    button.addEventListener(UI.ToolbarButton.Events.Click, _ => Ndb.nodeProcessManager.kill(target));
    toolbar.appendToolbarItem(button);

    const treeElement = new UI.TreeElement(f.element());
    treeElement.onselect = _ => {
      if (UI.context.flavor(SDK.Target) !== target)
        UI.context.setFlavor(SDK.Target, target);
    };

    const parentTarget = target.parentTarget();
    let parentTreeElement = this._treeOutline.rootElement();
    if (parentTarget) {
      const parentUI = this._targetToUI.get(parentTarget);
      if (parentUI)
        parentTreeElement = parentUI.treeElement;
    }
    parentTreeElement.appendChild(treeElement);
    parentTreeElement.expand();

    if (!this._targetToUI.size) {
      this._emptyElement.classList.add('hidden');
      this._treeOutline.element.classList.remove('hidden');
    }
    this._targetToUI.set(target, {treeElement, f});
  }

  /**
   * @override
   * @param {!SDK.Target} target
   */
  targetRemoved(target) {
    const ui = this._targetToUI.get(target);
    if (ui) {
      const parentTreeElement = ui.treeElement.parent;
      for (const child of ui.treeElement.children().slice()) {
        ui.treeElement.removeChild(child);
        parentTreeElement.appendChild(child);
      }
      parentTreeElement.removeChild(ui.treeElement);
      this._targetToUI.delete(target);
    }
    if (!this._targetToUI.size) {
      this._emptyElement.classList.remove('hidden');
      this._treeOutline.element.classList.add('hidden');
    }
  }

  _targetFlavorChanged({data: target}) {
    const treeElement = this._targetToUI.get(target);
    if (treeElement)
      treeElement.select();
  }
};
