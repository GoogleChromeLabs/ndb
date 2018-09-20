/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

const assert = require('assert');
const path = require('path');
const { URL } = require('url');

const { platform } = process;
const isWindows = platform === 'win32'

function pathToFileURL(filepath) {
  let resolved = path.resolve(filepath);
  // path.resolve strips trailing slashes so we must add them back
  const filePathLast = filepath.charCodeAt(filepath.length - 1);
  if ((filePathLast === '/' ||
       isWindows && filePathLast === '\\') &&
      resolved[resolved.length - 1] !== path.sep)
    resolved += '/';
  const outURL = new URL('file://');
  if (resolved.includes('%'))
    resolved = resolved.replace(percentRegEx, '%25');
  // in posix, "/" is a valid character in paths
  if (!isWindows && resolved.includes('\\'))
    resolved = resolved.replace(backslashRegEx, '%5C');
  outURL.pathname = resolved;
  return outURL;
}

module.exports.addTests = function({testRunner}) {
  const {it, fit, xit} = testRunner;
  const fileSystemService = require('../services/file_system_service.js');
  it('getEntry', async function() {
    const fsURL = pathToFileURL(__dirname + path.sep + 'fs').toString();
    // get existing folder as folder
    assert.deepEqual(await fileSystemService.getEntry({
      url: fsURL,
      isFile: false,
      create: false,
      exclusive: false
    }), {});
    // get existing folder as file
    assert.deepEqual(await fileSystemService.getEntry({
      url: fsURL,
      isFile: true,
      create: false,
      exclusive: false
    }), fileSystemService._internalError());
    // create existing folder with exclusive true
    assert.deepEqual(await fileSystemService.getEntry({
      url: fsURL,
      isFile: false,
      create: true,
      exclusive: true
    }), fileSystemService._pathExistsError());

    const tmpFolderURL = pathToFileURL(__dirname + path.sep + 'fs' + path.sep + 'tmp');
    const tmpFileURL = pathToFileURL(__dirname + path.sep + 'fs' + path.sep + 'tmp' + path.sep + 'tmp');
    const tmpFileURL2 = pathToFileURL(__dirname + path.sep + 'fs' + path.sep + 'tmp' + path.sep + 'tmp2');
    const tmpFileURL3 = pathToFileURL(__dirname + path.sep + 'fs' + path.sep + 'tmp' + path.sep + 'tmp2.js');
    await fileSystemService.remove({ isFile: true, url: tmpFileURL });
    await fileSystemService.remove({ isFile: true, url: tmpFileURL2 });
    await fileSystemService.remove({ isFile: true, url: tmpFileURL3 });
    await fileSystemService.remove({ isFile: false, url: tmpFolderURL });

    // create folder with exclusive true
    assert.deepEqual(await fileSystemService.getEntry({
      url: tmpFolderURL,
      isFile: false,
      create: true,
      exclusive: true
    }), {});

    // create file
    assert.deepEqual(await fileSystemService.getEntry({
      url: tmpFileURL,
      isFile: true,
      create: true,
      exclusive: true
    }), {});

    assert.deepEqual(await fileSystemService.write({
      url: tmpFileURL,
      content: Buffer.from('Hello World').toString('base64')
    }), {});

    assert.deepEqual(await fileSystemService.readEntries({
      url: tmpFolderURL
    }), {
      entries: [{
        name: tmpFileURL.toString(),
        isDirectory: false,
        size: 6
      }]
    });

    assert.equal((await fileSystemService.metadata({
      url: tmpFileURL
    })).size, 6);

    assert.deepEqual(await fileSystemService.truncate({
      url: tmpFileURL,
      size: 3
    }), {});

    assert.equal((await fileSystemService.metadata({
      url: tmpFileURL
    })).size, 3);

    assert.deepEqual(await fileSystemService.readEntries({
      url: tmpFolderURL
    }), {
      entries: [{
        name: tmpFileURL.toString(),
        isDirectory: false,
        size: 3
      }]
    });

    // move file
    assert.deepEqual(await fileSystemService.moveTo({
      fromURL: tmpFileURL,
      toURL: tmpFileURL2
    }), {});

    assert.deepEqual(await fileSystemService.readEntries({
      url: tmpFolderURL
    }), {
      entries: [{
        name: tmpFileURL2.toString(),
        isDirectory: false,
        size: 3
      }]
    });

    // read file
    assert.deepEqual(await fileSystemService.file({
      url: tmpFileURL2,
    }), { data: '8gV2', mimeType: 'application/octet-stream' });

    assert.deepEqual(await fileSystemService.moveTo({
      fromURL: tmpFileURL2,
      toURL: tmpFileURL3
    }), {});

    assert.deepEqual(await fileSystemService.file({
      url: tmpFileURL3,
    }), { data: '8gV2', mimeType: 'application/javascript' });

    // remove file
    assert.deepEqual(await fileSystemService.remove({
      isFile: true,
      url: tmpFileURL3
    }), {});

    assert.deepEqual(await fileSystemService.readEntries({
      url: tmpFolderURL
    }), {
      entries: []
    });

    // remove folder
    assert.deepEqual(await fileSystemService.remove({
      isFile: false,
      url: tmpFolderURL
    }), {});
  });
}
