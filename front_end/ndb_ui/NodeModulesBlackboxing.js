/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

/**
 * @implements {UI.ListWidget.Delegate}
 */
Ndb.NodeModulesBlackboxing = class extends UI.VBox {
  constructor() {
    super(true);
    this.registerRequiredCSS('ndb_ui/nodeModulesBlackboxing.css');
    
    this.contentElement.createChild('div', 'header').textContent = ls`Node modules whitelist`;

    this._items = new UI.ListModel();
    this._list = new UI.ListControl(this._items, this, UI.ListMode.NonViewport);
    this._list.element.classList.add('dependency-list');
    this.contentElement.appendChild(this._list.element);

    this._emptyPlaceholder = createElementWithClass('div', 'dependency-list-empty');
    this._emptyPlaceholder.textContent = Common.UIString('No dependencies');

    this.contentElement.tabIndex = 0;
    this.contentElement.appendChild(this._emptyPlaceholder);

    this._reloadButton = this.contentElement.appendChild(
        UI.createTextButton(Common.UIString('Apply and reload'), _ => Components.reload(), 'reload-button'));
    this._update();
  }

  async _update() {
    const processManager = await Ndb.NodeProcessManager.instance();
    const {error, code, stderror, stdout} = await processManager.run(NdbProcessInfo.npmExecPath, ['ls', '--depth=0', '--json']);
    if (!stdout || stdout.length === 0)
      return;
    let dependencies;
    try {
      dependencies = Object.keys(JSON.parse(stdout).dependencies);
    } catch (e) {
      return;
    }
    const whitelisted = new Set((Common.moduleSetting('whitelistedModules').get() || '').split(','));
    this._items.replaceAll(dependencies.map(name => ({
      name,
      whitelisted: whitelisted.has(name)
    })));
    this._emptyPlaceholder.style.display = this._items.length > 0 ? 'none' : 'block';
    this._list.element.style.display = this._items.length === 0 ? 'none' : 'block';
    this._reloadButton.style.display = this._items.length === 0 ? 'none' : 'block';
  }

  /**
   * @override
   * @param {*} item
   * @param {boolean} editable
   * @return {!Element}
   */
  createElementForItem(item, editable) {
    const element = createElementWithClass('div', 'dependency-list-item');
    const title = element.createChild('div', 'dependency-title');
    title.textContent = item.name;
    title.title = item.name;
    element.createChild('div', 'dependency-separator');

    const select = /** @type {!HTMLSelectElement} */ (createElementWithClass('select', 'chrome-select'));
    [ls`Blackbox`, ls`Whitelist`].forEach(value => {
      const option = select.createChild('option');
      option.value = value;
      option.textContent = value;
    });
    select.selectedIndex = item.whitelisted ? 1 : 0;
    select.addEventListener('change', this._updateItem.bind(this, select, item));
    element.createChild('div', 'dependency-behavior').appendChild(select);
    return element;
  }

  isItemSelectable(item) {
    return false;
  }

  heightForItem(item) {
  }

  _updateItem(select, item) {
    item.whitelisted = select.selectedIndex === 1;
    Common.moduleSetting('whitelistedModules').set(Array.from(this._items)
        .filter(item => item.whitelisted)
        .map(item => item.name)
        .join(','));
  }
};

Ndb.NodeModulesBlackboxing._selectSymbol = Symbol('select');
