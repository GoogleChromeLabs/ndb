/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

Sources.ThreadsSidebarPane.shouldBeShown = () => false;
Sources.SourcesPanel.instance()._showThreadsIfNeeded = function() {
  this._threadsSidebarPane = /** @type {!UI.View} */ (UI.viewManager.view('ndb.runningProcesses'));
  if (this._sidebarPaneStack) {
    this._sidebarPaneStack.showView(
        this._threadsSidebarPane, this._splitWidget.isVertical() ? this._watchSidebarPane : this._callstackPane);
  }
};
Sources.SourcesPanel.instance()._showThreadsIfNeeded();

UI.context.addFlavorChangeListener(SDK.DebuggerPausedDetails, _ => {
  const details = UI.context.flavor(SDK.DebuggerPausedDetails);
  if (!details)
    UI.context.setFlavor(SDK.DebuggerModel.CallFrame, null);
});

Ndb.NodeProcesses = class extends UI.VBox {
  constructor() {
    super(true);
    this.registerRequiredCSS('ndb_ui/nodeProcesses.css');

    const toolbar = new UI.Toolbar('process-toolbar', this.contentElement);
    this._pauseAtStartCheckbox = new UI.ToolbarSettingCheckbox(
        Common.moduleSetting('pauseAtStart'), Common.UIString('Pause at start'),
        Common.UIString('Pause at start'));
    this._pauseAtStartCheckbox.element.id = 'pause-at-start-checkbox';
    toolbar.appendToolbarItem(this._pauseAtStartCheckbox);
    this._waitAtEndCheckbox = new UI.ToolbarSettingCheckbox(
        Common.moduleSetting('waitAtEnd'), Common.UIString('Wait for manual disconnect'),
        Common.UIString('Wait at end'));
    toolbar.appendToolbarItem(this._waitAtEndCheckbox);

    this._emptyElement = this.contentElement.createChild('div', 'gray-info-message');
    this._emptyElement.id = 'no-running-nodes-msg';
    this._emptyElement.textContent = Common.UIString('No running nodes');

    this._treeOutline = new UI.TreeOutlineInShadow();
    this._treeOutline.registerRequiredCSS('ndb_ui/nodeProcesses.css');
    this.contentElement.appendChild(this._treeOutline.element);
    this._treeOutline.element.classList.add('hidden');

    this._instanceToUI = new Map();

    Ndb.NodeProcessManager.instance().then(manager => {
      this._manager = manager;
      this._manager.addEventListener(Ndb.NodeProcessManager.Events.Added, this._onProcessAdded, this);
      this._manager.addEventListener(Ndb.NodeProcessManager.Events.Finished, this._onProcessFinished, this);
      this._manager.addEventListener(Ndb.NodeProcessManager.Events.Attached, this._onAttached, this);
      this._manager.addEventListener(Ndb.NodeProcessManager.Events.Detached, this._onDetached, this);
      UI.context.addFlavorChangeListener(SDK.Target, this._targetFlavorChanged, this);
      for (const instance of this._manager.existingInstances())
        this._onProcessAdded({data: instance});
    });
  }

  /**
   * @param {!Ndb.NodeProcess} instance
   */
  _onProcessAdded({data: instance}) {
    if (instance.isRepl())
      return;
    const f = UI.Fragment.build`
      <div class=process-item>
        <div class=process-title>${instance.userFriendlyName()}</div>
        <div $=state class=process-item-state></div>
      </div>
      <div class='controls-container fill'>
        <div class=controls-gradient></div>
        <div $=controls-buttons class=controls-buttons></div>
      </div>
    `;
    f.$('state').textContent = instance.target() ? 'attached' : 'detached';

    const buttons = f.$('controls-buttons');
    const toolbar = new UI.Toolbar('', buttons);
    const runButton = new UI.ToolbarButton(Common.UIString('Kill'), 'largeicon-terminate-execution');
    runButton.addEventListener(UI.ToolbarButton.Events.Click, this._killInstance.bind(this, instance));
    toolbar.appendToolbarItem(runButton);

    const treeElement = new UI.TreeElement(f.element());
    treeElement.onselect = _ => {
      if (UI.context.flavor(SDK.Target) !== instance.target())
        UI.context.setFlavor(SDK.Target, instance.target());
    };

    let parentTreeElement = this._treeOutline.rootElement();
    if (instance.parent()) {
      const parentUI = this._instanceToUI.get(instance.parent());
      if (parentUI)
        parentTreeElement = parentUI.treeElement;
    }
    parentTreeElement.appendChild(treeElement);
    parentTreeElement.expand();

    if (!this._instanceToUI.size) {
      this._emptyElement.classList.add('hidden');
      this._treeOutline.element.classList.remove('hidden');
    }
    this._instanceToUI.set(instance, {treeElement, f});
  }

  _killInstance(instance) {
    this._manager.kill(instance);
  }

  /**
   * @param {!Ndb.NodeProcess} instance
   */
  _onProcessFinished({data: instance}) {
    const ui = this._instanceToUI.get(instance);
    if (ui) {
      const parentTreeElement = ui.treeElement.parent;
      for (const child of ui.treeElement.children()) {
        ui.treeElement.removeChild(child);
        parentTreeElement.appendChild(child);
      }
      parentTreeElement.removeChild(ui.treeElement);
      this._instanceToUI.delete(instance);
    }
    if (!this._instanceToUI.size) {
      this._emptyElement.classList.remove('hidden');
      this._treeOutline.element.classList.add('hidden');
    }
  }

  _onAttached({data: instance}) {
    const ui = this._instanceToUI.get(instance);
    if (!ui)
      return;

    const debuggerModel = instance.target().model(SDK.DebuggerModel);
    debuggerModel.addEventListener(SDK.DebuggerModel.Events.DebuggerPaused, () => {
      ui.f.$('state').textContent = 'paused';
    });
    debuggerModel.addEventListener(SDK.DebuggerModel.Events.DebuggerResumed, () => {
      ui.f.$('state').textContent = 'attached';
    });
    ui.f.$('state').textContent = 'attached';
  }

  _onDetached({data: instance}) {
    const ui = this._instanceToUI.get(instance);
    if (ui)
      ui.f.$('state').textContent = 'detached';
  }

  _targetFlavorChanged({data: target}) {
    for (const [instance, {treeElement}] of this._instanceToUI) {
      if (instance.target() === target)
        treeElement.select();
    }
  }
};
