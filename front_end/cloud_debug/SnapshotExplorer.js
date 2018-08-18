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
Ndb.SnapshotExplorer = class extends UI.VBox {
  constructor() {
    super(true);

    this._treeOutline = new UI.TreeOutlineInShadow();
    this.contentElement.appendChild(this._treeOutline.element);

    Ndb.CloudDebuggeeManager.instance().then((manager) => {
      this._manager = manager;
      this._manager.addEventListener(Ndb.CloudDebuggeeManager.Events.DebuggeeAttached, this._onDebuggeeAttached, this);
      this._manager.addEventListener(Ndb.CloudDebuggeeManager.Events.BreakpointListUpdated, this._onBreakpointListUpdated, this);
    });
  }

  _onDebuggeeAttached({data: debuggee}) {}

  _onBreakpointListUpdated({data: {id, breakpointIdLists: {pendingSnapshotIdList, capturedSnapshotIdList}}}) {
    // TODO: pendingSnapshotIdList
    for (const breakpointId of capturedSnapshotIdList) {
      const f = UI.Fragment.build`
        <div class=process-item>
          <div class=process-title>${breakpointId}</div>
        </div>
      `;

      const treeElement = new UI.TreeElement(f.element());
      treeElement.onselect = async () => {
        await this._manager.loadSnapshot({id, breakpointId});
      };

      let parentTreeElement = this._treeOutline.rootElement();
      parentTreeElement.appendChild(treeElement);
      parentTreeElement.expand();
    }
  }
};
