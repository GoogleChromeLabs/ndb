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
Ndb.CloudDebuggees = class extends UI.VBox {
  constructor() {
    super(true);
    this._emptyElement = this.contentElement.createChild('div', 'gray-info-message');
    this._emptyElement.textContent = Common.UIString('No running debuggees');

    this._treeOutline = new UI.TreeOutlineInShadow();
    this.contentElement.appendChild(this._treeOutline.element);
    this._treeOutline.element.classList.add('hidden');

    this._debuggeeToUI = new Map();

    Ndb.CloudDebuggeeManager.instance().then((manager) => {
      this._manager = manager;
      this._manager.addEventListener(Ndb.CloudDebuggeeManager.Events.DebuggeeAttached, this._onDebuggeeAttached, this);
      this._manager.addEventListener(Ndb.CloudDebuggeeManager.Events.DebuggeeListUpdated, this._onDebuggeeListUpdated, this);
      UI.context.addFlavorChangeListener(SDK.Target, this._targetFlavorChanged, this);
      this._manager.updateDebuggeeList({keyFile: ''});
    });
  }

  _onDebuggeeAttached({data: debuggee}) {
    UI.context.setFlavor(SDK.Target, debuggee.target());
    const ui = this._debuggeeToUI.get(debuggee);
    if (!ui) {
      throw new Error('No UI with given id');
    }
    ui.f.$('state').textContent = 'attached';
  }

  _onDebuggeeListUpdated({data: debuggeeList}) {
    for (const debuggee of debuggeeList) {
      const f = UI.Fragment.build`
        <div class=process-item>
          <div class=process-title>${debuggee.userFriendlyName()}</div>
          <div $=state class=process-item-state></div>
        </div>
      `;
      f.$('state').textContent = debuggee.target() ? 'attached' : 'detached';

      const treeElement = new UI.TreeElement(f.element());
      treeElement.onselect = async () => {
        if (!debuggee.target()) {
          await this._manager.attachDebuggee({id: debuggee.id()});
        } else if (UI.context.flavor(SDK.Target) !== debuggee.target()) {
          UI.context.setFlavor(SDK.Target, debuggee.target());
        }
      };

      let parentTreeElement = this._treeOutline.rootElement();
      parentTreeElement.appendChild(treeElement);
      parentTreeElement.expand();

      if (!this._debuggeeToUI.size) {
        this._emptyElement.classList.add('hidden');
        this._treeOutline.element.classList.remove('hidden');
      }
      this._debuggeeToUI.set(debuggee, {treeElement, f});
    }
  }

  _targetFlavorChanged({data: target}) {
    for (const [debuggee, {treeElement}] of this._debuggeeToUI) {
      if (debuggee.target() === target) {
        treeElement.select();
      }
    }
  }
};
