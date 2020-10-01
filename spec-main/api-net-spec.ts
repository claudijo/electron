import { expect } from 'chai';
import { net, session, ClientRequest, BrowserWindow } from 'electron/main';
import * as http from 'http';
import * as url from 'url';
import { AddressInfo, Socket } from 'net';
import { emittedOnce } from './events-helpers';
import { defer, delay } from './spec-helpers';

const kOneKiloByte = 1024;
const kOneMegaByte = kOneKiloByte * kOneKiloByte;

function randomBuffer (size: number, start: number = 0, end: number = 255) {
  const range = 1 + end - start;
  const buffer = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; ++i) {
    buffer[i] = start + Math.floor(Math.random() * range);
  }
  return buffer;
}

function randomString (length: number) {
  const buffer = randomBuffer(length, '0'.charCodeAt(0), 'z'.charCodeAt(0));
  return buffer.toString();
}

async function getResponse (urlRequest: Electron.ClientRequest) {
  return new Promise<Electron.IncomingMessage>((resolve, reject) => {
    urlRequest.on('error', reject);
    urlRequest.on('abort', reject);
    urlRequest.on('response', (response) => resolve(response));
    urlRequest.end();
  });
}

async function collectStreamBody (response: Electron.IncomingMessage | http.IncomingMessage) {
  return (await collectStreamBodyBuffer(response)).toString();
}

function collectStreamBodyBuffer (response: Electron.IncomingMessage | http.IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    response.on('error', reject);
    (response as NodeJS.EventEmitter).on('aborted', reject);
    const data: Buffer[] = [];
    response.on('data', (chunk) => data.push(chunk));
    response.on('end', (chunk?: Buffer) => {
      if (chunk) data.push(chunk);
      resolve(Buffer.concat(data));
    });
  });
}

function respondNTimes (fn: http.RequestListener, n: number): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      fn(request, response);
      // don't close if a redirect was returned
      if ((response.statusCode < 300 || response.statusCode >= 399) && n <= 0) {
        n--;
        server.close();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
    const sockets: Socket[] = [];
    server.on('connection', s => sockets.push(s));
    defer(() => {
      server.close();
      sockets.forEach(s => s.destroy());
    });
  });
}

function respondOnce (fn: http.RequestListener) {
  return respondNTimes(fn, 1);
}

let routeFailure = false;

respondNTimes.toRoutes = (routes: Record<string, http.RequestListener>, n: number) => {
  return respondNTimes((request, response) => {
    if (Object.prototype.hasOwnProperty.call(routes, request.url || '')) {
      (async () => {
        await Promise.resolve(routes[request.url || ''](request, response));
      })().catch((err) => {
        routeFailure = true;
        console.error('Route handler failed, this is probably why your test failed', err);
        response.statusCode = 500;
        response.end();
      });
    } else {
      response.statusCode = 500;
      response.end();
      expect.fail(`Unexpected URL: ${request.url}`);
    }
  }, n);
};
respondOnce.toRoutes = (routes: Record<string, http.RequestListener>) => respondNTimes.toRoutes(routes, 1);

respondNTimes.toURL = (url: string, fn: http.RequestListener, n: number) => {
  return respondNTimes.toRoutes({ [url]: fn }, n);
};
respondOnce.toURL = (url: string, fn: http.RequestListener) => respondNTimes.toURL(url, fn, 1);

respondNTimes.toSingleURL = (fn: http.RequestListener, n: number) => {
  const requestUrl = '/requestUrl';
  return respondNTimes.toURL(requestUrl, fn, n).then(url => `${url}${requestUrl}`);
};
respondOnce.toSingleURL = (fn: http.RequestListener) => respondNTimes.toSingleURL(fn, 1);

