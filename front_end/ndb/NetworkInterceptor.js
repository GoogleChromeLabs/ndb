Ndb.NetworkInterceptor = class extends Ndb.ConnectionInterceptor {
  constructor() {
    super();
    this._buffer = [];
  }

  setTarget(target) {
    this._target = target;
    for (const message of this._buffer.splice(0))
      this._sendRawMessage(message);
    this._listen();
  }

  sendRawMessage(message) {
    const parsed = JSON.parse(message);
    if (parsed.method.startsWith('Network.')) {
      this._sendRawMessage(message);
      return true;
    }
    return false;
  }

  disconnect() {
    this._target = null;
  }

  _sendRawMessage(message) {
    if (this._target) {
      this._target.runtimeAgent().invoke_evaluate({
        expression: `process._sendNetworkCommand(${message})`
      });
    } else {
      this._buffer.push(message);
    }
  }

  async _listen() {
    while (this._target) {
      const {result: { value: messages }} = await this._target.runtimeAgent().invoke_evaluate({
        expression: `process._fetchNetworkMessages()`,
        awaitPromise: true,
        returnByValue: true
      });
      if (!messages || typeof messages !== 'array')
        continue;
      for (const message of messages)
        this.dispatchMessage(message);
    }
  }
};
