Ndb.NetworkInterceptor = class extends Ndb.ConnectionInterceptor {
  constructor() {
    super();
    this._buffer = [];
    this._cacheRequests = [];
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

  setOnMessage(onMessage) {
    this._onMessage = onMessage;
  }

  dispatchMessage(message) {
    if (this._onMessage) this._onMessage(message);
  }

  disconnect() {
    this._target = null;
  }

  _sendRawMessage(rawMessage) {}

  async _listen() {
    InspectorFrontendHost.sendMessageToBackend = rawMessage => {
      const message = JSON.parse(rawMessage);

      const request = this._cacheRequests.filter(res => {
        if (
          res.type === 'Network.getResponseBody' &&
          res.payload.requestId === message.params.requestId
        )
          return res;
      })[0];

      if (request) {
        InspectorFrontendHost.events.dispatchEventToListeners(
            InspectorFrontendHostAPI.Events.DispatchMessage,
            {
              id: message.id,
              result: {
                base64Encoded: true,
                body: request.payload.data
              }
            }
        );
      }
    };

    while (this._target) {
      const rawResponse = await this._target
          .runtimeAgent()
          .invoke_evaluate({
            expression: `process._fetchNetworkMessages()`,
            awaitPromise: true,
            returnByValue: true
          });

      if (!rawResponse || !rawResponse.result) return;

      const {
        result: { value: messages }
      } = rawResponse;

      if (!messages) return;

      // messages is array-like
      const messagesArr = Array.from(JSON.parse(messages));

      for (const message of messagesArr) {
        const { type, payload } = message;
        this._cacheRequests.push(message);

        // this is on the way back, this way doesn't work
        if (type !== 'Network.getResponseBody') {
          // but this does
          SDK._mainConnection._onMessage(JSON.stringify({
            method: type,
            params: payload
          }));
        }
      }
    }
  }
};
