const zlib = require('zlib');
const http = require('http');
const https = require('https');

const initTime = process.hrtime();

// DT requires us to use relative time in a strange format (xxx.xxx)
const getTime = () => {
  const diff = process.hrtime(initTime);

  return diff[0] + diff[1] / 1e9;
};

const formatRequestHeaders = req => {
  if (!req.headers) return {};
  return Object.keys(req.headers).reduce((acc, k) => {
    if (typeof req.headers[k] === 'string') acc[k] = req.headers[k];
    return acc;
  }, {});
};

const formatResponseHeaders = res => {
  if (!res.headers) return {};
  return Object.keys(res.headers).reduce((acc, k) => {
    if (typeof res.headers[k] === 'string') acc[k] = res.headers[k];
    return acc;
  }, {});
};

const getMineType = mimeType => {
  // nasty hack for ASF
  if (mimeType === 'OPENJSON')
    return 'application/json;charset=UTF-8';


  return mimeType;
};

const cacheRequests = {};
let id = 1;
const getId = () => id++;

const messages = [];
let messageAdded = null;

function reportMessage(message) {
  messages.push(message);
  if (messageAdded) {
    setTimeout(messageAdded, 0);
    messageAdded = null;
  }
}

process._fetchNetworkMessages = async function() {
  if (!messages.length)
    await new Promise(resolve => messageAdded = resolve);
  return JSON.stringify(messages.splice(0));
};

process._sendNetworkCommand = async function(rawMessage) {
  return new Promise(resolve => {
    const message = JSON.parse(rawMessage);
    console.log({ cacheRequests });
    console.log({ cacheRequests: cacheRequests[message.params.requestId] });
    if (!cacheRequests[message.params.requestId]) {
      resolve(JSON.stringify({}));
    } else {
      if (message.method === 'Network.getResponseBody') {
        console.log({ message });
        const { base64Encoded, data } = cacheRequests[message.params.requestId];

        console.log({ cacheRequests });
        console.log({ data });
        resolve(JSON.stringify([message.id, { base64Encoded, body: data }]));
      }
    }
  });
};

const callbackWrapper = (callback, req) => res => {
  const requestId = getId();
  res.req.__requestId = requestId;

  reportMessage({
    payload: {
      requestId: requestId,
      loaderId: requestId,
      documentURL: req.href,
      request: {
        url: req.href,
        method: req.method,
        headers: formatRequestHeaders(req),
        mixedContentType: 'none',
        initialPriority: 'VeryHigh',
        referrerPolicy: 'no-referrer-when-downgrade',
        postData: req.body
      },
      timestamp: getTime(),
      wallTime: Date.now(),
      initiator: {
        type: 'other'
      },
      type: 'Document'
    },
    type: 'Network.requestWillBeSent'
  });

  const encoding = res.headers['content-encoding'];
  let rawData = [];

  const onEnd = function() {
    rawData = Buffer.concat(rawData);
    rawData = rawData.toString('base64');

    cacheRequests[res.req.__requestId] = {
      ...res,
      __rawData: rawData,
      base64Encoded: true
    };

    const payload = {
      id: res.req.__requestId,
      requestId: res.req.__requestId,
      loaderId: res.req.__requestId,
      base64Encoded: true,
      data: cacheRequests[res.req.__requestId].__rawData,
      timestamp: getTime(),
      type: 'XHR',
      encodedDataLength: 100,
      response: {
        url: req.href,
        status: res.statusCode,
        statusText: res.statusText,
        // set-cookie prop in the header has value as an array
        // for example: ["__cfduid=dbfe006ef71658bf4dba321343c227f9a15449556…20:29 GMT; path=/; domain=.typicode.com; HttpOnly"]
        headers: formatResponseHeaders(res),
        mimeType: getMineType(
            res.headers['content-encoding'] ||
                        res.headers['content-type']
        ),
        requestHeaders: formatRequestHeaders(req)
      }
    };

    // Send the response back.
    reportMessage({ payload: payload, type: 'Network.responseReceived' });
    reportMessage({ payload: payload, type: 'Network.loadingFinished' });
    reportMessage({ payload: payload, type: 'Network.getResponseBody' });
  };

  if (encoding === 'gzip' || encoding === 'x-gzip') {
    const gunzip = zlib.createGunzip();
    res.pipe(gunzip);

    gunzip.on('data', function(data) {
      rawData.push(data);
    });
    gunzip.on('end', onEnd);
  } else {
    res.on('data', chunk => {
      rawData.push(chunk);
    });
    res.on('end', onEnd);
  }

  callback && callback(res);
};

const originHTTPRequest = http.request;
http.request = function wrapMethodRequest(req, callback) {
  const request = originHTTPRequest.call(
      this,
      req,
      callbackWrapper(callback, req)
  );
  return request;
};

const originHTTPSRequest = https.request;
https.request = function wrapMethodRequest(req, callback) {
  const request = originHTTPSRequest.call(
      this,
      req,
      callbackWrapper(callback, req)
  );
  const originWrite = request.write.bind(request);
  request.write = data => {
    req.body = data.toString();
    originWrite(data);
  };
  return request;
};
