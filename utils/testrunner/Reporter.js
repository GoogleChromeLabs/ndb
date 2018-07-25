/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const RED_COLOR = '\x1b[31m';
const GREEN_COLOR = '\x1b[32m';
const YELLOW_COLOR = '\x1b[33m';
const RESET_COLOR = '\x1b[0m';

class Reporter {
  constructor(runner) {
    this._runner = runner;
    runner.on('started', this._onStarted.bind(this));
    runner.on('terminated', this._onTerminated.bind(this));
    runner.on('finished', this._onFinished.bind(this));
    runner.on('teststarted', this._onTestStarted.bind(this));
    runner.on('testfinished', this._onTestFinished.bind(this));
  }

  _onStarted() {
    this._timestamp = Date.now();
    console.log(`Running ${YELLOW_COLOR}${this._runner.parallel()}${RESET_COLOR} worker(s):\n`);
  }

  _onTerminated(message, error) {
    this._printTestResults();
    console.log(`${RED_COLOR}## TERMINATED ##${RESET_COLOR}`);
    console.log('Message:');
    console.log(`  ${RED_COLOR}${message}${RESET_COLOR}`);
    if (error && error.stack) {
      console.log('Stack:');
      console.log(error.stack.split('\n').map(line => '  ' + line).join('\n'));
    }
    process.exit(2);
  }

  _onFinished() {
    this._printTestResults();
    const failedTests = this._runner.failedTests();
    process.exit(failedTests.length > 0 ? 1 : 0);
  }

  _printTestResults() {
    // 2 newlines after completing all tests.
    console.log('\n');

    const failedTests = this._runner.failedTests();
    if (failedTests.length > 0) {
      console.log('\nFailures:');
      for (let i = 0; i < failedTests.length; ++i) {
        const test = failedTests[i];
        console.log(`${i + 1}) ${test.fullName} (${formatLocation(test)})`);
        if (test.result === 'timedout') {
          console.log('  Message:');
          console.log(`    ${YELLOW_COLOR}Timeout Exceeded ${this._runner.timeout()}ms${RESET_COLOR}`);
        } else {
          console.log('  Message:');
          console.log(`    ${RED_COLOR}${test.error.message || test.error}${RESET_COLOR}`);
          console.log('  Stack:');
          if (test.error.stack) {
            const stack = test.error.stack.split('\n').map(line => '    ' + line);
            let i = 0;
            while (i < stack.length && !stack[i].includes(__dirname))
              ++i;
            while (i < stack.length && stack[i].includes(__dirname))
              ++i;
            if (i < stack.length) {
              const indent = stack[i].match(/^\s*/)[0];
              stack[i] = stack[i].substring(0, indent.length - 3) + YELLOW_COLOR + '⇨ ' + RESET_COLOR +  stack[i].substring(indent.length - 1);
            }
            console.log(stack.join('\n'));
          }
        }
        if (test.output) {
          console.log('  Output:');
          console.log(test.output.split('\n').map(line => '    ' + line).join('\n'));
        }
        console.log('');
      }
    }

    const tests = this._runner.tests();
    const skippedTests = tests.filter(test => test.result === 'skipped');
    if (skippedTests.length > 0) {
      console.log('\nSkipped:');
      for (let i = 0; i < skippedTests.length; ++i) {
        const test = skippedTests[i];
        console.log(`${i + 1}) ${test.fullName}`);
        console.log(`  ${YELLOW_COLOR}Temporary disabled with xit${RESET_COLOR} ${formatLocation(test)}\n`);
      }
    }

    const executedTests = tests.filter(test => test.result);
    console.log(`\nRan ${executedTests.length} of ${tests.length} test(s)`);
    const milliseconds = Date.now() - this._timestamp;
    const seconds = milliseconds / 1000;
    console.log(`Finished in ${YELLOW_COLOR}${seconds}${RESET_COLOR} seconds`);

    function formatLocation(test) {
      const location = test.location;
      if (!location)
        return '';
      return `${location.fileName}:${location.lineNumber}:${location.columnNumber}`;
    }
  }

  _onTestStarted() {
  }

  _onTestFinished(test) {
    if (test.result === 'ok')
      process.stdout.write(`${GREEN_COLOR}.${RESET_COLOR}`);
    else if (test.result === 'skipped')
      process.stdout.write(`${YELLOW_COLOR}*${RESET_COLOR}`);
    else if (test.result === 'failed')
      process.stdout.write(`${RED_COLOR}F${RESET_COLOR}`);
    else if (test.result === 'timedout')
      process.stdout.write(`${RED_COLOR}T${RESET_COLOR}`);
  }
}

module.exports = Reporter;
