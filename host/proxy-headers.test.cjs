const test=require('node:test');const assert=require('node:assert/strict');
const {trustedClientIp,normalizeProxyHeaders}=require('./proxy-headers.cjs');
test('direct ngrok traffic ignores spoofed Vercel and earlier forwarded headers',()=>{
 assert.equal(trustedClientIp({'x-vercel-forwarded-for':'203.0.113.1','x-forwarded-for':'203.0.113.2, 198.51.100.3'},'127.0.0.1','secret'),'198.51.100.3');
});
test('only the trusted Vercel forwarding key can carry the original client IP',()=>{
 const headers={'x-svis-proxy-secret':'secret','x-svis-client-ip':'203.0.113.4','x-forwarded-for':'198.51.100.3'};
 assert.equal(trustedClientIp(headers,'127.0.0.1','secret'),'203.0.113.4');
 assert.equal(trustedClientIp({...headers,'x-svis-proxy-secret':'wrong'},'127.0.0.1','secret'),'198.51.100.3');
});
test('normalization removes the origin credential before calling API handlers',()=>{
 const req={headers:{'x-svis-proxy-secret':'secret','x-svis-client-ip':'203.0.113.4'},socket:{remoteAddress:'127.0.0.1'}};
 normalizeProxyHeaders(req,'secret');assert.equal(req.headers['x-vercel-forwarded-for'],'203.0.113.4');assert.equal(req.headers['x-svis-proxy-secret'],undefined);
});
test('direct LAN and internet callers cannot spoof their address with forwarding headers',()=>{
 const headers={'x-svis-proxy-secret':'secret','x-svis-client-ip':'203.0.113.4','x-vercel-forwarded-for':'203.0.113.5','x-forwarded-for':'198.51.100.3'};
 for(const peer of ['172.24.8.55','198.51.100.22','::ffff:172.24.8.55'])assert.equal(trustedClientIp(headers,peer,'secret'),peer);
});
