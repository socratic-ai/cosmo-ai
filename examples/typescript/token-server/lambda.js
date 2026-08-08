/** AWS Lambda adapter (Function URL, payload v2). Handler: `lambda.handler`. */

import webHandler from './handler.js';

export async function handler(event) {
  const { method } = event.requestContext.http;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;
  const body =
    event.body === undefined
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : event.body;
  const request = new Request(url, { method, headers: event.headers ?? {}, body });
  const response = await webHandler.fetch(request, process.env);
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}
