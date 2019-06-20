# ndb

<!-- [START badges] -->
[![Build Status](https://img.shields.io/travis/com/GoogleChromeLabs/ndb/master.svg)](https://travis-ci.com/GoogleChromeLabs/ndb)
[![NPM ndb package](https://img.shields.io/npm/v/ndb.svg)](https://npmjs.org/package/ndb)
<!-- [END badges] -->

<img src="https://raw.githubusercontent.com/ChromeDevTools/devtools-logo/master/192.png" height="200" align="right">

> ndb is an improved debugging experience for Node.js, enabled by Chrome DevTools

## Installation

Compatibility: ndb requires Node >=8.0.0. It works best with Node >=10.

Installation: ndb depends on [Puppeteer](https://github.com/GoogleChrome/puppeteer) which downloads a recent version of Chromium (~170MB Mac, ~280MB Linux, ~280MB Win).

```bash
# global install with npm:
npm install -g ndb


# alternatively, with yarn:
yarn global add ndb
```

Global installation may fail with different permission errors, you can find help in this [thread](https://github.com/GoogleChromeLabs/ndb/issues/20).

Windows users: Installation may fail on Windows during compilation the native dependencies. The following command may help: `npm install -g windows-build-tools`

### Local install

If you want ndb available from an npm script (eg. `npm run debug` runs `ndb index.js`), you can install it as a development dependency:

```bash
# local install with npm:
npm install --save-dev ndb


# alternatively, with yarn:
yarn add ndb --dev
```

You can then [set up an npm script](https://docs.npmjs.com/misc/scripts#examples). In this case, ndb will not be available in your system path.


## Getting Started

You can start debugging your Node.js application using one of the following ways:

- Use `ndb` instead of the `node` command

```bash
ndb server.js

# Alternatively, you can prepend `ndb`
ndb node server.js
```

- Prepend `ndb` in front of any other binary

```bash
# If you use some other binary, just prepend `ndb`
## npm run unit
ndb npm run unit

# Debug any globally installed package
## mocha
ndb mocha

# To use a local binary, use `npx` and prepend before it
ndb npx mocha
```

- Launch `ndb` as a standalone application 
   - Then, debug any npm script from your `package.json`, e.g. unit tests

```bash
# cd to your project folder (with a package.json)
ndb .
# In Sources panel > "NPM Scripts" sidebar, click the selected "Run" button 
```

- Use `Ctrl`/`Cmd` + `R` to restart last run
- Run any node command from within ndb's integrated terminal and ndb will connect automatically
- Run any open script source by using 'Run this script' context menu item, ndb will connect automatically as well

- Use `--prof` flag to profile your app, `Ctrl`/`Cmd` + `R` restarts profiling
```bash
ndb --prof npm run unit
```

## What can I do?

`ndb` has some powerful features exclusively for Node.js:
1. Child processes are detected and attached to.
1. You can place breakpoints before the modules are required.
1. You can edit your files within the UI. On Ctrl-S/Cmd-S, DevTools will [save the changes to disk](https://developers.google.com/web/tools/chrome-devtools/workspaces/).
1. By default, ndb [blackboxes](https://developers.google.com/web/tools/chrome-devtools/javascript/reference#blackbox) all scripts outside current working directory to improve focus. This includes node internal libraries (like `_stream_wrap.js`, `async_hooks.js`, `fs.js`) This behaviour may be changed by "Blackbox anything outside working dir" setting. 

In addition, you can use all the DevTools functionality that you've used in [typical Node debugging](https://medium.com/@paul_irish/debugging-node-js-nightlies-with-chrome-devtools-7c4a1b95ae27):
- breakpoint debugging, async stacks (AKA long stack traces), [async stepping](https://developers.google.com/web/updates/2018/01/devtools#async), etc...
- console (top-level await, object inspection, advanced filtering)
- [eager evaluation](https://developers.google.com/web/updates/2018/05/devtools#eagerevaluation) in console (requires Node >= 10)
- JS sampling profiler
- memory profiler

### Screenshot
![image](https://user-images.githubusercontent.com/39191/43023843-14a085a6-8c21-11e8-85b7-b9fd3405938a.png)


## Contributing

Check out [contributing guide](https://github.com/GoogleChromeLabs/ndb/blob/master/CONTRIBUTING.md) to get an overview of ndb development.

#### Thanks to the 'OG' `ndb`

In early 2011, [@smtlaissezfaire](https://github.com/smtlaissezfaire) released the first serious debugger for Node.js, under the `ndb` package name. It's still preserved at [github.com/smtlaissezfaire/ndb](https://github.com/smtlaissezfaire/ndb#readme). We thank Scott for generously donating the package name.