describe('net module', () => {
  beforeEach(() => {
    routeFailure = false;
  });
  afterEach(async function () {
    await session.defaultSession.clearCache();
    if (routeFailure && this.test) {
      if (!this.test.isFailed()) {
        throw new Error('Failing this test due an unhandled error in the respondOnce route handler, check the logs above for the actual error');
      }
    }
  });

  describe('HTTP basics', () => {
    it('should be able to issue a basic GET request', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        expect(request.method).to.equal('GET');
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      await collectStreamBody(response);
    });

    it('should be able to issue a basic POST request', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        expect(request.method).to.equal('POST');
        response.end();
      });
      const urlRequest = net.request({
        method: 'POST',
        url: serverUrl
      });
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      await collectStreamBody(response);
    });

    it('should fetch correct data in a GET request', async () => {
      const expectedBodyData = 'Hello World!';
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        expect(request.method).to.equal('GET');
        response.end(expectedBodyData);
      });
      const urlRequest = net.request(serverUrl);
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      const body = await collectStreamBody(response);
      expect(body).to.equal(expectedBodyData);
    });

    it('should post the correct data in a POST request', async () => {
      const bodyData = 'Hello World!';
      const serverUrl = await respondOnce.toSingleURL(async (request, response) => {
        const postedBodyData = await collectStreamBody(request);
        expect(postedBodyData).to.equal(bodyData);
        response.end();
      });
      const urlRequest = net.request({
        method: 'POST',
        url: serverUrl
      });
      urlRequest.write(bodyData);
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
    });

    it('should support chunked encoding', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.chunkedEncoding = true;
        expect(request.method).to.equal('POST');
        expect(request.headers['transfer-encoding']).to.equal('chunked');
        expect(request.headers['content-length']).to.equal(undefined);
        request.on('data', (chunk: Buffer) => {
          response.write(chunk);
        });
        request.on('end', (chunk: Buffer) => {
          response.end(chunk);
        });
      });
      const urlRequest = net.request({
        method: 'POST',
        url: serverUrl
      });

      let chunkIndex = 0;
      const chunkCount = 100;
      let sent = Buffer.alloc(0);

      urlRequest.chunkedEncoding = true;
      while (chunkIndex < chunkCount) {
        chunkIndex += 1;
        const chunk = randomBuffer(kOneKiloByte);
        sent = Buffer.concat([sent, chunk]);
        urlRequest.write(chunk);
      }

      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      const received = await collectStreamBodyBuffer(response);
      expect(sent.equals(received)).to.be.true();
      expect(chunkIndex).to.be.equal(chunkCount);
    });

    it('should emit the login event when 401', async () => {
      const [user, pass] = ['user', 'pass'];
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        if (!request.headers.authorization) {
          return response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Foo"' }).end();
        }
        response.writeHead(200).end('ok');
      });
      let loginAuthInfo: Electron.AuthInfo;
      const request = net.request({ method: 'GET', url: serverUrl });
      request.on('login', (authInfo, cb) => {
        loginAuthInfo = authInfo;
        cb(user, pass);
      });
      const response = await getResponse(request);
      expect(response.statusCode).to.equal(200);
      expect(loginAuthInfo!.realm).to.equal('Foo');
      expect(loginAuthInfo!.scheme).to.equal('basic');
    });

    it('should response when cancelling authentication', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        if (!request.headers.authorization) {
          response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Foo"' });
          response.end('unauthenticated');
        } else {
          response.writeHead(200).end('ok');
        }
      });
      const request = net.request({ method: 'GET', url: serverUrl });
      request.on('login', (authInfo, cb) => {
        cb();
      });
      const response = await getResponse(request);
      const body = await collectStreamBody(response);
      expect(body).to.equal('unauthenticated');
    });

    it('should share credentials with WebContents', async () => {
      const [user, pass] = ['user', 'pass'];
      const serverUrl = await respondNTimes.toSingleURL((request, response) => {
        if (!request.headers.authorization) {
          return response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Foo"' }).end();
        }
        return response.writeHead(200).end('ok');
      }, 2);
      const bw = new BrowserWindow({ show: false });
      bw.webContents.on('login', (event, details, authInfo, cb) => {
        event.preventDefault();
        cb(user, pass);
      });
      await bw.loadURL(serverUrl);
      bw.close();
      const request = net.request({ method: 'GET', url: serverUrl });
      let logInCount = 0;
      request.on('login', () => {
        logInCount++;
      });
      const response = await getResponse(request);
      await collectStreamBody(response);
      expect(logInCount).to.equal(0, 'should not receive a login event, credentials should be cached');
    });

    it('should share proxy credentials with WebContents', async () => {
      const [user, pass] = ['user', 'pass'];
      const proxyUrl = await respondNTimes((request, response) => {
        if (!request.headers['proxy-authorization']) {
          return response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Foo"' }).end();
        }
        return response.writeHead(200).end('ok');
      }, 2);
      const customSession = session.fromPartition(`net-proxy-test-${Math.random()}`);
      await customSession.setProxy({ proxyRules: proxyUrl.replace('http://', ''), proxyBypassRules: '<-loopback>' });
      const bw = new BrowserWindow({ show: false, webPreferences: { session: customSession } });
      bw.webContents.on('login', (event, details, authInfo, cb) => {
        event.preventDefault();
        cb(user, pass);
      });
      await bw.loadURL('http://127.0.0.1:9999');
      bw.close();
      const request = net.request({ method: 'GET', url: 'http://127.0.0.1:9999', session: customSession });
      let logInCount = 0;
      request.on('login', () => {
        logInCount++;
      });
      const response = await getResponse(request);
      const body = await collectStreamBody(response);
      expect(response.statusCode).to.equal(200);
      expect(body).to.equal('ok');
      expect(logInCount).to.equal(0, 'should not receive a login event, credentials should be cached');
    });

    it('should upload body when 401', async () => {
      const [user, pass] = ['user', 'pass'];
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        if (!request.headers.authorization) {
          return response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Foo"' }).end();
        }
        response.writeHead(200);
        request.on('data', (chunk) => response.write(chunk));
        request.on('end', () => response.end());
      });
      const requestData = randomString(kOneKiloByte);
      const request = net.request({ method: 'GET', url: serverUrl });
      request.on('login', (authInfo, cb) => {
        cb(user, pass);
      });
      request.write(requestData);
      const response = await getResponse(request);
      const responseData = await collectStreamBody(response);
      expect(responseData).to.equal(requestData);
    });
  });

  describe('ClientRequest API', () => {
    it('request/response objects should emit expected events', async () => {
      const bodyData = randomString(kOneKiloByte);
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.end(bodyData);
      });

      const urlRequest = net.request(serverUrl);
      // request close event
      const closePromise = emittedOnce(urlRequest, 'close');
      // request finish event
      const finishPromise = emittedOnce(urlRequest, 'close');
      // request "response" event
      const response = await getResponse(urlRequest);
      response.on('error', (error: Error) => {
        expect(error).to.be.an('Error');
      });
      const statusCode = response.statusCode;
      expect(statusCode).to.equal(200);
      // response data event
      // respond end event
      const body = await collectStreamBody(response);
      expect(body).to.equal(bodyData);
      urlRequest.on('error', (error) => {
        expect(error).to.be.an('Error');
      });
      await Promise.all([closePromise, finishPromise]);
    });

    it('should be able to set a custom HTTP request header before first write', async () => {
      const customHeaderName = 'Some-Custom-Header-Name';
      const customHeaderValue = 'Some-Customer-Header-Value';
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        expect(request.headers[customHeaderName.toLowerCase()]).to.equal(customHeaderValue);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.setHeader(customHeaderName, customHeaderValue);
      expect(urlRequest.getHeader(customHeaderName)).to.equal(customHeaderValue);
      expect(urlRequest.getHeader(customHeaderName.toLowerCase())).to.equal(customHeaderValue);
      urlRequest.write('');
      expect(urlRequest.getHeader(customHeaderName)).to.equal(customHeaderValue);
      expect(urlRequest.getHeader(customHeaderName.toLowerCase())).to.equal(customHeaderValue);
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      await collectStreamBody(response);
    });

    it('should be able to set a non-string object as a header value', async () => {
      const customHeaderName = 'Some-Integer-Value';
      const customHeaderValue = 900;
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        expect(request.headers[customHeaderName.toLowerCase()]).to.equal(customHeaderValue.toString());
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.end();
      });

      const urlRequest = net.request(serverUrl);
      urlRequest.setHeader(customHeaderName, customHeaderValue as any);
      expect(urlRequest.getHeader(customHeaderName)).to.equal(customHeaderValue);
      expect(urlRequest.getHeader(customHeaderName.toLowerCase())).to.equal(customHeaderValue);
      urlRequest.write('');
      expect(urlRequest.getHeader(customHeaderName)).to.equal(customHeaderValue);
      expect(urlRequest.getHeader(customHeaderName.toLowerCase())).to.equal(customHeaderValue);
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      await collectStreamBody(response);
    });

    it('should not be able to set a custom HTTP request header after first write', async () => {
      const customHeaderName = 'Some-Custom-Header-Name';
      const customHeaderValue = 'Some-Customer-Header-Value';
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        expect(request.headers[customHeaderName.toLowerCase()]).to.equal(undefined);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.write('');
      expect(() => {
        urlRequest.setHeader(customHeaderName, customHeaderValue);
      }).to.throw();
      expect(urlRequest.getHeader(customHeaderName)).to.equal(undefined);
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      await collectStreamBody(response);
    });

    it('should be able to remove a custom HTTP request header before first write', async () => {
      const customHeaderName = 'Some-Custom-Header-Name';
      const customHeaderValue = 'Some-Customer-Header-Value';
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        expect(request.headers[customHeaderName.toLowerCase()]).to.equal(undefined);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.setHeader(customHeaderName, customHeaderValue);
      expect(urlRequest.getHeader(customHeaderName)).to.equal(customHeaderValue);
      urlRequest.removeHeader(customHeaderName);
      expect(urlRequest.getHeader(customHeaderName)).to.equal(undefined);
      urlRequest.write('');
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      await collectStreamBody(response);
    });

    it('should not be able to remove a custom HTTP request header after first write', async () => {
      const customHeaderName = 'Some-Custom-Header-Name';
      const customHeaderValue = 'Some-Customer-Header-Value';
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        expect(request.headers[customHeaderName.toLowerCase()]).to.equal(customHeaderValue);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.setHeader(customHeaderName, customHeaderValue);
      expect(urlRequest.getHeader(customHeaderName)).to.equal(customHeaderValue);
      urlRequest.write('');
      expect(() => {
        urlRequest.removeHeader(customHeaderName);
      }).to.throw();
      expect(urlRequest.getHeader(customHeaderName)).to.equal(customHeaderValue);
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      await collectStreamBody(response);
    });

    it('should be able to set cookie header line', async () => {
      const cookieHeaderName = 'Cookie';
      const cookieHeaderValue = 'test=12345';
      const customSession = session.fromPartition('test-cookie-header');
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        expect(request.headers[cookieHeaderName.toLowerCase()]).to.equal(cookieHeaderValue);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.end();
      });
      await customSession.cookies.set({
        url: `${serverUrl}`,
        name: 'test',
        value: '11111',
        expirationDate: 0
      });
      const urlRequest = net.request({
        method: 'GET',
        url: serverUrl,
        session: customSession
      });
      urlRequest.setHeader(cookieHeaderName, cookieHeaderValue);
      expect(urlRequest.getHeader(cookieHeaderName)).to.equal(cookieHeaderValue);
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      await collectStreamBody(response);
    });

    it('should be able to receive cookies', async () => {
      const cookie = ['cookie1', 'cookie2'];
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.setHeader('set-cookie', cookie);
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      const response = await getResponse(urlRequest);
      expect(response.headers['set-cookie']).to.have.same.members(cookie);
    });

    it('should not use the sessions cookie store by default', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.setHeader('x-cookie', `${request.headers.cookie!}`);
        response.end();
      });
      const sess = session.fromPartition('cookie-tests-1');
      const cookieVal = `${Date.now()}`;
      await sess.cookies.set({
        url: serverUrl,
        name: 'wild_cookie',
        value: cookieVal
      });
      const urlRequest = net.request({
        url: serverUrl,
        session: sess
      });
      const response = await getResponse(urlRequest);
      expect(response.headers['x-cookie']).to.equal('undefined');
    });

    it('should be able to use the sessions cookie store', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.setHeader('x-cookie', request.headers.cookie!);
        response.end();
      });
      const sess = session.fromPartition('cookie-tests-2');
      const cookieVal = `${Date.now()}`;
      await sess.cookies.set({
        url: serverUrl,
        name: 'wild_cookie',
        value: cookieVal
      });
      const urlRequest = net.request({
        url: serverUrl,
        session: sess,
        useSessionCookies: true
      });
      const response = await getResponse(urlRequest);
      expect(response.headers['x-cookie']).to.equal(`wild_cookie=${cookieVal}`);
    });

    it('should be able to use the sessions cookie store with set-cookie', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.setHeader('set-cookie', 'foo=bar');
        response.end();
      });
      const sess = session.fromPartition('cookie-tests-3');
      let cookies = await sess.cookies.get({});
      expect(cookies).to.have.lengthOf(0);
      const urlRequest = net.request({
        url: serverUrl,
        session: sess,
        useSessionCookies: true
      });
      await collectStreamBody(await getResponse(urlRequest));
      cookies = await sess.cookies.get({});
      expect(cookies).to.have.lengthOf(1);
      expect(cookies[0]).to.deep.equal({
        name: 'foo',
        value: 'bar',
        domain: '127.0.0.1',
        hostOnly: true,
        path: '/',
        secure: false,
        httpOnly: false,
        session: true,
        sameSite: 'unspecified'
      });
    });

    ['Lax', 'Strict'].forEach((mode) => {
      it(`should be able to use the sessions cookie store with same-site ${mode} cookies`, async () => {
        const serverUrl = await respondNTimes.toSingleURL((request, response) => {
          response.statusCode = 200;
          response.statusMessage = 'OK';
          response.setHeader('set-cookie', `same=site; SameSite=${mode}`);
          response.setHeader('x-cookie', `${request.headers.cookie}`);
          response.end();
        }, 2);
        const sess = session.fromPartition(`cookie-tests-same-site-${mode}`);
        let cookies = await sess.cookies.get({});
        expect(cookies).to.have.lengthOf(0);
        const urlRequest = net.request({
          url: serverUrl,
          session: sess,
          useSessionCookies: true
        });
        const response = await getResponse(urlRequest);
        expect(response.headers['x-cookie']).to.equal('undefined');
        await collectStreamBody(response);
        cookies = await sess.cookies.get({});
        expect(cookies).to.have.lengthOf(1);
        expect(cookies[0]).to.deep.equal({
          name: 'same',
          value: 'site',
          domain: '127.0.0.1',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          session: true,
          sameSite: mode.toLowerCase()
        });
        const urlRequest2 = net.request({
          url: serverUrl,
          session: sess,
          useSessionCookies: true
        });
        const response2 = await getResponse(urlRequest2);
        expect(response2.headers['x-cookie']).to.equal('same=site');
      });
    });

    it('should be able to use the sessions cookie store safely across redirects', async () => {
      const serverUrl = await respondOnce.toSingleURL(async (request, response) => {
        response.statusCode = 302;
        response.statusMessage = 'Moved';
        const newUrl = await respondOnce.toSingleURL((req, res) => {
          res.statusCode = 200;
          res.statusMessage = 'OK';
          res.setHeader('x-cookie', req.headers.cookie!);
          res.end();
        });
        response.setHeader('x-cookie', request.headers.cookie!);
        response.setHeader('location', newUrl.replace('127.0.0.1', 'localhost'));
        response.end();
      });
      const sess = session.fromPartition('cookie-tests-4');
      const cookie127Val = `${Date.now()}-127`;
      const cookieLocalVal = `${Date.now()}-local`;
      const localhostUrl = serverUrl.replace('127.0.0.1', 'localhost');
      expect(localhostUrl).to.not.equal(serverUrl);
      await Promise.all([
        sess.cookies.set({
          url: serverUrl,
          name: 'wild_cookie',
          value: cookie127Val
        }), sess.cookies.set({
          url: localhostUrl,
          name: 'wild_cookie',
          value: cookieLocalVal
        })
      ]);
      const urlRequest = net.request({
        url: serverUrl,
        session: sess,
        useSessionCookies: true
      });
      urlRequest.on('redirect', (status, method, url, headers) => {
        // The initial redirect response should have received the 127 value here
        expect(headers['x-cookie'][0]).to.equal(`wild_cookie=${cookie127Val}`);
        urlRequest.followRedirect();
      });
      const response = await getResponse(urlRequest);
      // We expect the server to have received the localhost value here
      // The original request was to a 127.0.0.1 URL
      // That request would have the cookie127Val cookie attached
      // The request is then redirect to a localhost URL (different site)
      // Because we are using the session cookie store it should do the safe / secure thing
      // and attach the cookies for the new target domain
      expect(response.headers['x-cookie']).to.equal(`wild_cookie=${cookieLocalVal}`);
    });

    it('should be able to abort an HTTP request before first write', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.end();
        expect.fail('Unexpected request event');
      });

      const urlRequest = net.request(serverUrl);
      urlRequest.on('response', () => {
        expect.fail('unexpected response event');
      });
      const aborted = emittedOnce(urlRequest, 'abort');
      urlRequest.abort();
      urlRequest.write('');
      urlRequest.end();
      await aborted;
    });

    it('it should be able to abort an HTTP request before request end', async () => {
      let requestReceivedByServer = false;
      let urlRequest: ClientRequest | null = null;
      const serverUrl = await respondOnce.toSingleURL(() => {
        requestReceivedByServer = true;
        urlRequest!.abort();
      });
      let requestAbortEventEmitted = false;

      urlRequest = net.request(serverUrl);
      urlRequest.on('response', () => {
        expect.fail('Unexpected response event');
      });
      urlRequest.on('finish', () => {
        expect.fail('Unexpected finish event');
      });
      urlRequest.on('error', () => {
        expect.fail('Unexpected error event');
      });
      urlRequest.on('abort', () => {
        requestAbortEventEmitted = true;
      });

      await emittedOnce(urlRequest, 'close', () => {
        urlRequest!.chunkedEncoding = true;
        urlRequest!.write(randomString(kOneKiloByte));
      });
      expect(requestReceivedByServer).to.equal(true);
      expect(requestAbortEventEmitted).to.equal(true);
    });

    it('it should be able to abort an HTTP request after request end and before response', async () => {
      let requestReceivedByServer = false;
      let urlRequest: ClientRequest | null = null;
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        requestReceivedByServer = true;
        urlRequest!.abort();
        process.nextTick(() => {
          response.statusCode = 200;
          response.statusMessage = 'OK';
          response.end();
        });
      });
      let requestFinishEventEmitted = false;

      urlRequest = net.request(serverUrl);
      urlRequest.on('response', () => {
        expect.fail('Unexpected response event');
      });
      urlRequest.on('finish', () => {
        requestFinishEventEmitted = true;
      });
      urlRequest.on('error', () => {
        expect.fail('Unexpected error event');
      });
      urlRequest.end(randomString(kOneKiloByte));
      await emittedOnce(urlRequest, 'abort');
      expect(requestFinishEventEmitted).to.equal(true);
      expect(requestReceivedByServer).to.equal(true);
    });

    it('it should be able to abort an HTTP request after response start', async () => {
      let requestReceivedByServer = false;
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        requestReceivedByServer = true;
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.write(randomString(kOneKiloByte));
      });
      let requestFinishEventEmitted = false;
      let requestResponseEventEmitted = false;
      let responseCloseEventEmitted = false;

      const urlRequest = net.request(serverUrl);
      urlRequest.on('response', (response) => {
        requestResponseEventEmitted = true;
        const statusCode = response.statusCode;
        expect(statusCode).to.equal(200);
        response.on('data', () => {});
        response.on('end', () => {
          expect.fail('Unexpected end event');
        });
        response.on('error', () => {
          expect.fail('Unexpected error event');
        });
        response.on('close' as any, () => {
          responseCloseEventEmitted = true;
        });
        urlRequest.abort();
      });
      urlRequest.on('finish', () => {
        requestFinishEventEmitted = true;
      });
      urlRequest.on('error', () => {
        expect.fail('Unexpected error event');
      });
      urlRequest.end(randomString(kOneKiloByte));
      await emittedOnce(urlRequest, 'abort');
      expect(requestFinishEventEmitted).to.be.true('request should emit "finish" event');
      expect(requestReceivedByServer).to.be.true('request should be received by the server');
      expect(requestResponseEventEmitted).to.be.true('"response" event should be emitted');
      expect(responseCloseEventEmitted).to.be.true('response should emit "close" event');
    });

    it('abort event should be emitted at most once', async () => {
      let requestReceivedByServer = false;
      let urlRequest: ClientRequest | null = null;
      const serverUrl = await respondOnce.toSingleURL(() => {
        requestReceivedByServer = true;
        urlRequest!.abort();
        urlRequest!.abort();
      });
      let requestFinishEventEmitted = false;
      let abortsEmitted = 0;

      urlRequest = net.request(serverUrl);
      urlRequest.on('response', () => {
        expect.fail('Unexpected response event');
      });
      urlRequest.on('finish', () => {
        requestFinishEventEmitted = true;
      });
      urlRequest.on('error', () => {
        expect.fail('Unexpected error event');
      });
      urlRequest.on('abort', () => {
        abortsEmitted++;
      });
      urlRequest.end(randomString(kOneKiloByte));
      await emittedOnce(urlRequest, 'abort');
      expect(requestFinishEventEmitted).to.be.true('request should emit "finish" event');
      expect(requestReceivedByServer).to.be.true('request should be received by server');
      expect(abortsEmitted).to.equal(1, 'request should emit exactly 1 "abort" event');
    });

    it('should allow to read response body from non-2xx response', async () => {
      const bodyData = randomString(kOneKiloByte);
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.statusCode = 404;
        response.end(bodyData);
      });

      const urlRequest = net.request(serverUrl);
      const bodyCheckPromise = getResponse(urlRequest).then(r => {
        expect(r.statusCode).to.equal(404);
        return r;
      }).then(collectStreamBody).then(receivedBodyData => {
        expect(receivedBodyData.toString()).to.equal(bodyData);
      });
      const eventHandlers = Promise.all([
        bodyCheckPromise,
        emittedOnce(urlRequest, 'close')
      ]);

      urlRequest.end();

      await eventHandlers;
    });

    describe('webRequest', () => {
      afterEach(() => {
        session.defaultSession.webRequest.onBeforeRequest(null);
      });

      it('Should throw when invalid filters are passed', () => {
        expect(() => {
          session.defaultSession.webRequest.onBeforeRequest(
            { urls: ['*://www.googleapis.com'] },
            (details, callback) => { callback({ cancel: false }); }
          );
        }).to.throw('Invalid url pattern *://www.googleapis.com: Empty path.');

        expect(() => {
          session.defaultSession.webRequest.onBeforeRequest(
            { urls: ['*://www.googleapis.com/', '*://blahblah.dev'] },
            (details, callback) => { callback({ cancel: false }); }
          );
        }).to.throw('Invalid url pattern *://blahblah.dev: Empty path.');
      });

      it('Should not throw when valid filters are passed', () => {
        expect(() => {
          session.defaultSession.webRequest.onBeforeRequest(
            { urls: ['*://www.googleapis.com/'] },
            (details, callback) => { callback({ cancel: false }); }
          );
        }).to.not.throw();
      });

      it('Requests should be intercepted by webRequest module', async () => {
        const requestUrl = '/requestUrl';
        const redirectUrl = '/redirectUrl';
        let requestIsRedirected = false;
        const serverUrl = await respondOnce.toURL(redirectUrl, (request, response) => {
          requestIsRedirected = true;
          response.end();
        });
        let requestIsIntercepted = false;
        session.defaultSession.webRequest.onBeforeRequest(
          (details, callback) => {
            if (details.url === `${serverUrl}${requestUrl}`) {
              requestIsIntercepted = true;
              // Disabled due to false positive in StandardJS
              // eslint-disable-next-line standard/no-callback-literal
              callback({
                redirectURL: `${serverUrl}${redirectUrl}`
              });
            } else {
              callback({
                cancel: false
              });
            }
          });

        const urlRequest = net.request(`${serverUrl}${requestUrl}`);
        const response = await getResponse(urlRequest);

        expect(response.statusCode).to.equal(200);
        await collectStreamBody(response);
        expect(requestIsRedirected).to.be.true('The server should receive a request to the forward URL');
        expect(requestIsIntercepted).to.be.true('The request should be intercepted by the webRequest module');
      });

      it('should to able to create and intercept a request using a custom session object', async () => {
        const requestUrl = '/requestUrl';
        const redirectUrl = '/redirectUrl';
        const customPartitionName = 'custom-partition';
        let requestIsRedirected = false;
        const serverUrl = await respondOnce.toURL(redirectUrl, (request, response) => {
          requestIsRedirected = true;
          response.end();
        });
        session.defaultSession.webRequest.onBeforeRequest(() => {
          expect.fail('Request should not be intercepted by the default session');
        });

        const customSession = session.fromPartition(customPartitionName, { cache: false });
        let requestIsIntercepted = false;
        customSession.webRequest.onBeforeRequest((details, callback) => {
          if (details.url === `${serverUrl}${requestUrl}`) {
            requestIsIntercepted = true;
            // Disabled due to false positive in StandardJS
            // eslint-disable-next-line standard/no-callback-literal
            callback({
              redirectURL: `${serverUrl}${redirectUrl}`
            });
          } else {
            callback({
              cancel: false
            });
          }
        });

        const urlRequest = net.request({
          url: `${serverUrl}${requestUrl}`,
          session: customSession
        });
        const response = await getResponse(urlRequest);
        expect(response.statusCode).to.equal(200);
        await collectStreamBody(response);
        expect(requestIsRedirected).to.be.true('The server should receive a request to the forward URL');
        expect(requestIsIntercepted).to.be.true('The request should be intercepted by the webRequest module');
      });

      it('should to able to create and intercept a request using a custom partition name', async () => {
        const requestUrl = '/requestUrl';
        const redirectUrl = '/redirectUrl';
        const customPartitionName = 'custom-partition';
        let requestIsRedirected = false;
        const serverUrl = await respondOnce.toURL(redirectUrl, (request, response) => {
          requestIsRedirected = true;
          response.end();
        });
        session.defaultSession.webRequest.onBeforeRequest(() => {
          expect.fail('Request should not be intercepted by the default session');
        });

        const customSession = session.fromPartition(customPartitionName, { cache: false });
        let requestIsIntercepted = false;
        customSession.webRequest.onBeforeRequest((details, callback) => {
          if (details.url === `${serverUrl}${requestUrl}`) {
            requestIsIntercepted = true;
            // Disabled due to false positive in StandardJS
            // eslint-disable-next-line standard/no-callback-literal
            callback({
              redirectURL: `${serverUrl}${redirectUrl}`
            });
          } else {
            callback({
              cancel: false
            });
          }
        });

        const urlRequest = net.request({
          url: `${serverUrl}${requestUrl}`,
          partition: customPartitionName
        });
        const response = await getResponse(urlRequest);
        expect(response.statusCode).to.equal(200);
        await collectStreamBody(response);
        expect(requestIsRedirected).to.be.true('The server should receive a request to the forward URL');
        expect(requestIsIntercepted).to.be.true('The request should be intercepted by the webRequest module');
      });
    });

    it('should throw when calling getHeader without a name', () => {
      expect(() => {
        (net.request({ url: 'https://test' }).getHeader as any)();
      }).to.throw(/`name` is required for getHeader\(name\)/);

      expect(() => {
        net.request({ url: 'https://test' }).getHeader(null as any);
      }).to.throw(/`name` is required for getHeader\(name\)/);
    });

    it('should throw when calling removeHeader without a name', () => {
      expect(() => {
        (net.request({ url: 'https://test' }).removeHeader as any)();
      }).to.throw(/`name` is required for removeHeader\(name\)/);

      expect(() => {
        net.request({ url: 'https://test' }).removeHeader(null as any);
      }).to.throw(/`name` is required for removeHeader\(name\)/);
    });

    it('should follow redirect when no redirect handler is provided', async () => {
      const requestUrl = '/302';
      const serverUrl = await respondOnce.toRoutes({
        '/302': (request, response) => {
          response.statusCode = 302;
          response.setHeader('Location', '/200');
          response.end();
        },
        '/200': (request, response) => {
          response.statusCode = 200;
          response.end();
        }
      });
      const urlRequest = net.request({
        url: `${serverUrl}${requestUrl}`
      });
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
    });

    it('should follow redirect chain when no redirect handler is provided', async () => {
      const serverUrl = await respondOnce.toRoutes({
        '/redirectChain': (request, response) => {
          response.statusCode = 302;
          response.setHeader('Location', '/302');
          response.end();
        },
        '/302': (request, response) => {
          response.statusCode = 302;
          response.setHeader('Location', '/200');
          response.end();
        },
        '/200': (request, response) => {
          response.statusCode = 200;
          response.end();
        }
      });
      const urlRequest = net.request({
        url: `${serverUrl}/redirectChain`
      });
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
    });

    it('should not follow redirect when request is canceled in redirect handler', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.statusCode = 302;
        response.setHeader('Location', '/200');
        response.end();
      });
      const urlRequest = net.request({
        url: serverUrl
      });
      urlRequest.end();
      urlRequest.on('redirect', () => { urlRequest.abort(); });
      urlRequest.on('error', () => {});
      await emittedOnce(urlRequest, 'abort');
    });

    it('should not follow redirect when mode is error', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.statusCode = 302;
        response.setHeader('Location', '/200');
        response.end();
      });
      const urlRequest = net.request({
        url: serverUrl,
        redirect: 'error'
      });
      urlRequest.end();
      await emittedOnce(urlRequest, 'error');
    });

    it('should follow redirect when handler calls callback', async () => {
      const serverUrl = await respondOnce.toRoutes({
        '/redirectChain': (request, response) => {
          response.statusCode = 302;
          response.setHeader('Location', '/302');
          response.end();
        },
        '/302': (request, response) => {
          response.statusCode = 302;
          response.setHeader('Location', '/200');
          response.end();
        },
        '/200': (request, response) => {
          response.statusCode = 200;
          response.end();
        }
      });
      const urlRequest = net.request({ url: `${serverUrl}/redirectChain`, redirect: 'manual' });
      const redirects: string[] = [];
      urlRequest.on('redirect', (status, method, url) => {
        redirects.push(url);
        urlRequest.followRedirect();
      });
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      expect(redirects).to.deep.equal([
        `${serverUrl}/302`,
        `${serverUrl}/200`
      ]);
    });

    it('should throw if given an invalid session option', () => {
      expect(() => {
        net.request({
          url: 'https://foo',
          session: 1 as any
        });
      }).to.throw('`session` should be an instance of the Session class');
    });

    it('should throw if given an invalid partition option', () => {
      expect(() => {
        net.request({
          url: 'https://foo',
          partition: 1 as any
        });
      }).to.throw('`partition` should be a string');
    });

    it('should be able to create a request with options', async () => {
      const customHeaderName = 'Some-Custom-Header-Name';
      const customHeaderValue = 'Some-Customer-Header-Value';
      const serverUrlUnparsed = await respondOnce.toURL('/', (request, response) => {
        expect(request.method).to.equal('GET');
        expect(request.headers[customHeaderName.toLowerCase()]).to.equal(customHeaderValue);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.end();
      });
      const serverUrl = url.parse(serverUrlUnparsed);
      const options = {
        port: serverUrl.port ? parseInt(serverUrl.port, 10) : undefined,
        hostname: '127.0.0.1',
        headers: { [customHeaderName]: customHeaderValue }
      };
      const urlRequest = net.request(options);
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.be.equal(200);
      await collectStreamBody(response);
    });

    it('should be able to pipe a readable stream into a net request', async () => {
      const bodyData = randomString(kOneMegaByte);
      let netRequestReceived = false;
      let netRequestEnded = false;

      const [nodeServerUrl, netServerUrl] = await Promise.all([
        respondOnce.toSingleURL((request, response) => response.end(bodyData)),
        respondOnce.toSingleURL((request, response) => {
          netRequestReceived = true;
          let receivedBodyData = '';
          request.on('data', (chunk) => {
            receivedBodyData += chunk.toString();
          });
          request.on('end', (chunk: Buffer | undefined) => {
            netRequestEnded = true;
            if (chunk) {
              receivedBodyData += chunk.toString();
            }
            expect(receivedBodyData).to.be.equal(bodyData);
            response.end();
          });
        })
      ]);
      const nodeRequest = http.request(nodeServerUrl);
      const nodeResponse = await getResponse(nodeRequest as any) as any as http.ServerResponse;
      const netRequest = net.request(netServerUrl);
      const responsePromise = emittedOnce(netRequest, 'response');
      // TODO(@MarshallOfSound) - FIXME with #22730
      nodeResponse.pipe(netRequest as any);
      const [netResponse] = await responsePromise;
      expect(netResponse.statusCode).to.equal(200);
      await collectStreamBody(netResponse);
      expect(netRequestReceived).to.be.true('net request received');
      expect(netRequestEnded).to.be.true('net request ended');
    });

    it('should report upload progress', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.end();
      });
      const netRequest = net.request({ url: serverUrl, method: 'POST' });
      expect(netRequest.getUploadProgress()).to.have.property('active', false);
      netRequest.end(Buffer.from('hello'));
      const [position, total] = await emittedOnce(netRequest, 'upload-progress');
      expect(netRequest.getUploadProgress()).to.deep.equal({ active: true, started: true, current: position, total });
    });

    it('should emit error event on server socket destroy', async () => {
      const serverUrl = await respondOnce.toSingleURL((request) => {
        request.socket.destroy();
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.end();
      const [error] = await emittedOnce(urlRequest, 'error');
      expect(error.message).to.equal('net::ERR_EMPTY_RESPONSE');
    });

    it('should emit error event on server request destroy', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        request.destroy();
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.end(randomBuffer(kOneMegaByte));
      const [error] = await emittedOnce(urlRequest, 'error');
      expect(error.message).to.be.oneOf(['net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_ABORTED']);
    });

    it('should not emit any event after close', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.end();
      });

      const urlRequest = net.request(serverUrl);
      urlRequest.end();

      await emittedOnce(urlRequest, 'close');
      await new Promise((resolve, reject) => {
        ['finish', 'abort', 'close', 'error'].forEach(evName => {
          urlRequest.on(evName as any, () => {
            reject(new Error(`Unexpected ${evName} event`));
          });
        });
        setTimeout(resolve, 50);
      });
    });

    it('should remove the referer header when no referrer url specified', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        expect(request.headers.referer).to.equal(undefined);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.end();

      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      await collectStreamBody(response);
    });

    it('should set the referer header when a referrer url specified', async () => {
      const referrerURL = 'https://www.electronjs.org/';
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        expect(request.headers.referer).to.equal(referrerURL);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.setHeader('referer', referrerURL);
      urlRequest.end();

      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      await collectStreamBody(response);
    });
  });

  describe('IncomingMessage API', () => {
    it('response object should implement the IncomingMessage API', async () => {
      const customHeaderName = 'Some-Custom-Header-Name';
      const customHeaderValue = 'Some-Customer-Header-Value';

      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.setHeader(customHeaderName, customHeaderValue);
        response.end();
      });

      const urlRequest = net.request(serverUrl);
      const response = await getResponse(urlRequest);

      expect(response.statusCode).to.equal(200);
      expect(response.statusMessage).to.equal('OK');

      const headers = response.headers;
      expect(headers).to.be.an('object');
      const headerValue = headers[customHeaderName.toLowerCase()];
      expect(headerValue).to.equal(customHeaderValue);

      const httpVersion = response.httpVersion;
      expect(httpVersion).to.be.a('string').and.to.have.lengthOf.at.least(1);

      const httpVersionMajor = response.httpVersionMajor;
      expect(httpVersionMajor).to.be.a('number').and.to.be.at.least(1);

      const httpVersionMinor = response.httpVersionMinor;
      expect(httpVersionMinor).to.be.a('number').and.to.be.at.least(0);

      await collectStreamBody(response);
    });

    it('should discard duplicate headers', async () => {
      const includedHeader = 'max-forwards';
      const discardableHeader = 'Max-Forwards';

      const includedHeaderValue = 'max-fwds-val';
      const discardableHeaderValue = 'max-fwds-val-two';

      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.setHeader(discardableHeader, discardableHeaderValue);
        response.setHeader(includedHeader, includedHeaderValue);
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      expect(response.statusMessage).to.equal('OK');

      const headers = response.headers;
      expect(headers).to.be.an('object');

      expect(headers).to.have.property(includedHeader);
      expect(headers).to.not.have.property(discardableHeader);
      expect(headers[includedHeader]).to.equal(includedHeaderValue);

      await collectStreamBody(response);
    });

    it('should join repeated non-discardable value with ,', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.setHeader('referrer-policy', ['first-text', 'second-text']);
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      const response = await getResponse(urlRequest);
      expect(response.statusCode).to.equal(200);
      expect(response.statusMessage).to.equal('OK');

      const headers = response.headers;
      expect(headers).to.be.an('object');
      expect(headers).to.have.property('referrer-policy');
      expect(headers['referrer-policy']).to.equal('first-text, second-text');

      await collectStreamBody(response);
    });

    it('should be able to pipe a net response into a writable stream', async () => {
      const bodyData = randomString(kOneKiloByte);
      let nodeRequestProcessed = false;
      const [netServerUrl, nodeServerUrl] = await Promise.all([
        respondOnce.toSingleURL((request, response) => response.end(bodyData)),
        respondOnce.toSingleURL(async (request, response) => {
          const receivedBodyData = await collectStreamBody(request);
          expect(receivedBodyData).to.be.equal(bodyData);
          nodeRequestProcessed = true;
          response.end();
        })
      ]);
      const netRequest = net.request(netServerUrl);
      const netResponse = await getResponse(netRequest);
      const serverUrl = url.parse(nodeServerUrl);
      const nodeOptions = {
        method: 'POST',
        path: serverUrl.path,
        port: serverUrl.port
      };
      const nodeRequest = http.request(nodeOptions);
      const nodeResponsePromise = emittedOnce(nodeRequest, 'response');
      // TODO(@MarshallOfSound) - FIXME with #22730
      (netResponse as any).pipe(nodeRequest);
      const [nodeResponse] = await nodeResponsePromise;
      netRequest.end();
      await collectStreamBody(nodeResponse);
      expect(nodeRequestProcessed).to.equal(true);
    });

    it('should correctly throttle an incoming stream', async () => {
      let numChunksSent = 0;
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        const data = randomString(kOneMegaByte);
        const write = () => {
          let ok = true;
          do {
            numChunksSent++;
            if (numChunksSent > 30) return;
            ok = response.write(data);
          } while (ok);
          response.once('drain', write);
        };
        write();
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.on('response', () => {});
      urlRequest.end();
      await delay(2000);
      expect(numChunksSent).to.be.at.most(20);
    });
  });

  describe('Stability and performance', () => {
    it('should free unreferenced, never-started request objects without crash', (done) => {
      net.request('https://test');
      process.nextTick(() => {
        const v8Util = process._linkedBinding('electron_common_v8_util');
        v8Util.requestGarbageCollectionForTesting();
        done();
      });
    });

    it('should collect on-going requests without crash', async () => {
      let finishResponse: (() => void) | null = null;
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.write(randomString(kOneKiloByte));
        finishResponse = () => {
          response.write(randomString(kOneKiloByte));
          response.end();
        };
      });
      const urlRequest = net.request(serverUrl);
      const response = await getResponse(urlRequest);
      process.nextTick(() => {
        // Trigger a garbage collection.
        const v8Util = process._linkedBinding('electron_common_v8_util');
        v8Util.requestGarbageCollectionForTesting();
        finishResponse!();
      });
      await collectStreamBody(response);
    });

    it('should collect unreferenced, ended requests without crash', async () => {
      const serverUrl = await respondOnce.toSingleURL((request, response) => {
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      process.nextTick(() => {
        const v8Util = process._linkedBinding('electron_common_v8_util');
        v8Util.requestGarbageCollectionForTesting();
      });
      const response = await getResponse(urlRequest);
      await collectStreamBody(response);
    });

    it('should finish sending data when urlRequest is unreferenced', async () => {
      const serverUrl = await respondOnce.toSingleURL(async (request, response) => {
        const received = await collectStreamBodyBuffer(request);
        expect(received.length).to.equal(kOneMegaByte);
        response.end();
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.on('close', () => {
        process.nextTick(() => {
          const v8Util = process._linkedBinding('electron_common_v8_util');
          v8Util.requestGarbageCollectionForTesting();
        });
      });
      urlRequest.write(randomBuffer(kOneMegaByte));
      const response = await getResponse(urlRequest);
      await collectStreamBody(response);
    });

    it('should finish sending data when urlRequest is unreferenced for chunked encoding', async () => {
      const serverUrl = await respondOnce.toSingleURL(async (request, response) => {
        const received = await collectStreamBodyBuffer(request);
        response.end();
        expect(received.length).to.equal(kOneMegaByte);
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.chunkedEncoding = true;
      urlRequest.write(randomBuffer(kOneMegaByte));
      const response = await getResponse(urlRequest);
      await collectStreamBody(response);
      process.nextTick(() => {
        const v8Util = process._linkedBinding('electron_common_v8_util');
        v8Util.requestGarbageCollectionForTesting();
      });
    });

    it('should finish sending data when urlRequest is unreferenced before close event for chunked encoding', async () => {
      const serverUrl = await respondOnce.toSingleURL(async (request, response) => {
        const received = await collectStreamBodyBuffer(request);
        response.end();
        expect(received.length).to.equal(kOneMegaByte);
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.chunkedEncoding = true;
      urlRequest.write(randomBuffer(kOneMegaByte));
      const v8Util = process._linkedBinding('electron_common_v8_util');
      v8Util.requestGarbageCollectionForTesting();
      await collectStreamBody(await getResponse(urlRequest));
    });

    it('should finish sending data when urlRequest is unreferenced', async () => {
      const serverUrl = await respondOnce.toSingleURL(async (request, response) => {
        const received = await collectStreamBodyBuffer(request);
        response.end();
        expect(received.length).to.equal(kOneMegaByte);
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.on('close', () => {
        process.nextTick(() => {
          const v8Util = process._linkedBinding('electron_common_v8_util');
          v8Util.requestGarbageCollectionForTesting();
        });
      });
      urlRequest.write(randomBuffer(kOneMegaByte));
      await collectStreamBody(await getResponse(urlRequest));
    });

    it('should finish sending data when urlRequest is unreferenced for chunked encoding', async () => {
      const serverUrl = await respondOnce.toSingleURL(async (request, response) => {
        const received = await collectStreamBodyBuffer(request);
        response.end();
        expect(received.length).to.equal(kOneMegaByte);
      });
      const urlRequest = net.request(serverUrl);
      urlRequest.on('close', () => {
        process.nextTick(() => {
          const v8Util = process._linkedBinding('electron_common_v8_util');
          v8Util.requestGarbageCollectionForTesting();
        });
      });
      urlRequest.chunkedEncoding = true;
      urlRequest.write(randomBuffer(kOneMegaByte));
      await collectStreamBody(await getResponse(urlRequest));
    });
  });
});
