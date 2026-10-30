/** Relay an HTTP response while closing both sides when the source ends abnormally or the client cancels. */
export function pipeHttpProxyResponse(source, downstream, request) {
  const failDownstream = () => {
    if (downstream.destroyed || downstream.writableEnded) return;
    if (!downstream.headersSent) { downstream.writeHead(502); downstream.end(); }
    else downstream.destroy();
  };
  const closeSource = () => {
    if (!request.destroyed) request.destroy();
    if (!source.destroyed) source.destroy();
  };

  source.once('aborted', failDownstream);
  source.once('error', failDownstream);
  source.once('close', () => { if (!source.complete) failDownstream(); });
  downstream.once('close', () => { if (!downstream.writableEnded) closeSource(); });
  downstream.writeHead(source.statusCode, source.headers);
  source.pipe(downstream);
}
