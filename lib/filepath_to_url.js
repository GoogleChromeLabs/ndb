const url = require('url');

if (url.pathToFileURL) {
  module.exports = {
    pathToFileURL: url.pathToFileURL,
    fileURLToPath: url.fileURLToPath
  };
} else {
  // Node 8 does not have nice url methods.
  // Polyfill should match DevTools frontend behavior,
  // otherwise breakpoints will not work.
  function pathToFileURL(fileSystemPath) {
    fileSystemPath = fileSystemPath.replace(/\\/g, '/');
    if (!fileSystemPath.startsWith('file://')) {
      if (fileSystemPath.startsWith('/'))
        fileSystemPath = 'file://' + fileSystemPath;
      else
        fileSystemPath = 'file:///' + fileSystemPath;
    }
    return fileSystemPath;
  }
  /**
   * @param {string} fileURL
   * @return {string}
   */
  function fileURLToPath(fileURL) {
    if (process.platform === 'win32')
      return fileURL.substr('file:///'.length).replace(/\//g, '\\');
    return fileURL.substr('file://'.length);
  }

  module.exports = {
    fileURLToPath,
    pathToFileURL,
  };
}
